#!/usr/bin/env node

import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logScraperResult } from './scraper-log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Check if an npm package exists
 */
async function checkNpmPackageExists(packageName) {
    try {
        const response = await fetch(`https://registry.npmjs.org/${packageName}`);
        return response.status === 200;
    } catch (error) {
        return false;
    }
}

// Configuration
const MCPSERVERS_URLS = [
    'https://mcpservers.org/remote-mcp-servers',
    'https://mcpservers.org'
];
const CACHE_FILE = path.join(__dirname, '../../data/mcpservers-cache.json');

/**
 * Load cached entries to avoid re-processing
 */
async function loadCache() {
    try {
        const cacheDir = path.dirname(CACHE_FILE);
        await fs.mkdir(cacheDir, { recursive: true });
        
        const data = await fs.readFile(CACHE_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { processedServers: [], lastRun: null };
        }
        throw error;
    }
}

/**
 * Save cache with processed entries
 */
async function saveCache(cache) {
    const cacheDir = path.dirname(CACHE_FILE);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

/**
 * Validate if the extracted entry looks like a real MCP server candidate
 */
function isValidMcpCandidate(name, url) {
    // Skip generic/invalid names
    const invalidNames = ['packages', 'npm', 'github', 'api', 'server', 'search', 'javascript', 'js', 'node', 'mcp', 'install'];
    if (invalidNames.includes(name.toLowerCase())) {
        return false;
    }
    
    // Must have reasonable length
    if (name.length < 3 || name.length > 100) {
        return false;
    }
    
    // NPM packages should have reasonable naming
    if (!url.includes('://') && !url.includes('/')) {
        // It's likely a package name
        if (!/^(@[\w\-]+\/)?[\w\-]+$/.test(url)) {
            return false;
        }
    }
    
    // Skip invalid paths like "/mcp" or "/server"
    if (url.startsWith('/') || url === 'mcp' || url === 'server') {
        return false;
    }
    
    // Only accept GitHub repos, npm packages, or specific MCP server URLs
    if (url.includes('://') && !url.includes('github.com') && !url.includes('npmjs.com')) {
        // Skip generic HTTP URLs unless they're clearly MCP servers
        if (!url.includes('mcp-server') && !url.includes('model-context-protocol')) {
            return false;
        }
    }
    
    return true;
}

/**
 * Parse HTML content to extract MCP server information
 */
function parseHtmlContent(html, sourceUrl) {
    const servers = [];
    
    // Look for various patterns that might indicate MCP servers
    const patterns = [
        // GitHub repository links
        {
            regex: /github\.com\/([^\/\s"']+\/[^\/\s"']+)/g,
            type: 'github',
            confidence: 0.7
        },
        // NPM package references (more specific patterns)
        {
            regex: /@[\w\-]+\/[\w\-]+|mcp-[\w\-]+|[\w\-]+-mcp/g,
            type: 'npm',
            confidence: 0.6
        },
        // HTTP/HTTPS URLs that might be MCP servers
        {
            regex: /https?:\/\/[^\s<>"']+(?:mcp|server|api)[^\s<>"']*/g,
            type: 'http',
            confidence: 0.5
        }
    ];
    
    // Extract text content from HTML for better parsing
    const textContent = html
        .replace(/<script[^>]*>.*?<\/script>/gs, '')
        .replace(/<style[^>]*>.*?<\/style>/gs, '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ');
    
    for (const pattern of patterns) {
        const matches = textContent.matchAll(pattern.regex);
        
        for (const match of matches) {
            let url = match[0];
            let name = '';
            
            if (pattern.type === 'github') {
                url = `https://github.com/${match[1]}`;
                // Use full GitHub path as identifier
                name = match[1];
            } else if (pattern.type === 'npm') {
                url = match[1] || match[0];
                name = url;
            } else {
                name = new URL(url).hostname;
            }
            
            // Extract surrounding context for description
            const index = html.indexOf(match[0]);
            const contextStart = Math.max(0, index - 200);
            const contextEnd = Math.min(html.length, index + 200);
            const context = html.slice(contextStart, contextEnd)
                .replace(/<[^>]*>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            
            // Validate before adding
            if (isValidMcpCandidate(name, url)) {
                servers.push({
                    name,
                    url,
                    type: pattern.type,
                    description: context.length > 50 ? context.slice(0, 200) + '...' : context,
                    source: sourceUrl,
                    confidence: pattern.confidence
                });
            }
        }
    }
    
    // Remove duplicates based on URL
    const uniqueServers = [];
    const seenUrls = new Set();
    
    for (const server of servers) {
        if (!seenUrls.has(server.url)) {
            seenUrls.add(server.url);
            uniqueServers.push(server);
        }
    }
    
    return uniqueServers;
}

/**
 * Fetch and parse mcpservers.org content
 */
async function scrapeUrl(url) {
    console.log(`📡 Fetching content from ${url}`);
    
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'MCPfinder-Scraper/1.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
        }
        
        const html = await response.text();
        const servers = parseHtmlContent(html, url);
        
        console.log(`   Found ${servers.length} potential MCP servers`);
        return servers;
        
    } catch (error) {
        console.error(`❌ Failed to scrape ${url}:`, error.message);
        return [];
    }
}

/**
 * Register MCP server using the CLI
 */
async function registerMcpServer(serverInfo) {
    try {
        console.log(`📦 Attempting to register: ${serverInfo.name} (${serverInfo.url})`);
        
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        
        // Build command with parameters
        let cmd = `node index.js register "${serverInfo.url}" --headless`;
        
        // Add description if available
        if (serverInfo.description && serverInfo.description.length > 10) {
            // Clean HTML and escape for shell
            const cleanDesc = serverInfo.description
                .replace(/<[^>]*>/g, '') // Remove HTML tags
                .replace(/\s+/g, ' ') // Normalize whitespace
                .trim()
                .substring(0, 200); // Limit length
            cmd += ` --description "${cleanDesc.replace(/"/g, '\\"').replace(/'/g, "\\'").replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
        }
        
        // Add tags
        cmd += ` --tags "auto-discovered,mcpservers-org"`;
        
        // Execute registration command and capture output
        const result = await execAsync(cmd, { 
            cwd: path.join(__dirname, '../..')
        });
        
        // Check if the output contains success indicators
        const output = result.stdout + result.stderr;
        if (output.includes('Cannot connect to MCP server') || 
            output.includes('Connection closed') ||
            output.includes('Failed to connect')) {
            console.log(`⚠️  Skipping ${serverInfo.name} - server not accessible`);
            await logScraperResult(serverInfo.url, 'failed', 'mcpservers-org');
            return false;
        }
        
        if (output.includes('Successfully registered') || 
            output.includes('Operation: created')) {
            console.log(`✅ Successfully registered: ${serverInfo.name}`);
            await logScraperResult(serverInfo.url, 'registered', 'mcpservers-org');
            return true;
        }
        
        if (output.includes('Operation: updated')) {
            console.log(`✅ Updated existing server: ${serverInfo.name}`);
            await logScraperResult(serverInfo.url, 'updated', 'mcpservers-org');
            return true;
        }
        
        // If we can't determine success/failure, assume failure
        console.log(`❓ Unknown registration result for ${serverInfo.name}`);
        await logScraperResult(serverInfo.url, 'failed', 'mcpservers-org');
        return false;
        
    } catch (error) {
        console.error(`❌ Failed to register ${serverInfo.name}:`, error.message);
        await logScraperResult(serverInfo.url, 'failed', 'mcpservers-org');
        return false;
    }
}

/**
 * Main mcpservers.org scraper function
 */
export async function scrapeMcpServersOrg() {
    console.log('🔍 Scraping mcpservers.org for MCP servers...');
    
    try {
        // Load cache
        const cache = await loadCache();
        
        let allServers = [];
        let newCount = 0;
        let successCount = 0;
        
        for (const url of MCPSERVERS_URLS) {
            console.log(`\n🌐 Processing: ${url}`);
            
            const servers = await scrapeUrl(url);
            allServers.push(...servers);
            
            // Process new servers
            for (const server of servers) {
                const serverKey = `${server.source}:${server.url}`;
                
                // Skip if already processed
                if (cache.processedServers.includes(serverKey)) {
                    continue;
                }
                
                newCount++;
                console.log(`\n🆕 New server found: ${server.name}`);
                console.log(`   URL: ${server.url} (${server.type}, confidence: ${server.confidence})`);
                console.log(`   Description: ${server.description.slice(0, 100)}...`);
                
                // Skip GitHub repos - we only want servers installable via npx or SSE
                if (server.type === 'github' || server.url.includes('github.com')) {
                    console.log(`   ⚠️  Skipping GitHub repo - requires manual installation`);
                    cache.processedServers.push(serverKey);
                    await logScraperResult(server.url, 'skipped-github', 'mcpservers-org');
                } else if (server.type === 'npm') {
                    // Check if npm package actually exists
                    console.log(`   Checking npm for ${server.url}...`);
                    const exists = await checkNpmPackageExists(server.url);
                    if (!exists) {
                        console.log(`   ✗ Package not found on npm, skipping`);
                        cache.processedServers.push(serverKey);
                        await logScraperResult(server.url, 'skipped', 'mcpservers-org');
                    } else if (server.confidence >= 0.6) {
                        console.log(`   ✓ Found on npm`);
                        const success = await registerMcpServer(server);
                        if (success) {
                            successCount++;
                        }
                        
                        // Rate limiting between registrations
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                } else if (server.confidence >= 0.6) {
                    // Process HTTP/SSE servers
                    const success = await registerMcpServer(server);
                    if (success) {
                        successCount++;
                    }
                    
                    // Rate limiting between registrations
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } else {
                    // Skip low-confidence entries
                    await logScraperResult(server.url, 'skipped', 'mcpservers-org');
                }
                
                // Mark as processed regardless of success
                cache.processedServers.push(serverKey);
            }
            
            // Rate limiting between URLs
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Update cache
        cache.lastRun = new Date().toISOString();
        await saveCache(cache);
        
        console.log(`\n📊 mcpservers.org scraping complete:`);
        console.log(`   Total servers found: ${allServers.length}`);
        console.log(`   New servers: ${newCount}`);
        console.log(`   Successfully registered: ${successCount}`);
        
        return {
            totalServers: allServers.length,
            newServers: newCount,
            successfulRegistrations: successCount
        };
        
    } catch (error) {
        console.error('❌ mcpservers.org scraping failed:', error);
        throw error;
    }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    scrapeMcpServersOrg()
        .then((results) => {
            console.log('\n✅ mcpservers.org scraping completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ mcpservers.org scraping failed:', error);
            process.exit(1);
        });
}