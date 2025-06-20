#!/usr/bin/env node

/**
 * Test known viable servers from mcp.so
 */

import fetch from 'node-fetch';

const knownServers = [
    {
        name: 'mcp-server-llmling',
        url: 'https://mcp.so/server/mcp-server-llmling/phil65',
        expectedCommand: 'uvx',
        expectedPackage: 'mcp-server-llmling'
    },
    {
        name: 'mcp-server-shell',
        url: 'https://mcp.so/server/mcp-server-shell/odysseus0',
        expectedCommand: 'uvx',
        expectedPackage: 'mcp-server-shell'
    },
    {
        name: 'perplexity-mcp-server',
        url: 'https://mcp.so/server/perplexity-mcp-server/spragginsdesigns'
    },
    {
        name: 'mcp-server-bluesky',
        url: 'https://mcp.so/server/mcp-server-bluesky/morinokami'
    },
    {
        name: 'mcp-server-replicate',
        url: 'https://mcp.so/server/mcp-server-replicate/gerred'
    }
];

async function testServer(server) {
    console.log(`\n🔍 Testing ${server.name}...`);
    console.log(`   URL: ${server.url}?tab=content`);
    
    try {
        const response = await fetch(`${server.url}?tab=content`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; MCPfinder/1.0)'
            }
        });
        
        if (!response.ok) {
            console.log(`   ❌ HTTP ${response.status}`);
            return null;
        }
        
        const html = await response.text();
        
        // Look for configuration patterns
        const configMatches = [
            // Standard JSON config
            html.match(/\{[\s\S]*?"mcpServers"[\s\S]*?\}/),
            // NPX pattern
            html.match(/npx\s+([a-zA-Z0-9@/_-]+)/),
            // UVX pattern  
            html.match(/uvx\s+([a-zA-Z0-9@/_-]+)/),
            // npm install pattern
            html.match(/npm\s+install\s+-g\s+([a-zA-Z0-9@/_-]+)/)
        ];
        
        for (const match of configMatches) {
            if (match) {
                console.log(`   ✅ Found config pattern`);
                console.log(`   📄 ${match[0].slice(0, 100)}...`);
                
                if (match[1]) {
                    console.log(`   📦 Package: ${match[1]}`);
                    return {
                        server: server.name,
                        package: match[1],
                        command: match[0].includes('uvx') ? 'uvx' : 'npx',
                        url: server.url
                    };
                }
            }
        }
        
        console.log(`   ⚠️ No clear config found`);
        return null;
        
    } catch (error) {
        console.log(`   ❌ Error: ${error.message}`);
        return null;
    }
}

async function main() {
    console.log('🧪 Testing known MCP.so servers...');
    
    const results = [];
    
    for (const server of knownServers) {
        const result = await testServer(server);
        if (result) {
            results.push(result);
        }
        
        // Delay between requests
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('\n📊 Summary:');
    console.log(`   Tested: ${knownServers.length}`);
    console.log(`   Viable: ${results.length}`);
    
    console.log('\n✅ Viable servers found:');
    results.forEach(r => {
        console.log(`   - ${r.command} ${r.package} (${r.server})`);
    });
}

main().catch(console.error);