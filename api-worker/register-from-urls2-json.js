const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');

async function registerServer(serverData, serverName) {
    try {
        let packageOrUrl;
        let useUvx = false;
        let description = `${serverName} MCP server`;
        let tags = [];
        let requiresApiKey = false;
        let keyNames = [];
        
        // Determine package/URL based on command type
        if (serverData.command === 'npx' && serverData.args && serverData.args.length > 0) {
            // NPX servers - extract package name, skip -y flag
            const args = serverData.args.filter(arg => arg !== '-y');
            if (args.length === 0) {
                // If only -y was present, try to guess package name from server name
                packageOrUrl = serverName.toLowerCase().replace(/[\s_]/g, '-') + '-mcp';
            } else {
                packageOrUrl = args[0].replace('@latest', ''); // Remove @latest if present
            }
        } else if (serverData.command === 'uvx' && serverData.args && serverData.args.length > 0) {
            // UVX servers - extract package name
            const args = serverData.args.filter(arg => !arg.startsWith('--'));
            if (args.length === 0) {
                return { success: false, error: 'No package name found in uvx args' };
            }
            packageOrUrl = args[0];
            useUvx = true;
        } else if (serverData.command === 'docker') {
            // Skip Docker-based servers
            return { success: false, error: 'Docker-based servers not supported for automatic registration' };
        } else if (serverData.command === 'node' || serverData.command === 'uv') {
            // Skip local file-based servers
            return { success: false, error: 'Local file-based servers not supported for automatic registration' };
        } else {
            return { success: false, error: 'Unsupported command type: ' + serverData.command };
        }
        
        // Check for environment variables (API keys)
        if (serverData.env) {
            const apiKeyVars = Object.keys(serverData.env).filter(key => 
                key.includes('API_KEY') || key.includes('TOKEN') || key.includes('SECRET')
            );
            if (apiKeyVars.length > 0) {
                requiresApiKey = true;
                keyNames = apiKeyVars;
            }
        }
        
        // Build registration command
        let registerCommand = `node ../mcpfinder-server/index.js register "${packageOrUrl}" --headless`;
        registerCommand += ` --description "${description}"`;
        
        if (useUvx) {
            // Skip uvx servers for now since uvx is not available
            return { success: false, error: 'Skipping uvx-based server (uvx not available)' };
            // registerCommand += ` --use-uvx`;
        }
        
        if (requiresApiKey) {
            registerCommand += ` --requires-api-key`;
            if (keyNames.length > 0) {
                registerCommand += ` --key-name "${keyNames[0]}"`;
            }
        }
        
        // Add default tags based on server name
        if (serverName.includes('cloud')) tags.push('cloud');
        if (serverName.includes('file') || serverName.includes('fs')) tags.push('filesystem');
        if (serverName.includes('data')) tags.push('data');
        if (serverName.includes('ai') || serverName.includes('llm')) tags.push('ai');
        
        if (tags.length > 0) {
            registerCommand += ` --tags "${tags.join(',')}"`;
        }
        
        console.log(`Executing: ${registerCommand}`);
        const { stdout, stderr } = await execAsync(registerCommand, {
            cwd: __dirname,
            env: { ...process.env },
            timeout: 60000 // 60 second timeout
        });
        
        return { success: true, stdout, stderr };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function main() {
    console.log('🚀 Starting MCP Server Registration from urls_mcp_servers2.json\n');
    
    try {
        // Read the JSON file
        const jsonPath = path.join(__dirname, '../cli/urls_mcp_servers2.json');
        const data = await fs.readFile(jsonPath, 'utf-8');
        const servers = JSON.parse(data);
        
        // Filter servers that can be registered
        const serversToRegister = Object.entries(servers).filter(([name, data]) => {
            if (typeof data !== 'object' || !data) return false;
            
            // Only npx and uvx servers can be auto-registered
            return (data.command === 'npx' && data.args && data.args.length > 0) ||
                   (data.command === 'uvx' && data.args && data.args.length > 0);
        });
        
        console.log(`Found ${serversToRegister.length} servers to register\n`);
        console.log('Servers to register:');
        serversToRegister.forEach(([name, data]) => {
            console.log(`  - ${name}: ${data.command} ${data.args ? data.args[0] : 'unknown'}`);
        });
        
        const results = {
            total: serversToRegister.length,
            successful: 0,
            failed: 0,
            details: []
        };
        
        console.log('\nStarting registration...\n');
        
        // Process each server
        for (const [serverName, serverData] of serversToRegister) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`Processing: ${serverName}`);
            console.log(`Command: ${serverData.command} ${serverData.args ? serverData.args.join(' ') : ''}`);
            console.log(`${'='.repeat(60)}`);
            
            const result = await registerServer(serverData, serverName);
            
            if (result.success) {
                console.log(`✅ Successfully registered ${serverName}`);
                results.successful++;
                results.details.push({
                    name: serverName,
                    command: serverData.command,
                    package: serverData.args ? serverData.args[0] : 'unknown',
                    status: 'success'
                });
            } else {
                console.log(`❌ Failed to register ${serverName}`);
                console.log(`Error: ${result.error}`);
                results.failed++;
                results.details.push({
                    name: serverName,
                    command: serverData.command,
                    package: serverData.args ? serverData.args[0] : 'unknown',
                    status: 'failed',
                    error: result.error
                });
            }
            
            // Rate limiting - wait between registrations
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 REGISTRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total servers attempted: ${results.total}`);
        console.log(`✅ Successfully registered: ${results.successful}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log('='.repeat(60));
        
        if (results.failed > 0) {
            console.log('\nFailed registrations:');
            results.details.filter(d => d.status === 'failed').forEach(d => {
                console.log(`  - ${d.name}: ${d.error}`);
            });
        }
        
        // Save results to file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsPath = path.join(__dirname, `urls2-registration-results-${timestamp}.json`);
        await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
        console.log(`\n📁 Results saved to: ${resultsPath}`);
        
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Run the script
main().catch(console.error);