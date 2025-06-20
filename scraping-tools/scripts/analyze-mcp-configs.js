#!/usr/bin/env node

/**
 * Analyze the scraped MCP.so configurations
 */

import fs from 'fs/promises';

async function analyzeConfigs() {
    console.log('🔍 Analyzing MCP.so server configurations...\n');
    
    const data = await fs.readFile('data/mcp-so-configs-final.json', 'utf-8');
    const servers = JSON.parse(data);
    
    console.log(`📊 Total servers with configs: ${servers.length}`);
    
    // Categorize by command type
    const commands = {
        npx: [],
        uvx: [],
        http: [],
        node: [],
        python: [],
        docker: [],
        other: [],
        invalid: []
    };
    
    // Process each server
    for (const server of servers) {
        if (!server.config || !server.config.mcpServers) {
            commands.invalid.push(server);
            continue;
        }
        
        const serverConfigs = Object.values(server.config.mcpServers);
        for (const config of serverConfigs) {
            const command = config.command?.toLowerCase() || '';
            const args = config.args || [];
            
            // Clean up the config
            const cleanConfig = {
                name: server.name.split('@')[0], // Extract clean name
                author: server.authorFromUrl,
                url: server.url,
                command: config.command,
                args: args,
                package: null
            };
            
            // Extract package name from args
            if (command === 'npx' && args.length > 0) {
                cleanConfig.package = args[0].split(/[\s\\r\\n]/)[0]; // Clean first arg
                commands.npx.push(cleanConfig);
            } else if (command === 'uvx' && args.length > 0) {
                cleanConfig.package = args[0].split(/[\s\\r\\n]/)[0]; // Clean first arg
                commands.uvx.push(cleanConfig);
            } else if (command === 'http' || config.url) {
                cleanConfig.package = config.url || 'http-endpoint';
                commands.http.push(cleanConfig);
            } else if (command === 'node') {
                commands.node.push(cleanConfig);
            } else if (command === 'python' || command === 'python3') {
                commands.python.push(cleanConfig);
            } else if (command === 'docker') {
                commands.docker.push(cleanConfig);
            } else {
                commands.other.push(cleanConfig);
            }
        }
    }
    
    // Display results
    console.log('\n📦 NPX Packages:', commands.npx.length);
    commands.npx.slice(0, 10).forEach(s => {
        console.log(`   - ${s.package} (${s.name} by ${s.author})`);
    });
    if (commands.npx.length > 10) console.log(`   ... and ${commands.npx.length - 10} more`);
    
    console.log('\n🐍 UVX Packages:', commands.uvx.length);
    commands.uvx.slice(0, 10).forEach(s => {
        console.log(`   - ${s.package} (${s.name} by ${s.author})`);
    });
    if (commands.uvx.length > 10) console.log(`   ... and ${commands.uvx.length - 10} more`);
    
    console.log('\n🌐 HTTP Endpoints:', commands.http.length);
    commands.http.slice(0, 5).forEach(s => {
        console.log(`   - ${s.package} (${s.name})`);
    });
    if (commands.http.length > 5) console.log(`   ... and ${commands.http.length - 5} more`);
    
    console.log('\n📊 Other Commands:');
    console.log(`   Node.js: ${commands.node.length}`);
    console.log(`   Python: ${commands.python.length}`);
    console.log(`   Docker: ${commands.docker.length}`);
    console.log(`   Other: ${commands.other.length}`);
    console.log(`   Invalid: ${commands.invalid.length}`);
    
    // Save clean viable servers
    const viableServers = [
        ...commands.npx.map(s => ({ ...s, transport: 'stdio', viability: 'npx' })),
        ...commands.uvx.map(s => ({ ...s, transport: 'stdio', viability: 'uvx' })),
        ...commands.http.map(s => ({ ...s, transport: 'http', viability: 'http' }))
    ];
    
    await fs.writeFile(
        'data/mcp-so-viable-final.json', 
        JSON.stringify(viableServers, null, 2)
    );
    
    console.log(`\n✅ Saved ${viableServers.length} viable servers to data/mcp-so-viable-final.json`);
    
    // Extract unique package names for testing
    const uniquePackages = {
        npx: [...new Set(commands.npx.map(s => s.package).filter(p => p && !p.includes('添加到系统的')))],
        uvx: [...new Set(commands.uvx.map(s => s.package).filter(p => p && !p.includes('添加到系统的')))]
    };
    
    console.log('\n🎯 Unique viable packages:');
    console.log(`   NPX: ${uniquePackages.npx.length} packages`);
    console.log(`   UVX: ${uniquePackages.uvx.length} packages`);
    
    // Show sample clean packages
    console.log('\n📋 Sample NPX packages:');
    uniquePackages.npx.slice(0, 10).forEach(p => console.log(`   - ${p}`));
    
    console.log('\n📋 Sample UVX packages:');
    uniquePackages.uvx.slice(0, 10).forEach(p => console.log(`   - ${p}`));
    
    return viableServers;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    analyzeConfigs().catch(console.error);
}