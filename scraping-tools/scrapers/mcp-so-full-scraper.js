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
const BASE_URL = 'https://mcp.so/servers';
const CACHE_FILE = path.join(__dirname, '../../data/mcp-so-full-cache.json');
const SERVERS_PER_PAGE = 30;
const MAX_PAGES = 510; // A bit more than 506 to be safe

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
                failedServers: [],
                lastProcessedPage: 0,
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
 * Parse HTML page to extract server information
 */
function parseServersFromHtml(html) {
    const servers = [];
    
    // Look for server entries - mcp.so uses a card-based layout
    // Look for links to individual server pages
    const serverRegex = /<a[^>]*href="\/server\/([^"\/]+)\/([^"\/]+)"[^>]*>/g;
    const matches = html.matchAll(serverRegex);
    
    for (const match of matches) {
        const [, slug, author] = match;
        if (slug && author) {
            // Extract the server name from nearby text
            const serverUrl = `/server/${slug}/${author}`;
            
            servers.push({
                slug,
                author,
                name: slug.replace(/-/g, ' '),
                url: `https://mcp.so${serverUrl}`
            });
        }
    }
    
    // Remove duplicates
    const uniqueServers = [];
    const seen = new Set();
    for (const server of servers) {
        const key = `${server.slug}/${server.author}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueServers.push(server);
        }
    }
    
    return uniqueServers;
}

/**
 * Fetch a single page of servers
 */
async function fetchPage(pageNum) {
    const url = pageNum === 1 
        ? `${BASE_URL}?tag=latest` 
        : `${BASE_URL}?tag=latest&page=${pageNum}`;
    
    console.log(`📄 Fetching page ${pageNum}: ${url}`);
    
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'MCPfinder-Scraper/1.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        
        if (!response.ok) {
            if (response.status === 404) {
                return null; // No more pages
            }
            throw new Error(`HTTP ${response.status}`);
        }
        
        const html = await response.text();
        return parseServersFromHtml(html);
        
    } catch (error) {
        console.error(`❌ Failed to fetch page ${pageNum}: ${error.message}`);
        return null;
    }
}

/**
 * Fetch detailed information about a server
 */
async function fetchServerDetails(serverInfo) {
    const url = serverInfo.url;
    
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'MCPfinder-Scraper/1.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        
        if (!response.ok) {
            return null;
        }
        
        const html = await response.text();
        
        // Extract more details from the server page
        const details = {
            description: '',
            npmPackage: null,
            githubUrl: null,
            uvPackage: null,
            tags: [],
            installCommand: null
        };
        
        // Look for the Server Config section with install commands
        // mcp.so shows commands like: npx package-name, npm install package-name, uvx package-name
        const configSection = html.match(/Server\s*Config[^<]*<[^>]*>([^<]+(?:<[^>]*>[^<]*)*?(?:npx|npm\s+install|uvx)[^<]+)/i);
        
        if (configSection) {
            // Extract npx command
            const npxMatch = configSection[1].match(/npx\s+(@?[\w\-]+\/[\w\-\.]+|[\w\-]+)/);
            if (npxMatch) {
                details.npmPackage = npxMatch[1];
                details.installCommand = 'npx';
            }
            
            // Extract npm install command
            const npmMatch = configSection[1].match(/npm\s+install\s+(@?[\w\-]+\/[\w\-\.]+|[\w\-]+)/);
            if (npmMatch && !details.npmPackage) {
                details.npmPackage = npmMatch[1];
                details.installCommand = 'npm';
            }
            
            // Extract uvx command (Python packages)
            const uvxMatch = configSection[1].match(/uvx\s+(@?[\w\-]+\/[\w\-\.]+|[\w\-]+)/);
            if (uvxMatch) {
                details.uvPackage = uvxMatch[1];
                details.installCommand = 'uvx';
            }
        }
        
        // Also check for these patterns anywhere in the page
        if (!details.npmPackage) {
            const npxMatch = html.match(/npx\s+(@?[\w\-]+\/[\w\-\.]+|[\w\-]+)/);
            if (npxMatch) {
                details.npmPackage = npxMatch[1];
                details.installCommand = 'npx';
            }
        }
        
        // Look for GitHub URL
        const githubMatch = html.match(/https?:\/\/github\.com\/([\w\-\.]+\/[\w\-\.]+)/);
        if (githubMatch) {
            details.githubUrl = githubMatch[0];
        }
        
        // Extract description (look for meta description or first paragraph)
        const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/) ||
                         html.match(/<p[^>]*>([^<]{20,200})/);
        if (descMatch) {
            details.description = descMatch[1].trim();
        }
        
        return details;
        
    } catch (error) {
        console.log(`   Failed to fetch details for ${serverInfo.slug}: ${error.message}`);
        return null;
    }
}

/**
 * Register MCP server using the CLI
 */
async function registerMcpServer(serverInfo) {
    try {
        console.log(`📦 Attempting to register: ${serverInfo.name} (${serverInfo.packageOrUrl})`);
        
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);
        
        // Build command with parameters
        let cmd = `node index.js register "${serverInfo.packageOrUrl}" --headless`;
        
        // Add description if available
        if (serverInfo.description && serverInfo.description.length > 10) {
            const cleanDesc = serverInfo.description
                .replace(/"/g, '\\"')
                .replace(/'/g, "\\'")
                .replace(/\$/g, '\\$')
                .replace(/`/g, '\\`')
                .substring(0, 200);
            cmd += ` --description "${cleanDesc}"`;
        }
        
        // Add tags
        cmd += ` --tags "auto-discovered,mcp-so"`;
        
        // Add uvx flag if it's a Python package
        if (serverInfo.installCommand === 'uvx' || serverInfo.type === 'uvx') {
            cmd += ` --use-uvx`;
        }
        
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
            await logScraperResult(serverInfo.packageOrUrl, 'failed', 'mcp-so-full');
            return false;
        }
        
        if (output.includes('Successfully registered') || 
            output.includes('Operation: created')) {
            console.log(`✅ Successfully registered: ${serverInfo.name}`);
            await logScraperResult(serverInfo.packageOrUrl, 'registered', 'mcp-so-full');
            return true;
        }
        
        if (output.includes('Operation: updated')) {
            console.log(`✅ Updated existing server: ${serverInfo.name}`);
            await logScraperResult(serverInfo.packageOrUrl, 'updated', 'mcp-so-full');
            return true;
        }
        
        // If we can't determine success/failure, assume failure
        console.log(`❓ Unknown registration result for ${serverInfo.name}`);
        await logScraperResult(serverInfo.packageOrUrl, 'failed', 'mcp-so-full');
        return false;
        
    } catch (error) {
        console.error(`❌ Failed to register ${serverInfo.name}:`, error.message);
        await logScraperResult(serverInfo.packageOrUrl, 'failed', 'mcp-so-full');
        return false;
    }
}

