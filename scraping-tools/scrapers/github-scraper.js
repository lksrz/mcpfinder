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
const GITHUB_REPOS = [
    'modelcontextprotocol/servers',
    'wong2/awesome-mcp-servers'
];
const CACHE_FILE = path.join(__dirname, '../../data/github-cache.json');
const GITHUB_API_BASE = 'https://api.github.com';

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
            return { processedItems: [], lastRun: null, etags: {} };
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
 * Fetch GitHub repository contents with rate limiting awareness
 */
async function fetchGitHubContent(url, etag = null) {
    const headers = {
        'User-Agent': 'MCPfinder-Scraper/1.0',
        'Accept': 'application/vnd.github.v3+json'
    };
    
    if (etag) {
        headers['If-None-Match'] = etag;
    }
    
    // Add GitHub token if available for higher rate limits
    if (process.env.GITHUB_TOKEN) {
        headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    }
    
    const response = await fetch(url, { headers });
    
    if (response.status === 304) {
        return { notModified: true };
    }
    
    if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    const newEtag = response.headers.get('etag');
    
    return { data, etag: newEtag };
}

/**
 * Parse README content to extract MCP server references
 */
function parseReadmeContent(content) {
    const mcpServers = [];
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Look for links in markdown format [text](url)
        const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
        const matches = line.matchAll(linkRegex);
        
        for (const match of matches) {
            const [, text, url] = match;
            
            // Skip non-relevant links
            if (url.includes('#') || url.startsWith('/') || url.includes('github.com') && !url.includes('/tree/') && !url.includes('/blob/')) {
                continue;
            }
            
            let serverInfo = {
                name: text.trim(),
                url: url.trim(),
                description: '',
                source: 'github-readme',
                confidence: 0.7
            };
            
            // Try to extract description from surrounding context
            const nextLines = lines.slice(i + 1, i + 3);
            for (const nextLine of nextLines) {
                if (nextLine.trim() && !nextLine.includes('[') && !nextLine.includes('#')) {
                    serverInfo.description = nextLine.trim();
                    break;
                }
            }
            
            // Determine URL type and confidence
            if (url.includes('github.com')) {
                serverInfo.type = 'github';
                serverInfo.confidence = 0.8;
            } else if (url.includes('npmjs.com') || url.includes('npm.im')) {
                serverInfo.type = 'npm';
                serverInfo.confidence = 0.9;
            } else if (url.startsWith('http')) {
                serverInfo.type = 'http';
                serverInfo.confidence = 0.5;
            } else {
                // Assume it's an npm package name
                serverInfo.type = 'npm';
                serverInfo.confidence = 0.6;
            }
            
            mcpServers.push(serverInfo);
        }
        
        // Also look for npm packages mentioned in code blocks
        if (line.includes('npx') || line.includes('npm install')) {
            const npmRegex = /(?:npx|npm install)\s+(@?[\w\-]+\/[\w\-]+|[\w\-]+)/g;
            const npmMatches = line.matchAll(npmRegex);
            
            for (const match of npmMatches) {
                const packageName = match[1];
                if (packageName && packageName !== 'npm' && packageName !== 'npx') {
                    mcpServers.push({
                        name: packageName,
                        url: packageName,
                        type: 'npm',
                        description: `npm package: ${packageName}`,
                        source: 'github-readme',
                        confidence: 0.7
                    });
                }
            }
        }
    }
    
    return mcpServers;
}

/**
 * Scrape directory structure for MCP servers
 */
async function scrapeRepoDirectory(repoPath, dirPath = '') {
    const url = `${GITHUB_API_BASE}/repos/${repoPath}/contents/${dirPath}`;
    console.log(`📁 Scanning directory: ${repoPath}/${dirPath}`);
    
    try {
        const result = await fetchGitHubContent(url);
        if (result.notModified) {
            return [];
        }
        
        const contents = result.data;
        const mcpServers = [];
        
        for (const item of contents) {
            if (item.type === 'file' && (item.name.toLowerCase().includes('readme') || item.name === 'package.json')) {
                // Fetch file content
                // Fetch the raw file content directly
                try {
                    const response = await fetch(item.download_url);
                    const content = await response.text();
                    
                    if (item.name === 'package.json') {
                        try {
                            const pkg = JSON.parse(content);
                            if (pkg.name && pkg.name !== 'package' && pkg.name !== 'npm') {
                                mcpServers.push({
                                    name: pkg.name,
                                    url: pkg.name,
                                    type: 'npm',
                                    description: pkg.description || `MCP server: ${pkg.name}`,
                                    source: `github:${repoPath}`,
                                    confidence: 0.9
                                });
                            }
                        } catch (e) {
                            // Invalid package.json, skip
                        }
                    } else if (item.name.toLowerCase().includes('readme')) {
                        const readmeServers = parseReadmeContent(content);
                        mcpServers.push(...readmeServers.map(s => ({
                            ...s,
                            source: `github:${repoPath}/${dirPath}`
                        })));
                    }
                } catch (error) {
                    console.log(`   Failed to fetch ${item.name}: ${error.message}`);
                }
                
                // Rate limiting - wait between requests
                await new Promise(resolve => setTimeout(resolve, 100));
            } else if (item.type === 'dir' && dirPath.split('/').length < 2) {
                // Recursively scan subdirectories (max 2 levels deep)
                const subDirServers = await scrapeRepoDirectory(repoPath, item.path);
                mcpServers.push(...subDirServers);
            }
        }
        
        return mcpServers;
        
    } catch (error) {
        console.error(`❌ Failed to scrape ${repoPath}/${dirPath}:`, error.message);
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
            cmd += ` --description "${serverInfo.description.replace(/"/g, '\"')}"`;
        }
        
        // Add tags
        const tags = `auto-discovered,${serverInfo.source.replace(':', '-')}`;
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
            await logScraperResult(serverInfo.url, 'failed', serverInfo.source);
            return false;
        }
        
        if (output.includes('Successfully registered') || 
            output.includes('Operation: created')) {
            console.log(`✅ Successfully registered: ${serverInfo.name}`);
            await logScraperResult(serverInfo.url, 'registered', serverInfo.source);
            return true;
        }
        
        if (output.includes('Operation: updated')) {
            console.log(`✅ Updated existing server: ${serverInfo.name}`);
            await logScraperResult(serverInfo.url, 'updated', serverInfo.source);
            return true;
        }
        
        // If we can't determine success/failure, assume failure
        console.log(`❓ Unknown registration result for ${serverInfo.name}`);
        await logScraperResult(serverInfo.url, 'failed', serverInfo.source);
        return false;
        
    } catch (error) {
        console.error(`❌ Failed to register ${serverInfo.name}:`, error.message);
        await logScraperResult(serverInfo.url, 'failed', serverInfo.source);
        return false;
    }
}

