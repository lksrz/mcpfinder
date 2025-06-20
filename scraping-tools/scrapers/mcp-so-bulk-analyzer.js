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

/**
 * Check if an HTTP/SSE endpoint is accessible
 */
async function checkHttpEndpoint(url) {
    try {
        const response = await fetch(url, {
            method: 'OPTIONS',
            headers: {
                'Origin': 'https://mcpfinder.dev'
            },
            timeout: 5000
        });
        
        return {
            accessible: response.ok || response.status === 405, // 405 means OPTIONS not allowed but server exists
            status: response.status,
            headers: {
                cors: response.headers.get('access-control-allow-origin'),
                methods: response.headers.get('access-control-allow-methods')
            }
        };
    } catch (error) {
        return {
            accessible: false,
            error: error.message
        };
    }
}

/**
 * Analyze a single server entry
 */
async function analyzeServer(server) {
    const result = {
        name: server.name || server.title || 'Unknown',
        originalData: server,
        analysis: {
            type: 'unknown',
            viable: false,
            packageOrUrl: null,
            details: {}
        }
    };
    
    // Extract potential package names or URLs from various fields
    const searchTexts = [
        server.description || '',
        server.install || '',
        server.command || '',
        server.config || '',
        JSON.stringify(server)
    ].join(' ');
    
    // Look for npm packages
    const npmPatterns = [
        /npx\s+(@?[\w\-]+\/[\w\-\.]+|[\w\-]+)/g,
        /npm\s+install\s+(@?[\w\-]+\/[\w\-\.]+|[\w\-]+)/g,
        /"package"\s*:\s*"(@?[\w\-]+\/[\w\-\.]+|[\w\-]+)"/g
    ];
    
    for (const pattern of npmPatterns) {
        const matches = searchTexts.matchAll(pattern);
        for (const match of matches) {
            const packageName = match[1];
            if (packageName && !packageName.includes('http')) {
                console.log(`   Checking npm: ${packageName}`);
                const exists = await checkNpmPackageExists(packageName);
                if (exists) {
                    result.analysis.type = 'npm';
                    result.analysis.viable = true;
                    result.analysis.packageOrUrl = packageName;
                    result.analysis.details.npmPackage = packageName;
                    return result;
                }
            }
        }
    }
    
    // Look for uvx packages
    const uvxPattern = /uvx\s+(@?[\w\-]+\/[\w\-\.]+|[\w\-]+)/g;
    const uvxMatches = searchTexts.matchAll(uvxPattern);
    for (const match of uvxMatches) {
        const packageName = match[1];
        if (packageName) {
            result.analysis.type = 'uvx';
            result.analysis.viable = true;
            result.analysis.packageOrUrl = packageName;
            result.analysis.details.uvxPackage = packageName;
            return result;
        }
    }
    
    // Look for HTTP/SSE URLs
    const urlPattern = /https?:\/\/[^\s<>"']+/g;
    const urlMatches = searchTexts.matchAll(urlPattern);
    for (const match of urlMatches) {
        const url = match[0];
        if (!url.includes('github.com') && !url.includes('npm') && !url.includes('example')) {
            console.log(`   Checking HTTP endpoint: ${url}`);
            const check = await checkHttpEndpoint(url);
            if (check.accessible) {
                result.analysis.type = url.endsWith('/sse') ? 'sse' : 'http';
                result.analysis.viable = true;
                result.analysis.packageOrUrl = url;
                result.analysis.details.endpoint = {
                    url,
                    status: check.status,
                    cors: check.headers?.cors
                };
                return result;
            }
        }
    }
    
    // Check if it's a GitHub repo
    if (searchTexts.includes('github.com')) {
        const githubPattern = /github\.com\/([^\/\s]+\/[^\/\s]+)/;
        const githubMatch = searchTexts.match(githubPattern);
        if (githubMatch) {
            result.analysis.type = 'github';
            result.analysis.viable = false;
            result.analysis.packageOrUrl = `https://github.com/${githubMatch[1]}`;
            result.analysis.details.githubRepo = githubMatch[1];
        }
    }
    
    return result;
}

/**
 * Process a list of servers from mcp.so
 */
export async function analyzeMcpSoServers(inputFile) {
    console.log(`📋 Analyzing mcp.so servers from: ${inputFile}\n`);
    
    try {
        // Read input file
        const inputData = await fs.readFile(inputFile, 'utf-8');
        let servers;
        
        try {
            servers = JSON.parse(inputData);
            if (!Array.isArray(servers)) {
                if (servers.servers) servers = servers.servers;
                else if (servers.data) servers = servers.data;
                else servers = [servers];
            }
        } catch (e) {
            console.error('❌ Invalid JSON format in input file');
            return;
        }
        
        console.log(`📊 Found ${servers.length} servers to analyze\n`);
        
        // Analysis results
        const results = {
            summary: {
                total: servers.length,
                viable: 0,
                byType: {
                    npm: 0,
                    uvx: 0,
                    http: 0,
                    sse: 0,
                    github: 0,
                    unknown: 0
                }
            },
            viable: [],
            nonViable: []
        };
        
        // Process each server
        for (let i = 0; i < servers.length; i++) {
            const server = servers[i];
            console.log(`[${i + 1}/${servers.length}] Analyzing: ${server.name || server.title || 'Server ' + i}`);
            
            const analysis = await analyzeServer(server);
            
            if (analysis.analysis.viable) {
                results.viable.push(analysis);
                results.summary.viable++;
                console.log(`   ✅ VIABLE: ${analysis.analysis.type} - ${analysis.analysis.packageOrUrl}`);
            } else {
                results.nonViable.push(analysis);
                console.log(`   ❌ NOT VIABLE: ${analysis.analysis.type}`);
            }
            
            results.summary.byType[analysis.analysis.type]++;
            
            // Rate limiting to avoid overwhelming services
            if (i % 10 === 0 && i > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        // Save results
        const outputFile = path.join(__dirname, '../../data/mcp-so-analysis-results.json');
        await fs.writeFile(outputFile, JSON.stringify(results, null, 2));
        
        // Save viable servers in a format ready for registration
        const viableFile = path.join(__dirname, '../../data/mcp-so-viable-servers.json');
        const viableServers = results.viable.map(v => ({
            name: v.name,
            packageOrUrl: v.analysis.packageOrUrl,
            type: v.analysis.type,
            description: v.originalData.description || ''
        }));
        await fs.writeFile(viableFile, JSON.stringify(viableServers, null, 2));
        
        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 ANALYSIS COMPLETE');
        console.log('='.repeat(60));
        console.log(`Total servers analyzed: ${results.summary.total}`);
        console.log(`Viable servers found: ${results.summary.viable} (${(results.summary.viable / results.summary.total * 100).toFixed(1)}%)`);
        console.log('\nBreakdown by type:');
        console.log(`  📦 NPM packages: ${results.summary.byType.npm}`);
        console.log(`  🐍 Python packages (uvx): ${results.summary.byType.uvx}`);
        console.log(`  🌐 HTTP endpoints: ${results.summary.byType.http}`);
        console.log(`  📡 SSE endpoints: ${results.summary.byType.sse}`);
        console.log(`  🐙 GitHub repos: ${results.summary.byType.github}`);
        console.log(`  ❓ Unknown: ${results.summary.byType.unknown}`);
        console.log('='.repeat(60));
        console.log(`\n📄 Full results saved to: ${outputFile}`);
        console.log(`📄 Viable servers saved to: ${viableFile}`);
        
    } catch (error) {
        console.error('❌ Analysis failed:', error);
        throw error;
    }
}

/**
 * Register all viable servers
 */
export async function registerViableServers(viableFile) {
    console.log(`📦 Registering viable servers from: ${viableFile}\n`);
    
    try {
        const data = await fs.readFile(viableFile, 'utf-8');
        const servers = JSON.parse(data);
        
        console.log(`Found ${servers.length} viable servers to register\n`);
        
        let successCount = 0;
        let failCount = 0;
        
        for (let i = 0; i < servers.length; i++) {
            const server = servers[i];
            console.log(`[${i + 1}/${servers.length}] Registering: ${server.name}`);
            
            const { exec } = await import('child_process');
            const { promisify } = await import('util');
            const execAsync = promisify(exec);
            
            // Build command
            let cmd = `node index.js register "${server.packageOrUrl}" --headless`;
            
            if (server.description) {
                const cleanDesc = server.description
                    .replace(/"/g, '\\"')
                    .replace(/'/g, "\\'")
                    .substring(0, 200);
                cmd += ` --description "${cleanDesc}"`;
            }
            
            cmd += ` --tags "auto-discovered,mcp-so"`;
            
            if (server.type === 'uvx') {
                cmd += ` --use-uvx`;
            }
            
            try {
                const result = await execAsync(cmd, { 
                    cwd: path.join(__dirname, '../..')
                });
                
                const output = result.stdout + result.stderr;
                if (output.includes('Successfully registered') || 
                    output.includes('Operation: created') ||
                    output.includes('Operation: updated')) {
                    console.log(`   ✅ Success`);
                    successCount++;
                    await logScraperResult(server.packageOrUrl, 'registered', 'mcp-so-bulk');
                } else {
                    console.log(`   ❌ Failed`);
                    failCount++;
                    await logScraperResult(server.packageOrUrl, 'failed', 'mcp-so-bulk');
                }
            } catch (error) {
                console.log(`   ❌ Error: ${error.message}`);
                failCount++;
                await logScraperResult(server.packageOrUrl, 'failed', 'mcp-so-bulk');
            }
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        console.log(`\n✅ Registration complete: ${successCount} successful, ${failCount} failed`);
        
    } catch (error) {
        console.error('❌ Registration failed:', error);
        throw error;
    }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args.includes('--help')) {
        console.log(`
Usage: node mcp-so-bulk-analyzer.js <command> [options]

Commands:
  analyze <input-file>     Analyze servers from JSON file
  register <viable-file>   Register viable servers from analysis

Examples:
  # Step 1: Analyze servers from exported data
  node mcp-so-bulk-analyzer.js analyze mcp-so-servers.json
  
  # Step 2: Register the viable servers
  node mcp-so-bulk-analyzer.js register data/mcp-so-viable-servers.json

The input JSON file should contain an array of server objects.
Each object should have at least a 'name' field and may include
'description', 'install', 'command', 'config', etc.
`);
        process.exit(0);
    }
    
    const command = args[0];
    const file = args[1];
    
    if (!file) {
        console.error('❌ Please provide a file path');
        process.exit(1);
    }
    
    if (command === 'analyze') {
        analyzeMcpSoServers(file)
            .then(() => process.exit(0))
            .catch(() => process.exit(1));
    } else if (command === 'register') {
        registerViableServers(file)
            .then(() => process.exit(0))
            .catch(() => process.exit(1));
    } else {
        console.error(`❌ Unknown command: ${command}`);
        process.exit(1);
    }
}