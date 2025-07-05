const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');

async function registerServer(serverData, serverName) {
    try {
        let registerCommand;
        
        // Build the registration command based on the server type
        if (serverData.url) {
            // For servers with URL field
            registerCommand = `node ../mcpfinder-server/index.js register --url="${serverData.url}"`;
            if (serverName) {
                registerCommand += ` --name="${serverName}"`;
            }
        } else if (serverData.command === 'npx' && serverData.args && serverData.args.length > 0) {
            // For NPX servers
            const packageName = serverData.args[0].replace(/-y\s+/, '').trim();
            registerCommand = `node ../mcpfinder-server/index.js register --npm="${packageName}"`;
        } else if (serverData.command === 'uvx' && serverData.args && serverData.args.length > 0) {
            // For UVX servers
            const packageName = serverData.args[0].trim();
            registerCommand = `node ../mcpfinder-server/index.js register --pypi="${packageName}"`;
        } else {
            return { success: false, error: 'No valid registration method found' };
        }
        
        console.log(`Executing: ${registerCommand}`);
        const { stdout, stderr } = await execAsync(registerCommand, {
            cwd: __dirname,
            env: { ...process.env }
        });
        
        return { success: true, stdout, stderr };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function main() {
    console.log('🚀 Starting MCP Server Registration from urls_mcp_servers_results.json\n');
    
    try {
        // Read the JSON file
        const jsonPath = path.join(__dirname, '../cli/urls_mcp_servers_results.json');
        const data = await fs.readFile(jsonPath, 'utf-8');
        const servers = JSON.parse(data);
        
        // Filter servers with url, uvx, or npx
        const serversToRegister = Object.entries(servers).filter(([name, data]) => {
            if (typeof data !== 'object' || !data) return false;
            
            return data.url || 
                   (data.command === 'npx' && data.args && data.args.length > 0) ||
                   (data.command === 'uvx' && data.args && data.args.length > 0);
        });
        
        console.log(`Found ${serversToRegister.length} servers to register\n`);
        
        const results = {
            total: serversToRegister.length,
            successful: 0,
            failed: 0,
            skipped: 0,
            details: []
        };
        
        // Process each server
        for (const [serverName, serverData] of serversToRegister) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`Processing: ${serverName}`);
            console.log(`${'='.repeat(60)}`);
            
            // Skip if already processed (check processed field)
            if (serverData.processed && serverData.processed > 0) {
                console.log(`⏩ Skipping ${serverName} - already processed`);
                results.skipped++;
                results.details.push({
                    name: serverName,
                    status: 'skipped',
                    reason: 'already processed'
                });
                continue;
            }
            
            const result = await registerServer(serverData, serverName);
            
            if (result.success) {
                console.log(`✅ Successfully registered ${serverName}`);
                if (result.stdout) console.log(`Output: ${result.stdout}`);
                results.successful++;
                results.details.push({
                    name: serverName,
                    status: 'success',
                    output: result.stdout
                });
            } else {
                console.log(`❌ Failed to register ${serverName}`);
                console.log(`Error: ${result.error}`);
                results.failed++;
                results.details.push({
                    name: serverName,
                    status: 'failed',
                    error: result.error
                });
            }
            
            // Rate limiting - wait between registrations
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 REGISTRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total servers found: ${results.total}`);
        console.log(`✅ Successfully registered: ${results.successful}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log(`⏩ Skipped (already processed): ${results.skipped}`);
        console.log('='.repeat(60));
        
        // Save results to file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsPath = path.join(__dirname, `registration-results-${timestamp}.json`);
        await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
        console.log(`\n📁 Results saved to: ${resultsPath}`);
        
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Run the script
main().catch(console.error);