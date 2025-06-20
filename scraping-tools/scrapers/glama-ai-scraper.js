#!/usr/bin/env node

import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logScraperResult } from './scraper-log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const GLAMA_API_URL = 'https://glama.ai/mcp/servers';
const GLAMA_API_PARAMS = '?sort=added-at%3Adesc';
const CACHE_FILE = path.join(__dirname, '../../data/glama-cache.json');

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

/**
 * Convert @user/repo format to GitHub URL if it's not an npm package
 */
async function resolvePackageOrGitHub(packageName, html) {
    // First check if it's a real npm package
    if (packageName.startsWith('@')) {
        console.log(`   Checking npm for ${packageName}...`);
        const exists = await checkNpmPackageExists(packageName);
        if (exists) {
            console.log(`   ✓ Found on npm: ${packageName}`);
            return { url: packageName, type: 'npm' };
        }
        
        console.log(`   ✗ Not found on npm, checking for GitHub...`);
        // Not an npm package, it's likely a GitHub repo with @ prefix on glama
        const githubPattern = packageName.replace('@', '');
        console.log(`   ✓ Treating as GitHub repo: https://github.com/${githubPattern}`);
        return { url: `https://github.com/${githubPattern}`, type: 'github' };
    }
    
    // Default: assume it's what it appears to be
    console.log(`   ⚠ No GitHub URL found, defaulting to npm: ${packageName}`);
    return { url: packageName, type: 'npm' };
}

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
            return { 
                processedServers: [], 
                failedServers: [], // Track servers that failed to connect
                lastRun: null 
            };
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
 * Parse HTML to extract MCP server data
 */
