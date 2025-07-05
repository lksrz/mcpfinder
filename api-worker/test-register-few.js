const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');

async function testRegister() {
    console.log('🧪 Testing Registration with a Few Servers\n');
    
    // Test cases
    const testServers = [
        {
            name: 'dappier',
            type: 'pypi',
            package: 'dappier-mcp'
        },
        {
            name: 'calculator',
            type: 'pypi', 
            package: 'mcp-server-calculator'
        },
        {
            name: 'amap',
            type: 'url',
            url: 'https://mcp.amap.com/sse?key=<YOUR_TOKEN>'
        },
        {
            name: 'apify',
            type: 'url',
            url: 'https://actors-mcp-server.apify.actor/sse'
        }
    ];
    
    for (const server of testServers) {
        console.log(`\n${'='.repeat(50)}`);
        console.log(`Testing: ${server.name} (${server.type})`);
        console.log(`${'='.repeat(50)}`);
        
        try {
            let command;
            if (server.type === 'pypi') {
                // For PyPI packages, use headless mode with --use-uvx flag
                command = `node ../mcpfinder-server/index.js register "${server.package}" --headless --use-uvx --description "Python MCP server"`;
            } else if (server.type === 'url') {
                // For URLs, pass the URL as the package name
                command = `node ../mcpfinder-server/index.js register "${server.url}" --headless --description "${server.name} MCP server"`;
            }
            
            console.log(`Command: ${command}`);
            
            const { stdout, stderr } = await execAsync(command, {
                cwd: __dirname,
                timeout: 30000
            });
            
            console.log('✅ Success!');
            if (stdout) console.log('Output:', stdout);
            if (stderr) console.log('Stderr:', stderr);
            
        } catch (error) {
            console.log('❌ Failed!');
            console.log('Error:', error.message);
        }
        
        // Wait between tests
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('\n✅ Test complete!');
}

testRegister().catch(console.error);