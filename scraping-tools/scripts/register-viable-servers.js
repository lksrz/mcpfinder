#!/usr/bin/env node

/**
 * Register viable MCP servers from scraped data
 */

import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function registerViableServers() {
    console.log('🚀 Processing viable MCP servers for registration...\n');
    
    // Load the scraped configs
    const configsData = await fs.readFile('data/mcp-so-configs-final.json', 'utf-8');
    const servers = JSON.parse(configsData);
    
    // Filter out servers with invalid package names
    const viableServers = servers.filter(server => {
        const config = server.config?.mcpServers?.server;
        if (!config) return false;
        
        const command = config.command;
        const packageName = config.args?.[0];
        
        // Skip if no package name or contains Chinese text
        if (!packageName || packageName.includes('可执行文件') || packageName.includes('添加到系统的')) {
            return false;
        }
        
        // Skip generic packages that aren't real MCP servers
        if (packageName === 'tool' || packageName === 'install' || packageName === '-y') {
            return false;
        }
        
        // Only accept npx or uvx commands
        if (command !== 'npx' && command !== 'uvx') {
            return false;
        }
        
        return true;
    });
    
    console.log(`📊 Found ${viableServers.length} potentially viable servers out of ${servers.length}\n`);
    
    // Extract clean server data
    const cleanServers = viableServers.map(server => {
        const config = server.config.mcpServers.server;
        const packageName = config.args[0].split(/[\s\\r\\n]/)[0]; // Clean package name
        
        return {
            name: server.name.split('@')[0], // Remove author from name
            author: server.authorFromUrl,
            url: server.url,
            command: config.command,
            package: packageName,
            description: server.name.split('@')[1] || '', // Description after @
            tags: [config.command, 'mcp-so']
        };
    });
    
    // Show what we found
    console.log('🎯 Viable servers to register:\n');
    cleanServers.forEach(server => {
        console.log(`${server.command} ${server.package}`);
        console.log(`   Name: ${server.name}`);
        console.log(`   Author: ${server.author}`);
        console.log(`   URL: ${server.url}\n`);
    });
    
    // Save clean viable servers
    await fs.writeFile(
        'data/mcp-so-viable-clean.json',
        JSON.stringify(cleanServers, null, 2)
    );
    
    console.log(`✅ Saved ${cleanServers.length} clean viable servers to data/mcp-so-viable-clean.json`);
    
    // Generate registration commands
    console.log('\n📝 Registration commands:\n');
    const commands = cleanServers.map(server => {
        const useUvx = server.command === 'uvx' ? '--use-uvx' : '';
        const description = server.description ? `--description "${server.description.slice(0, 100)}"` : '';
        const tags = `--tags "${server.tags.join(',')}"`;
        
        return `node index.js register ${server.package} --headless ${useUvx} ${description} ${tags}`;
    });
    
    // Save commands to file
    await fs.writeFile(
        'scripts/register-commands.sh',
        '#!/bin/bash\n\n# Registration commands for viable MCP.so servers\n\n' + commands.join('\n\n') + '\n'
    );
    
    console.log('Commands saved to scripts/register-commands.sh');
    console.log('\nTo register all servers, run:');
    console.log('   chmod +x scripts/register-commands.sh');
    console.log('   ./scripts/register-commands.sh');
    
    // Show sample command
    if (commands.length > 0) {
        console.log('\nSample command:');
        console.log(`   ${commands[0]}`);
    }
}

registerViableServers().catch(console.error);