async function parseGlamaContent(html) {
    const servers = [];
    
    // Try to extract JSON data from script tags (common in SPAs)
    const scriptRegex = /<script[^>]*>(.*?)<\/script>/gs;
    const scriptMatches = html.matchAll(scriptRegex);
    
    for (const match of scriptMatches) {
        const scriptContent = match[1];
        
        // Look for JSON objects that might contain server data
        try {
            // Common patterns for embedded data
            const jsonPatterns = [
                /window\.__INITIAL_STATE__\s*=\s*({.*?});/s,
                /window\.__DATA__\s*=\s*({.*?});/s,
                /__NEXT_DATA__['"]\s*type=['"']application\/json['"]\s*>([^<]+)</s,
                /{"servers":\s*\[(.*?)\]/s
            ];
            
            for (const pattern of jsonPatterns) {
                const jsonMatch = scriptContent.match(pattern);
                if (jsonMatch) {
                    try {
                        const data = JSON.parse(jsonMatch[1]);
                        if (data.servers || data.data?.servers) {
                            const serverList = data.servers || data.data.servers;
                            return parseServerList(serverList);
                        }
                    } catch (e) {
                        // Continue to next pattern
                    }
                }
            }
        } catch (e) {
            // Continue to next script tag
        }
    }
    
    // Fallback: parse HTML structure for server cards/items
    return await parseHtmlStructure(html);
}

/**
 * Parse server list from JSON data
 */
function parseServerList(servers) {
    const mcpServers = [];
    
    for (const server of servers) {
        if (typeof server === 'object' && server.name) {
            mcpServers.push({
                name: server.name,
                url: server.url || server.repository || server.package || server.name,
                description: server.description || server.summary || '',
                type: determineServerType(server.url || server.repository || server.package || server.name),
                tags: server.tags || [],
                author: server.author || server.maintainer || '',
                addedAt: server.addedAt || server.created_at || new Date().toISOString(),
                source: 'glama.ai',
                confidence: 0.9
            });
        }
    }
    
    return mcpServers;
}

/**
 * Parse HTML structure for server information
 */
async function parseHtmlStructure(html) {
    const servers = [];
    
    // Look for glama.ai server page URLs which might be GitHub repos formatted as @user/repo
    const serverPageRegex = /\/mcp\/servers\/([@]?[\w\-]+\/[\w\-\.]+)/g;
    const serverMatches = html.matchAll(serverPageRegex);
    
    // Process all matches and resolve them
    for (const match of serverMatches) {
        const serverPath = match[1];
        // Skip invalid entries like categories/*, feeds/*, _index/_route
        if (serverPath && !serverPath.includes('\\') && 
            !serverPath.startsWith('categories/') && 
            !serverPath.startsWith('feeds/') &&
            !serverPath.includes('_index') &&
            !serverPath.includes('_route')) {
            // Resolve whether it's npm or GitHub
            const resolved = await resolvePackageOrGitHub(serverPath, html);
            
            servers.push({
                name: serverPath.replace('@', ''),
                url: resolved.url,
                description: `MCP server: ${serverPath}`,
                type: resolved.type,
                source: 'glama.ai',
                confidence: resolved.type === 'npm' ? 0.9 : 0.8
            });
        }
    }
    
    // Also look for GitHub links
    const patterns = [
        // GitHub links (must be full repo paths)
        /href=["']([^"']*github\.com\/[^"'\/]+\/[^"'\/]+)(?:\/|["'])/g
    ];
    
    for (const pattern of patterns) {
        const matches = html.matchAll(pattern);
        
        for (const match of matches) {
            const url = match[1];
            const name = extractNameFromUrl(url);
            
            if (name && url && !url.includes('/mcp') && !url.endsWith('/server')) {
                // Skip invalid URLs like "/mcp" or generic paths
                if (url.startsWith('http') && !url.includes('github.com') && !url.includes('npmjs.com')) {
                    continue; // Skip non-package URLs
                }
                servers.push({
                    name,
                    url,
                    description: `MCP server from glama.ai: ${name}`,
                    type: determineServerType(url),
                    source: 'glama.ai',
                    confidence: 0.7
                });
            }
        }
    }
    
    // Remove duplicates
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
 * Determine server type from URL
 */
function determineServerType(url) {
    if (url.includes('github.com')) {
        return 'github';
    } else if (url.includes('npmjs.com') || url.includes('npm.im') || !url.includes('://')) {
        return 'npm';
    } else if (url.startsWith('http')) {
        return 'http';
    }
    return 'unknown';
}

/**
 * Extract name from URL
 */
function extractNameFromUrl(url) {
    if (url.includes('github.com')) {
        const parts = url.split('/');
        const repo = parts[parts.length - 1] || parts[parts.length - 2];
        const owner = parts[parts.length - 2] || parts[parts.length - 3];
        // Return GitHub URL format, not just repo name
        return `${owner}/${repo}`;
    } else if (url.includes('npmjs.com')) {
        const match = url.match(/npmjs\.com\/package\/([^\/]+)/);
        return match ? match[1] : null;
    } else if (!url.includes('://')) {
        // It's already a package name
        return url;
    }
    // For other URLs, skip them as they're not valid package sources
    return null;
}

/**
 * Fetch Glama.ai content with multiple strategies
 */
async function fetchGlamaContent() {
    const strategies = [
        // Strategy 1: Direct fetch
        async () => {
            const response = await fetch(GLAMA_API_URL + GLAMA_API_PARAMS, {
                headers: {
                    'User-Agent': 'MCPfinder-Scraper/1.0',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                }
            });
            return response;
        },
        
        // Strategy 2: Try base URL
        async () => {
            const response = await fetch(GLAMA_API_URL, {
                headers: {
                    'User-Agent': 'MCPfinder-Scraper/1.0',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                }
            });
            return response;
        },
        
        // Strategy 3: Try API endpoint if exists
        async () => {
            const apiUrl = GLAMA_API_URL.replace('/servers', '/api/servers');
            const response = await fetch(apiUrl, {
                headers: {
                    'User-Agent': 'MCPfinder-Scraper/1.0',
                    'Accept': 'application/json'
                }
            });
            return response;
        }
    ];
    
    for (let i = 0; i < strategies.length; i++) {
        try {
            console.log(`   Trying strategy ${i + 1}...`);
            const response = await strategies[i]();
            
            if (response.ok) {
                const content = await response.text();
                console.log(`   Success with strategy ${i + 1}`);
                return content;
            }
        } catch (error) {
            console.log(`   Strategy ${i + 1} failed: ${error.message}`);
        }
    }
    
    throw new Error('All fetch strategies failed');
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
            cmd += ` --description "${serverInfo.description.replace(/"/g, '\"')}"`;
        }
        
        // Add tags
        let tags = 'auto-discovered,glama-ai';
        if (serverInfo.tags && Array.isArray(serverInfo.tags)) {
            tags += ',' + serverInfo.tags.join(',');
        }
        cmd += ` --tags "${tags}"`;
        
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
            await logScraperResult(serverInfo.url, 'failed', 'glama-ai');
            return false;
        }
        
        if (output.includes('Successfully registered') || 
            output.includes('Operation: created')) {
            console.log(`✅ Successfully registered: ${serverInfo.name}`);
            await logScraperResult(serverInfo.url, 'registered', 'glama-ai');
            return true;
        }
        
        if (output.includes('Operation: updated')) {
            console.log(`✅ Updated existing server: ${serverInfo.name}`);
            await logScraperResult(serverInfo.url, 'updated', 'glama-ai');
            return true;
        }
        
        // If we can't determine success/failure, assume failure
        console.log(`❓ Unknown registration result for ${serverInfo.name}`);
        await logScraperResult(serverInfo.url, 'failed', 'glama-ai');
        return false;
        
    } catch (error) {
        console.error(`❌ Failed to register ${serverInfo.name}:`, error.message);
        await logScraperResult(serverInfo.url, 'failed', 'glama-ai');
        return false;
    }
}