/**
 * Main GitHub scraper function
 */
export async function scrapeGitHubRepos() {
    console.log('🔍 Scraping GitHub repositories for MCP servers...');
    
    try {
        // Load cache
        const cache = await loadCache();
        
        let allServers = [];
        let newCount = 0;
        let successCount = 0;
        
        for (const repoPath of GITHUB_REPOS) {
            console.log(`\n📚 Processing repository: ${repoPath}`);
            
            // Check if repo was modified since last run
            const repoUrl = `${GITHUB_API_BASE}/repos/${repoPath}`;
            const etag = cache.etags[repoPath];
            
            const repoResult = await fetchGitHubContent(repoUrl, etag);
            if (repoResult.notModified) {
                console.log(`   No changes since last run, skipping...`);
                continue;
            }
            
            if (repoResult.etag) {
                cache.etags[repoPath] = repoResult.etag;
            }
            
            // Scrape the repository
            const servers = await scrapeRepoDirectory(repoPath);
            console.log(`   Found ${servers.length} potential MCP servers`);
            
            allServers.push(...servers);
            
            // Process new servers
            for (const server of servers) {
                const serverKey = `${server.source}:${server.url}`;
                
                // Skip if already processed
                if (cache.processedItems.includes(serverKey)) {
                    continue;
                }
                
                newCount++;
                console.log(`\n🆕 New server found: ${server.name}`);
                console.log(`   URL: ${server.url} (${server.type}, confidence: ${server.confidence})`);
                
                // Skip GitHub repos - we only want servers installable via npx or SSE
                if (server.type === 'github' || server.url.includes('github.com')) {
                    console.log(`   ⚠️  Skipping GitHub repo - requires manual installation`);
                    await logScraperResult(server.url, 'skipped-github', server.source);
                } else if (server.type === 'npm') {
                    // Check if npm package actually exists
                    console.log(`   Checking npm for ${server.url}...`);
                    const exists = await checkNpmPackageExists(server.url);
                    if (!exists) {
                        console.log(`   ✗ Package not found on npm, skipping`);
                        await logScraperResult(server.url, 'skipped', server.source);
                    } else if (server.confidence >= 0.7) {
                        console.log(`   ✓ Found on npm`);
                        const success = await registerMcpServer(server);
                        if (success) {
                            successCount++;
                        }
                    }
                } else if (server.confidence >= 0.7) {
                    // Process HTTP/SSE servers
                    const success = await registerMcpServer(server);
                    if (success) {
                        successCount++;
                    }
                } else {
                    // Skip low-confidence entries
                    await logScraperResult(server.url, 'skipped', server.source);
                }
                
                // Mark as processed regardless of success
                cache.processedItems.push(serverKey);
                
                // Rate limiting between registrations
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        // Update cache
        cache.lastRun = new Date().toISOString();
        await saveCache(cache);
        
        console.log(`\n📊 GitHub scraping complete:`);
        console.log(`   Total servers found: ${allServers.length}`);
        console.log(`   New servers: ${newCount}`);
        console.log(`   Successfully registered: ${successCount}`);
        
        return {
            totalServers: allServers.length,
            newServers: newCount,
            successfulRegistrations: successCount
        };
        
    } catch (error) {
        console.error('❌ GitHub scraping failed:', error);
        throw error;
    }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    scrapeGitHubRepos()
        .then((results) => {
            console.log('\n✅ GitHub scraping completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ GitHub scraping failed:', error);
            process.exit(1);
        });
}