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
const FEED_URL = 'https://mcp.so/feed';
const CACHE_FILE = path.join(__dirname, '../../data/mcp-so-cache.json');
const REGISTRY_API_URL = process.env.MCPFINDER_API_URL || 'https://mcpfinder.dev';

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
                processedUrls: [], 
                failedUrls: [],
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
 * Parse HTML content from mcp.so to extract server listings
 */
async function parseFeed(feedContent) {
    const entries = [];
    
    // mcp.so is a React SPA, so we need to parse the HTML structure
    // Look for server links and information in the HTML
    
    // Extract server URLs from href attributes pointing to server pages
    const serverLinkRegex = /href="\/server\/([^"]+)"/g;
    const serverMatches = feedContent.matchAll(serverLinkRegex);
    
    for (const match of serverMatches) {
        const serverPath = match[1];
        const parts = serverPath.split('/');
        const serverName = parts[0] || '';
        const author = parts[1] || '';
        
        if (serverName && author) {
            // Look for the server name in the surrounding context
            const contextStart = Math.max(0, match.index - 500);
            const contextEnd = Math.min(feedContent.length, match.index + 500);
            const context = feedContent.slice(contextStart, contextEnd);
            
            // Extract title from the context
            const titleMatch = context.match(/>([^<]+)</);
            const title = titleMatch ? titleMatch[1].trim() : serverName;
            
            // Extract description from surrounding context
            const descMatch = context.match(/<p[^>]*>([^<]+)<\/p>/);
            const description = descMatch ? descMatch[1].trim() : '';
            
            entries.push({
                title: title || serverName,
                link: `https://mcp.so/server/${serverPath}`,
                description: description || `MCP server: ${serverName} by ${author}`,
                pubDate: new Date().toISOString(),
                source: 'mcp.so',
                author,
                serverName
            });
        }
    }
    
    // Also try to extract GitHub URLs directly from the page
    const githubRegex = /href="(https:\/\/github\.com\/[^"]+)"/g;
    const githubMatches = feedContent.matchAll(githubRegex);
    
    for (const match of githubMatches) {
        const githubUrl = match[1];
        const parts = githubUrl.split('/');
        const author = parts[3];
        const repo = parts[4];
        
        if (author && repo && !entries.some(e => e.link === githubUrl)) {
            entries.push({
                title: repo,
                link: githubUrl,
                description: `GitHub repository: ${author}/${repo}`,
                pubDate: new Date().toISOString(),
                source: 'mcp.so',
                author,
                serverName: repo
            });
        }
    }
    
    return entries.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
}

/**
 * Extract potential MCP server URLs from feed entries
 */
function extractMcpUrls(entries) {
    const mcpUrls = [];
    
    for (const entry of entries) {
        const urls = [];
        
        // Look for GitHub URLs in title, description, and link
        const githubRegex = /https?:\/\/github\.com\/([\w\-\.]+\/[\w\-\.]+)(?:\/|\s|$)/g;
        // More precise npm package regex
        const npmRegex = /(?:npm install|npx|package:)\s+([@\w\-]+\/[\w\-\.]+|[\w\-]+-mcp|mcp-[\w\-]+)(?:\s|$)/g;
        
        const text = `${entry.title} ${entry.description} ${entry.link}`;
        
        // Extract GitHub URLs
        const githubMatches = text.matchAll(githubRegex);
        for (const match of githubMatches) {
            urls.push({
                url: match[0].trim(),
                type: 'github',
                confidence: 0.8
            });
        }
        
        // Extract NPM package names
        const npmMatches = text.matchAll(npmRegex);
        for (const match of npmMatches) {
            const pkg = match[1];
            // Validate package name
            if (pkg && pkg.length > 3 && !pkg.includes('http') && 
                !['github', 'repository', 'server', 'mcp', 'npm', 'install', 'npx'].includes(pkg.toLowerCase())) {
                urls.push({
                    url: pkg,
                    type: 'npm',
                    confidence: 0.7
                });
            }
        }
        
        // Skip generic HTTP URLs - only GitHub and npm packages are valid
        
        if (urls.length > 0) {
            mcpUrls.push({
                ...entry,
                extractedUrls: urls
            });
        }
    }
    
    return mcpUrls;
}

/**
 * Register MCP server using the CLI
 */