/**
 * Main Glama.ai scraper function
 */
export async function scrapeGlamaAi() {
    console.log('🔍 Scraping glama.ai for MCP servers...');
    
    try {
        // Load cache
        const cache = await loadCache();
        
        console.log(`📡 Fetching content from ${GLAMA_API_URL}`);
        const content = await fetchGlamaContent();
        
        // Parse content
        console.log('📝 Parsing server data...');
        const servers = await parseGlamaContent(content);
        console.log(`   Found ${servers.length} potential MCP servers`);
        
        let newCount = 0;
        let successCount = 0;
        
        // Process servers sorted by most recently added
        const sortedServers = servers.sort((a, b) => {
            const dateA = new Date(a.addedAt || 0);
            const dateB = new Date(b.addedAt || 0);
            return dateB - dateA;
        });
        
        for (const server of sortedServers) {
            // Use the actual package/URL as cache key
            const serverKey = server.url;
            
            // Skip if already processed
            if (cache.processedServers.includes(serverKey)) {
                continue;
            }
            
            newCount++;
            console.log(`\n🆕 New server found: ${server.name}`);
            console.log(`   URL: ${server.url} (${server.type}, confidence: ${server.confidence})`);
            console.log(`   Description: ${(server.description || '').slice(0, 100)}...`);
            
            // Skip GitHub repos - we only want servers installable via npx or SSE
            if (server.type === 'github' || server.url.includes('github.com')) {
                console.log(`   ⚠️  Skipping GitHub repo - requires manual installation`);
                cache.processedServers.push(serverKey);
                await logScraperResult(server.url, 'skipped-github', 'glama-ai');
            } else if (server.confidence >= 0.7 && server.type !== 'http') {
                // Only process npm packages and SSE servers
                const success = await registerMcpServer(server);
                if (success) {
                    successCount++;
                    // Mark as successfully processed
                    cache.processedServers.push(serverKey);
                } else {
                    // Mark as failed - we can retry these later
                    if (!cache.failedServers) cache.failedServers = [];
                    cache.failedServers.push({
                        key: serverKey,
                        url: server.url,
                        name: server.name,
                        failedAt: new Date().toISOString(),
                        reason: 'Connection failed'
                    });
                }
                
                // Rate limiting between registrations
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                // Mark low-confidence entries as processed so we don't see them again
                cache.processedServers.push(serverKey);
                await logScraperResult(server.url, 'skipped', 'glama-ai');
            }
        }
        
        // Update cache
        cache.lastRun = new Date().toISOString();
        await saveCache(cache);
        
        console.log(`\n📊 glama.ai scraping complete:`);
        console.log(`   Total servers found: ${servers.length}`);
        console.log(`   New servers: ${newCount}`);
        console.log(`   Successfully registered: ${successCount}`);
        console.log(`   Failed to connect: ${cache.failedServers ? cache.failedServers.length : 0}`);
        
        return {
            totalServers: servers.length,
            newServers: newCount,
            successfulRegistrations: successCount,
            failedConnections: cache.failedServers ? cache.failedServers.length : 0
        };
        
    } catch (error) {
        console.error('❌ glama.ai scraping failed:', error);
        throw error;
    }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    scrapeGlamaAi()
        .then((results) => {
            console.log('\n✅ glama.ai scraping completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ glama.ai scraping failed:', error);
            process.exit(1);
        });
}