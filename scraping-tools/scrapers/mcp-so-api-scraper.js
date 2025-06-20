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
const CACHE_FILE = path.join(__dirname, '../../data/mcp-so-api-cache.json');

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
                discoveries: {
                    npmPackages: [],
                    uvxPackages: [],
                    httpServers: [],
                    sseServers: [],
                    githubRepos: [],
                    unknown: []
                },
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
 * Try to access mcp.so's internal API or data endpoints
 */
async function tryApiEndpoints() {
    const possibleEndpoints = [
        'https://mcp.so/api/servers',
        'https://mcp.so/api/v1/servers',
        'https://mcp.so/_next/data/servers.json',
        'https://mcp.so/servers.json',
        'https://mcp.so/data/servers.json',
        'https://mcp.so/.netlify/functions/servers',
        'https://mcp.so/.vercel/functions/servers'
    ];
    
    console.log('🔍 Trying to find API endpoints...');
    
    for (const endpoint of possibleEndpoints) {
        try {
            console.log(`   Trying: ${endpoint}`);
            const response = await fetch(endpoint, {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'MCPfinder-Scraper/1.0'
                }
            });
            
            if (response.ok) {
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('json')) {
                    console.log(`   ✅ Found JSON endpoint: ${endpoint}`);
                    const data = await response.json();
                    return { endpoint, data };
                }
            }
            console.log(`   ❌ ${response.status} - ${response.statusText}`);
        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}`);
        }
    }
    
    return null;
}

/**
 * Extract server information from various data formats
 */
function extractServerInfo(data) {
    const servers = [];
    
    // Handle array of servers
    if (Array.isArray(data)) {
        data.forEach(item => {
            if (item.name || item.title || item.package || item.url) {
                servers.push({
                    name: item.name || item.title || item.package || 'Unknown',
                    url: item.url || item.link || item.homepage || '',
                    description: item.description || '',
                    package: item.package || item.npm || item.npmPackage || '',
                    github: item.github || item.repo || item.repository || '',
                    author: item.author || item.creator || '',
                    tags: item.tags || item.categories || [],
                    installCommand: item.installCommand || item.install || ''
                });
            }
        });
    }
    // Handle object with servers property
    else if (data.servers && Array.isArray(data.servers)) {
        return extractServerInfo(data.servers);
    }
    // Handle paginated data
    else if (data.data && Array.isArray(data.data)) {
        return extractServerInfo(data.data);
    }
    // Handle single server object
    else if (typeof data === 'object' && data.name) {
        servers.push({
            name: data.name || 'Unknown',
            url: data.url || '',
            description: data.description || '',
            package: data.package || '',
            github: data.github || '',
            author: data.author || '',
            tags: data.tags || [],
            installCommand: data.installCommand || ''
        });
    }
    
    return servers;
}

/**
 * Analyze a server to determine its type and viability
 */
async function analyzeServer(server) {
    const result = {
        name: server.name,
        type: 'unknown',
        packageOrUrl: null,
        viable: false,
        reason: '',
        details: {}
    };
    
    // Check if it's an HTTP/SSE server
    if (server.url && (server.url.startsWith('http://') || server.url.startsWith('https://'))) {
        if (server.url.includes('github.com')) {
            result.type = 'github';
            result.packageOrUrl = server.url;
            result.reason = 'GitHub repository - requires manual installation';
            result.details.githubUrl = server.url;
        } else {
            // Check if it's an SSE endpoint
            if (server.url.endsWith('/sse') || server.description?.toLowerCase().includes('sse')) {
                result.type = 'sse';
                result.packageOrUrl = server.url;
                result.viable = true;
                result.reason = 'SSE endpoint available';
            } else {
                result.type = 'http';
                result.packageOrUrl = server.url;
                result.viable = true;
                result.reason = 'HTTP endpoint available';
            }
        }
    }
    
    // Check if it's an npm package
    if (server.package || server.npmPackage) {
        const packageName = server.package || server.npmPackage;
        console.log(`   Checking npm for ${packageName}...`);
        const exists = await checkNpmPackageExists(packageName);
        if (exists) {
            result.type = 'npm';
            result.packageOrUrl = packageName;
            result.viable = true;
            result.reason = 'Available on npm';
            result.details.npmPackage = packageName;
        }
    }
    
    // Check install command for clues
    if (server.installCommand) {
        if (server.installCommand.includes('npx')) {
            const match = server.installCommand.match(/npx\s+(@?[\w\-]+\/[\w\-\.]+|[\w\-]+)/);
            if (match && !result.viable) {
                const packageName = match[1];
                console.log(`   Checking npm for ${packageName} (from install command)...`);
                const exists = await checkNpmPackageExists(packageName);
                if (exists) {
                    result.type = 'npm';
                    result.packageOrUrl = packageName;
                    result.viable = true;
                    result.reason = 'Available on npm (from install command)';
                    result.details.npmPackage = packageName;
                }
            }
        } else if (server.installCommand.includes('uvx')) {
            const match = server.installCommand.match(/uvx\s+(@?[\w\-]+\/[\w\-\.]+|[\w\-]+)/);
            if (match) {
                result.type = 'uvx';
                result.packageOrUrl = match[1];
                result.viable = true;
                result.reason = 'Python package via uvx';
                result.details.uvxPackage = match[1];
            }
        }
    }
    
    // Try to infer from name if nothing else worked
    if (!result.viable && server.name) {
        // Check if name looks like npm package
        if (server.name.match(/^@[\w\-]+\/[\w\-]+$/) || server.name.match(/^[\w\-]+-mcp$/)) {
            console.log(`   Checking npm for ${server.name} (inferred from name)...`);
            const exists = await checkNpmPackageExists(server.name);
            if (exists) {
                result.type = 'npm';
                result.packageOrUrl = server.name;
                result.viable = true;
                result.reason = 'Available on npm (inferred from name)';
                result.details.npmPackage = server.name;
            }
        }
    }
    
    return result;
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
        if (serverInfo.type === 'uvx') {
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
            await logScraperResult(serverInfo.packageOrUrl, 'failed', 'mcp-so-api');
            return false;
        }
        
        if (output.includes('Successfully registered') || 
            output.includes('Operation: created')) {
            console.log(`✅ Successfully registered: ${serverInfo.name}`);
            await logScraperResult(serverInfo.packageOrUrl, 'registered', 'mcp-so-api');
            return true;
        }
        
        if (output.includes('Operation: updated')) {
            console.log(`✅ Updated existing server: ${serverInfo.name}`);
            await logScraperResult(serverInfo.packageOrUrl, 'updated', 'mcp-so-api');
            return true;
        }
        
        // If we can't determine success/failure, assume failure
        console.log(`❓ Unknown registration result for ${serverInfo.name}`);
        await logScraperResult(serverInfo.packageOrUrl, 'failed', 'mcp-so-api');
        return false;
        
    } catch (error) {
        console.error(`❌ Failed to register ${serverInfo.name}:`, error.message);
        await logScraperResult(serverInfo.packageOrUrl, 'failed', 'mcp-so-api');
        return false;
    }
}

/**
 * Main function to discover and analyze mcp.so servers
 */
export async function discoverMcpSoServers(options = {}) {
    console.log('🔍 Attempting to discover mcp.so servers...\n');
    
    try {
        // Load cache
        const cache = await loadCache();
        
        // Try to find API endpoints
        const apiResult = await tryApiEndpoints();
        
        if (!apiResult) {
            console.log('\n❌ Could not find any API endpoints');
            console.log('\n💡 Alternative approach needed:');
            console.log('   1. Manual export from mcp.so');
            console.log('   2. Use browser automation with anti-detection');
            console.log('   3. Contact mcp.so for API access');
            return;
        }
        
        console.log(`\n✅ Found data at: ${apiResult.endpoint}`);
        
        // Extract server information
        const servers = extractServerInfo(apiResult.data);
        console.log(`\n📊 Found ${servers.length} servers to analyze`);
        
        // Analyze each server
        let viableCount = 0;
        const discoveries = {
            npmPackages: [],
            uvxPackages: [],
            httpServers: [],
            sseServers: [],
            githubRepos: [],
            unknown: []
        };
        
        for (let i = 0; i < servers.length; i++) {
            const server = servers[i];
            
            // Skip if already processed
            const serverKey = `${server.name}:${server.url || server.package || ''}`;
            if (cache.processedServers.includes(serverKey)) {
                continue;
            }
            
            console.log(`\n[${i + 1}/${servers.length}] Analyzing: ${server.name}`);
            
            const analysis = await analyzeServer(server);
            
            // Categorize the result
            switch (analysis.type) {
                case 'npm':
                    discoveries.npmPackages.push(analysis);
                    break;
                case 'uvx':
                    discoveries.uvxPackages.push(analysis);
                    break;
                case 'http':
                    discoveries.httpServers.push(analysis);
                    break;
                case 'sse':
                    discoveries.sseServers.push(analysis);
                    break;
                case 'github':
                    discoveries.githubRepos.push(analysis);
                    break;
                default:
                    discoveries.unknown.push(analysis);
            }
            
            if (analysis.viable) {
                viableCount++;
                console.log(`   ✅ VIABLE: ${analysis.reason}`);
                
                // Try to register if requested
                if (options.register) {
                    await registerMcpServer({
                        name: server.name,
                        packageOrUrl: analysis.packageOrUrl,
                        description: server.description,
                        type: analysis.type
                    });
                    
                    // Rate limiting
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } else {
                console.log(`   ❌ NOT VIABLE: ${analysis.reason}`);
            }
            
            // Mark as processed
            cache.processedServers.push(serverKey);
            
            // Save cache periodically
            if (i % 50 === 0) {
                cache.discoveries = discoveries;
                await saveCache(cache);
                console.log(`\n💾 Cache saved (${i} servers processed)`);
            }
        }
        
        // Final save
        cache.discoveries = discoveries;
        cache.lastRun = new Date().toISOString();
        await saveCache(cache);
        
        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 DISCOVERY SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total servers analyzed: ${servers.length}`);
        console.log(`Viable servers found: ${viableCount}`);
        console.log('\nBreakdown by type:');
        console.log(`  📦 NPM packages: ${discoveries.npmPackages.length}`);
        console.log(`  🐍 Python packages (uvx): ${discoveries.uvxPackages.length}`);
        console.log(`  🌐 HTTP servers: ${discoveries.httpServers.length}`);
        console.log(`  📡 SSE servers: ${discoveries.sseServers.length}`);
        console.log(`  🐙 GitHub repos: ${discoveries.githubRepos.length}`);
        console.log(`  ❓ Unknown/Other: ${discoveries.unknown.length}`);
        console.log('='.repeat(60));
        
        // Save detailed report
        const reportFile = path.join(__dirname, '../../data/mcp-so-discovery-report.json');
        await fs.writeFile(reportFile, JSON.stringify({
            summary: {
                totalAnalyzed: servers.length,
                viableServers: viableCount,
                npmPackages: discoveries.npmPackages.length,
                uvxPackages: discoveries.uvxPackages.length,
                httpServers: discoveries.httpServers.length,
                sseServers: discoveries.sseServers.length,
                githubRepos: discoveries.githubRepos.length,
                unknown: discoveries.unknown.length
            },
            discoveries,
            timestamp: new Date().toISOString()
        }, null, 2));
        
        console.log(`\n📄 Detailed report saved to: ${reportFile}`);
        
    } catch (error) {
        console.error('❌ Discovery failed:', error);
        throw error;
    }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const options = {
        register: args.includes('--register')
    };
    
    if (args.includes('--help')) {
        console.log(`
Usage: node mcp-so-api-scraper.js [options]

Options:
  --register    Register viable servers after discovery
  --help        Show this help message

Examples:
  node mcp-so-api-scraper.js              # Discover and analyze only
  node mcp-so-api-scraper.js --register   # Discover and register viable servers
`);
        process.exit(0);
    }
    
    discoverMcpSoServers(options)
        .then(() => {
            console.log('\n✅ Discovery completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Discovery failed:', error);
            process.exit(1);
        });
}