async function registerMcpServer(url, metadata) {
    try {
        console.log(`📦 Attempting to register: ${url}`);
        
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        
        // Build command with parameters
        let cmd = `node index.js register "${url}" --headless`;
        
        // Add description if available
        if (metadata.description && metadata.description.length > 10) {
            cmd += ` --description "${metadata.description.replace(/"/g, '\"')}"`;
        }
        
        // Add tags
        cmd += ` --tags "auto-discovered,mcp-so"`;
        
        // Execute registration command and capture output
        const result = await execAsync(cmd, { 
            cwd: path.join(__dirname, '../..')
        });
        
        // Check if the output contains success indicators
        const output = result.stdout + result.stderr;
        if (output.includes('Cannot connect to MCP server') || 
            output.includes('Connection closed') ||
            output.includes('Failed to connect')) {
            console.log(`⚠️  Skipping ${url} - server not accessible`);
            await logScraperResult(url, 'failed', 'mcp-so');
            return false;
        }
        
        if (output.includes('Successfully registered') || 
            output.includes('Operation: created')) {
            console.log(`✅ Successfully registered: ${url}`);
            await logScraperResult(url, 'registered', 'mcp-so');
            return true;
        }
        
        if (output.includes('Operation: updated')) {
            console.log(`✅ Updated existing server: ${url}`);
            await logScraperResult(url, 'updated', 'mcp-so');
            return true;
        }
        
        // If we can't determine success/failure, assume failure
        console.log(`❓ Unknown registration result for ${url}`);
        await logScraperResult(url, 'failed', 'mcp-so');
        return false;
        
    } catch (error) {
        console.error(`❌ Failed to register ${url}:`, error.message);
        await logScraperResult(url, 'failed', 'mcp-so');
        return false;
    }
}

/**
 * Main scraper function
 */
export async function scrapeMcpSoFeed() {
    console.log('🔍 Scraping mcp.so feed...');
    
    try {
        // Load cache
        const cache = await loadCache();
        
        // Fetch feed
        console.log(`📡 Fetching feed from ${FEED_URL}`);
        const response = await fetch(FEED_URL);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch feed: ${response.status} ${response.statusText}`);
        }
        
        const feedContent = await response.text();
        
        // Parse feed
        console.log('📝 Parsing feed entries...');
        const entries = await parseFeed(feedContent);
        console.log(`Found ${entries.length} total entries`);
        
        // Extract MCP URLs
        const mcpEntries = extractMcpUrls(entries);
        console.log(`Found ${mcpEntries.length} entries with potential MCP servers`);
        
        // Process new entries only
        let newCount = 0;
        let successCount = 0;
        
        for (const entry of mcpEntries) {
            for (const urlInfo of entry.extractedUrls) {
                const urlKey = `${entry.source}:${urlInfo.url}`;
                
                // Skip if already processed
                if (cache.processedUrls.includes(urlKey)) {
                    continue;
                }
                
                newCount++;
                console.log(`\n🆕 New entry found: ${entry.title}`);
                console.log(`   URL: ${urlInfo.url} (${urlInfo.type}, confidence: ${urlInfo.confidence})`);
                
                // Skip GitHub repos - we only want servers installable via npx or SSE
                if (urlInfo.type === 'github' || urlInfo.url.includes('github.com')) {
                    console.log(`   ⚠️  Skipping GitHub repo - requires manual installation`);
                    cache.processedUrls.push(urlKey);
                    await logScraperResult(urlInfo.url, 'skipped-github', 'mcp-so');
                } else if (urlInfo.type === 'npm') {
                    // Check if npm package actually exists
                    console.log(`   Checking npm for ${urlInfo.url}...`);
                    const exists = await checkNpmPackageExists(urlInfo.url);
                    if (!exists) {
                        console.log(`   ✗ Package not found on npm, skipping`);
                        cache.processedUrls.push(urlKey);
                        await logScraperResult(urlInfo.url, 'skipped', 'mcp-so');
                    } else if (urlInfo.confidence >= 0.6) {
                        console.log(`   ✓ Found on npm`);
                        const success = await registerMcpServer(urlInfo.url, {
                            ...entry,
                            urlType: urlInfo.type,
                            confidence: urlInfo.confidence
                        });
                    
                        if (success) {
                            successCount++;
                            // Mark as successfully processed
                            cache.processedUrls.push(urlKey);
                        } else {
                            // Mark as failed - we can retry these later
                            if (!cache.failedUrls) cache.failedUrls = [];
                            cache.failedUrls.push({
                                key: urlKey,
                                url: urlInfo.url,
                                type: urlInfo.type,
                                failedAt: new Date().toISOString(),
                                reason: 'Connection failed'
                            });
                        }
                    }
                    
                    // Rate limiting between registrations
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } else {
                    // Mark low-confidence entries as processed
                    cache.processedUrls.push(urlKey);
                    await logScraperResult(urlInfo.url, 'skipped', 'mcp-so');
                }
            }
        }
        
        // Update cache
        cache.lastRun = new Date().toISOString();
        await saveCache(cache);
        
        console.log(`\n📊 Scraping complete:`);
        console.log(`   Total entries: ${entries.length}`);
        console.log(`   MCP candidates: ${mcpEntries.length}`);
        console.log(`   New entries: ${newCount}`);
        console.log(`   Successfully registered: ${successCount}`);
        
        return {
            totalEntries: entries.length,
            mcpCandidates: mcpEntries.length,
            newEntries: newCount,
            successfulRegistrations: successCount
        };
        
    } catch (error) {
        console.error('❌ Scraping failed:', error);
        throw error;
    }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    scrapeMcpSoFeed()
        .then((results) => {
            console.log('\n✅ Scraping completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Scraping failed:', error);
            process.exit(1);
        });
}