/**
 * Main scraper function for full mcp.so catalog
 */
export async function scrapeMcpSoFull(options = {}) {
    const startPage = options.startPage || 1;
    const endPage = options.endPage || MAX_PAGES;
    const limit = options.limit || null;
    
    console.log(`🔍 Scraping mcp.so full catalog (pages ${startPage}-${endPage})...`);
    
    try {
        // Load cache
        const cache = await loadCache();
        
        let totalServers = 0;
        let newServers = 0;
        let successCount = 0;
        let processedCount = 0;
        
        // Resume from last processed page if available
        const resumePage = Math.max(startPage, (cache.lastProcessedPage || 0) + 1);
        
        for (let page = resumePage; page <= endPage; page++) {
            console.log(`\n📚 Processing page ${page}...`);
            
            const servers = await fetchPage(page);
            
            if (!servers || servers.length === 0) {
                console.log(`   No servers found on page ${page}, might be the end`);
                break;
            }
            
            console.log(`   Found ${servers.length} servers on this page`);
            totalServers += servers.length;
            
            for (const server of servers) {
                // Skip if already processed
                if (cache.processedServers.includes(server.url)) {
                    continue;
                }
                
                newServers++;
                console.log(`\n🔍 Analyzing: ${server.name}`);
                
                // Determine what type of server this is
                let packageOrUrl = null;
                let serverType = 'unknown';
                
                if (server.isNpmPackage) {
                    // Check if npm package exists
                    console.log(`   Checking npm for ${server.name}...`);
                    const exists = await checkNpmPackageExists(server.name);
                    if (exists) {
                        console.log(`   ✓ Found on npm`);
                        packageOrUrl = server.name;
                        serverType = 'npm';
                    } else {
                        console.log(`   ✗ Not found on npm`);
                        cache.processedServers.push(server.url);
                        await logScraperResult(server.name, 'skipped', 'mcp-so-full');
                        continue;
                    }
                } else if (server.isGitHub || server.url.includes('github.com')) {
                    console.log(`   ⚠️  Skipping GitHub repo - requires manual installation`);
                    cache.processedServers.push(server.url);
                    await logScraperResult(server.url, 'skipped-github', 'mcp-so-full');
                    continue;
                } else {
                    // Fetch details to determine type
                    const details = await fetchServerDetails(server);
                    
                    if (details) {
                        if (details.npmPackage) {
                            console.log(`   Checking npm for ${details.npmPackage}...`);
                            const exists = await checkNpmPackageExists(details.npmPackage);
                            if (exists) {
                                console.log(`   ✓ Found on npm`);
                                packageOrUrl = details.npmPackage;
                                serverType = 'npm';
                            } else {
                                console.log(`   ✗ Not found on npm`);
                                cache.processedServers.push(server.url);
                                await logScraperResult(details.npmPackage, 'skipped', 'mcp-so-full');
                                continue;
                            }
                        } else if (details.uvPackage) {
                            console.log(`   ✓ Found Python package: ${details.uvPackage} (uvx)`);
                            packageOrUrl = details.uvPackage;
                            serverType = 'uvx';
                            server.installCommand = 'uvx';
                        } else if (details.githubUrl) {
                            console.log(`   ⚠️  Skipping GitHub repo - requires manual installation`);
                            cache.processedServers.push(server.url);
                            await logScraperResult(details.githubUrl, 'skipped-github', 'mcp-so-full');
                            continue;
                        }
                        
                        server.description = details.description;
                        server.installCommand = details.installCommand;
                    }
                }
                
                // If we have a valid package (npm or uvx), try to register it
                if (packageOrUrl && (serverType === 'npm' || serverType === 'uvx')) {
                    const success = await registerMcpServer({
                        name: server.name,
                        packageOrUrl,
                        description: server.description || `MCP server: ${server.name}`,
                        type: serverType,
                        installCommand: server.installCommand
                    });
                    
                    if (success) {
                        successCount++;
                    } else {
                        // Mark as failed
                        if (!cache.failedServers) cache.failedServers = [];
                        cache.failedServers.push({
                            url: server.url,
                            package: packageOrUrl,
                            failedAt: new Date().toISOString(),
                            reason: 'Connection failed'
                        });
                    }
                    
                    // Rate limiting
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
                
                // Mark as processed
                cache.processedServers.push(server.url);
                processedCount++;
                
                // Check if we've hit the limit
                if (limit && processedCount >= limit) {
                    console.log(`\n🛑 Reached processing limit of ${limit} servers`);
                    break;
                }
            }
            
            // Update last processed page
            cache.lastProcessedPage = page;
            
            // Save cache periodically (every 5 pages)
            if (page % 5 === 0) {
                await saveCache(cache);
                console.log(`💾 Cache saved at page ${page}`);
            }
            
            // Check if we've hit the limit
            if (limit && processedCount >= limit) {
                break;
            }
            
            // Rate limiting between pages
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Final cache save
        cache.lastRun = new Date().toISOString();
        await saveCache(cache);
        
        console.log(`\n📊 mcp.so full scraping complete:`);
        console.log(`   Total servers found: ${totalServers}`);
        console.log(`   New servers: ${newServers}`);
        console.log(`   Successfully registered: ${successCount}`);
        console.log(`   Failed connections: ${cache.failedServers ? cache.failedServers.length : 0}`);
        
        return {
            totalServers,
            newServers,
            successfulRegistrations: successCount,
            failedConnections: cache.failedServers ? cache.failedServers.length : 0
        };
        
    } catch (error) {
        console.error('❌ mcp.so full scraping failed:', error);
        throw error;
    }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const options = {};
    
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--start':
                options.startPage = parseInt(args[++i]);
                break;
            case '--end':
                options.endPage = parseInt(args[++i]);
                break;
            case '--limit':
                options.limit = parseInt(args[++i]);
                break;
            case '--help':
                console.log(`
Usage: node mcp-so-full-scraper.js [options]

Options:
  --start <page>  Start from page number (default: 1)
  --end <page>    End at page number (default: 510)
  --limit <num>   Limit number of servers to process
  --help          Show this help message

Examples:
  node mcp-so-full-scraper.js --start 1 --end 10
  node mcp-so-full-scraper.js --limit 100
`);
                process.exit(0);
        }
    }
    
    scrapeMcpSoFull(options)
        .then((results) => {
            console.log('\n✅ mcp.so full scraping completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ mcp.so full scraping failed:', error);
            process.exit(1);
        });
}