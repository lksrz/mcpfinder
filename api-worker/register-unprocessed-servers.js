const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');

// Special handling for uvx packages that need cleanup
function cleanPackageName(command, args) {
    if (command === 'uvx' && args && args.length > 0) {
        let packageName = args[0];
        
        // Handle special flags
        if (packageName === '--from' && args.length > 1) {
            // e.g., dify-mcp-server: ["--from", "git+https://..."]
            return null; // Skip git URLs for now
        }
        if (packageName === '--python=3.10' || packageName === '--python=3.12') {
            // e.g., mcp-local-rag, snowflake_pip
            return args.length > 1 ? args[1] : null;
        }
        if (packageName === '-n' && args.length > 1) {
            // e.g., meilisearch
            return args[1];
        }
        
        // Clean up package names with @ versions
        packageName = packageName.replace(/@latest$/, '');
        
        return packageName;
    }
    return null;
}

async function registerServer(serverData, serverName) {
    try {
        let registerCommand;
        
        // Build the registration command based on the server type
        if (serverData.url) {
            // Skip localhost URLs
            if (serverData.url.includes('localhost') || serverData.url.includes('127.0.0.1')) {
                return { success: false, error: 'Skipping localhost URL' };
            }
            
            // For URLs, pass the URL as the package name in headless mode
            registerCommand = `node ../mcpfinder-server/index.js register "${serverData.url}" --headless --description "${serverName} MCP server"`;
        } else if (serverData.command === 'uvx' && serverData.args) {
            const packageName = cleanPackageName(serverData.command, serverData.args);
            if (!packageName) {
                return { success: false, error: 'Could not determine package name or git URL' };
            }
            // For PyPI packages, use headless mode with --use-uvx flag
            registerCommand = `node ../mcpfinder-server/index.js register "${packageName}" --headless --use-uvx --description "Python MCP server"`;
        } else {
            return { success: false, error: 'No valid registration method found' };
        }
        
        console.log(`Executing: ${registerCommand}`);
        const { stdout, stderr } = await execAsync(registerCommand, {
            cwd: __dirname,
            env: { ...process.env },
            timeout: 30000 // 30 second timeout
        });
        
        return { success: true, stdout, stderr };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function main() {
    console.log('🚀 Starting MCP Server Registration for Unprocessed Servers\n');
    
    try {
        // Read the JSON file
        const jsonPath = path.join(__dirname, '../cli/urls_mcp_servers_results.json');
        const data = await fs.readFile(jsonPath, 'utf-8');
        const servers = JSON.parse(data);
        
        // Filter unprocessed servers with url or uvx
        const serversToRegister = Object.entries(servers).filter(([name, data]) => {
            if (typeof data !== 'object' || !data) return false;
            
            // Skip if already processed
            if (data.processed && data.processed > 0) return false;
            
            return data.url || 
                   (data.command === 'uvx' && data.args && data.args.length > 0);
        });
        
        console.log(`Found ${serversToRegister.length} unprocessed servers to register\n`);
        
        const results = {
            total: serversToRegister.length,
            successful: 0,
            failed: 0,
            skipped: 0,
            details: []
        };
        
        // Add confirmation prompt
        console.log('Servers to register:');
        serversToRegister.forEach(([name, data]) => {
            if (data.url) {
                console.log(`  - ${name}: URL ${data.url}`);
            } else if (data.command === 'uvx') {
                console.log(`  - ${name}: PyPI ${data.args.join(' ')}`);
            }
        });
        console.log('\nPress Enter to continue or Ctrl+C to cancel...');
        await new Promise(resolve => {
            process.stdin.once('data', resolve);
        });
        
        // Process each server
        for (const [serverName, serverData] of serversToRegister) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`Processing: ${serverName}`);
            console.log(`${'='.repeat(60)}`);
            
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
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 REGISTRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total servers attempted: ${results.total}`);
        console.log(`✅ Successfully registered: ${results.successful}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log(`⏩ Skipped: ${results.skipped}`);
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