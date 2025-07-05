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

// Clean NPX package names
function cleanNpxPackageName(args) {
    if (!args || args.length === 0) return null;
    
    let packageName = args[0];
    
    // Skip -y flag
    if (packageName === '-y' && args.length > 1) {
        packageName = args[1];
    }
    
    // Clean up versions
    packageName = packageName.replace(/@latest$/, '');
    
    return packageName;
}

async function registerServer(serverData, serverName) {
    let packageInfo = 'unknown';
    
    try {
        let registerCommand;
        
        // Build the registration command based on the server type
        if (serverData.url) {
            // Skip localhost URLs
            if (serverData.url.includes('localhost') || serverData.url.includes('127.0.0.1')) {
                return { success: false, error: 'Skipping localhost URL', skipped: true, packageInfo };
            }
            
            // For URLs, pass the URL as the package name in headless mode
            registerCommand = `node ../mcpfinder-server/index.js register "${serverData.url}" --headless --description "${serverName} MCP server"`;
            packageInfo = serverData.url;
        } else if (serverData.command === 'uvx' && serverData.args) {
            const packageName = cleanPackageName(serverData.command, serverData.args);
            if (!packageName) {
                return { success: false, error: 'Could not determine package name or git URL', skipped: true, packageInfo };
            }
            // For PyPI packages, use headless mode with --use-uvx flag
            registerCommand = `node ../mcpfinder-server/index.js register "${packageName}" --headless --use-uvx --description "${serverName} Python MCP server"`;
            packageInfo = `uvx ${packageName}`;
        } else if (serverData.command === 'npx' && serverData.args) {
            const packageName = cleanNpxPackageName(serverData.args);
            if (!packageName) {
                return { success: false, error: 'Could not determine package name', skipped: true, packageInfo };
            }
            // For NPX packages
            registerCommand = `node ../mcpfinder-server/index.js register "${packageName}" --headless --description "${serverName} MCP server"`;
            packageInfo = `npx ${packageName}`;
        } else {
            return { success: false, error: 'No valid registration method found', skipped: true, packageInfo };
        }
        
        console.log(`📦 ${packageInfo}`);
        console.log(`   Command: ${registerCommand}`);
        
        const { stdout, stderr } = await execAsync(registerCommand, {
            cwd: __dirname,
            env: { ...process.env },
            timeout: 60000 // 60 second timeout
        });
        
        // Check if successfully registered
        if (stdout.includes('Successfully registered!') || stdout.includes('Already registered')) {
            return { success: true, stdout, stderr, packageInfo };
        } else {
            return { success: false, error: 'Registration may have failed', stdout, stderr, packageInfo };
        }
    } catch (error) {
        return { success: false, error: error.message, packageInfo: packageInfo || 'unknown' };
    }
}

async function main() {
    console.log('🚀 Starting Comprehensive MCP Server Registration\n');
    
    try {
        // Read the JSON file
        const jsonPath = path.join(__dirname, '../cli/urls_mcp_servers_results.json');
        const data = await fs.readFile(jsonPath, 'utf-8');
        const servers = JSON.parse(data);
        
        // Filter servers to register (npx, uvx, and url)
        const serversToRegister = Object.entries(servers).filter(([name, data]) => {
            if (typeof data !== 'object' || !data) return false;
            
            // Skip if already processed
            if (data.processed && data.processed > 0) return false;
            
            return data.url || 
                   (data.command === 'npx' && data.args && data.args.length > 0) ||
                   (data.command === 'uvx' && data.args && data.args.length > 0);
        });
        
        // Group by type
        const byType = {
            npx: serversToRegister.filter(([_, d]) => d.command === 'npx'),
            uvx: serversToRegister.filter(([_, d]) => d.command === 'uvx'),
            url: serversToRegister.filter(([_, d]) => d.url)
        };
        
        console.log(`📊 Servers to Register:`);
        console.log(`   NPX: ${byType.npx.length}`);
        console.log(`   UVX: ${byType.uvx.length}`);
        console.log(`   URL: ${byType.url.length}`);
        console.log(`   Total: ${serversToRegister.length}\n`);
        
        const results = {
            total: serversToRegister.length,
            successful: 0,
            failed: 0,
            skipped: 0,
            details: []
        };
        
        // Process in batches to avoid overwhelming the system
        const BATCH_SIZE = 5;
        const BATCH_DELAY = 5000; // 5 seconds between batches
        
        for (let i = 0; i < serversToRegister.length; i += BATCH_SIZE) {
            const batch = serversToRegister.slice(i, i + BATCH_SIZE);
            console.log(`\n${'='.repeat(60)}`);
            console.log(`📦 Processing batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(serversToRegister.length/BATCH_SIZE)}`);
            console.log(`${'='.repeat(60)}\n`);
            
            // Process batch in parallel
            const batchPromises = batch.map(async ([serverName, serverData]) => {
                console.log(`\n🔄 Processing: ${serverName}`);
                const result = await registerServer(serverData, serverName);
                
                if (result.skipped) {
                    console.log(`   ⏩ Skipped: ${result.error}`);
                    results.skipped++;
                } else if (result.success) {
                    console.log(`   ✅ Success!`);
                    results.successful++;
                } else {
                    console.log(`   ❌ Failed: ${result.error}`);
                    results.failed++;
                }
                
                results.details.push({
                    name: serverName,
                    type: serverData.command || 'url',
                    status: result.skipped ? 'skipped' : (result.success ? 'success' : 'failed'),
                    error: result.error,
                    package: result.packageInfo
                });
                
                return result;
            });
            
            await Promise.all(batchPromises);
            
            // Delay between batches (except for last batch)
            if (i + BATCH_SIZE < serversToRegister.length) {
                console.log(`\n⏳ Waiting ${BATCH_DELAY/1000} seconds before next batch...`);
                await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
            }
        }
        
        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 REGISTRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total servers attempted: ${results.total}`);
        console.log(`✅ Successfully registered: ${results.successful}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log(`⏩ Skipped: ${results.skipped}`);
        
        // Show breakdown by type
        const successByType = {
            npx: results.details.filter(d => d.type === 'npx' && d.status === 'success').length,
            uvx: results.details.filter(d => d.type === 'uvx' && d.status === 'success').length,
            url: results.details.filter(d => d.type === 'url' && d.status === 'success').length
        };
        
        console.log(`\nSuccess by type:`);
        console.log(`   NPX: ${successByType.npx}`);
        console.log(`   UVX: ${successByType.uvx}`);
        console.log(`   URL: ${successByType.url}`);
        console.log('='.repeat(60));
        
        // Save results to file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsPath = path.join(__dirname, `all-servers-registration-results-${timestamp}.json`);
        await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
        console.log(`\n📁 Results saved to: ${resultsPath}`);
        
        // Save a summary of failed registrations for review
        const failed = results.details.filter(d => d.status === 'failed');
        if (failed.length > 0) {
            const failedPath = path.join(__dirname, `failed-registrations-${timestamp}.json`);
            await fs.writeFile(failedPath, JSON.stringify(failed, null, 2));
            console.log(`📁 Failed registrations saved to: ${failedPath}`);
        }
        
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Run the script
main().catch(console.error);