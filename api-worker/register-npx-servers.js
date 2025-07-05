const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');

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

async function registerNpxServer(packageName, serverName) {
    try {
        const registerCommand = `node ../mcpfinder-server/index.js register "${packageName}" --headless --description "${serverName} MCP server"`;
        
        console.log(`📦 Registering: ${packageName}`);
        
        const { stdout, stderr } = await execAsync(registerCommand, {
            cwd: __dirname,
            env: { ...process.env },
            timeout: 45000 // 45 second timeout
        });
        
        // Check if successfully registered
        if (stdout.includes('Successfully registered!')) {
            return { success: true, message: 'Registered successfully' };
        } else if (stdout.includes('Already registered')) {
            return { success: true, message: 'Already registered' };
        } else if (stdout.includes('unverified')) {
            return { success: true, message: 'Registered (unverified)' };
        } else {
            return { success: false, error: 'Unknown registration result', stdout };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function main() {
    console.log('🚀 Starting NPX Server Registration\n');
    
    try {
        // Read the JSON file
        const jsonPath = path.join(__dirname, '../cli/urls_mcp_servers_results.json');
        const data = await fs.readFile(jsonPath, 'utf-8');
        const servers = JSON.parse(data);
        
        // Filter NPX servers that haven't been processed
        const npxServers = Object.entries(servers).filter(([name, data]) => {
            if (typeof data !== 'object' || !data) return false;
            
            // Check if it's an npx server
            if (data.command !== 'npx' || !data.args || data.args.length === 0) return false;
            
            // Include if processed is null, undefined, or 0
            return !data.processed || data.processed === 0;
        });
        
        console.log(`📊 Found ${npxServers.length} unprocessed NPX servers\n`);
        
        const results = {
            total: npxServers.length,
            successful: 0,
            failed: 0,
            skipped: 0,
            details: []
        };
        
        // Process servers one by one with rate limiting
        for (let i = 0; i < npxServers.length; i++) {
            const [serverName, serverData] = npxServers[i];
            
            console.log(`\n[${i+1}/${npxServers.length}] Processing: ${serverName}`);
            
            const packageName = cleanNpxPackageName(serverData.args);
            if (!packageName) {
                console.log('   ⏩ Skipped: Could not determine package name');
                results.skipped++;
                results.details.push({
                    name: serverName,
                    status: 'skipped',
                    reason: 'Could not determine package name'
                });
                continue;
            }
            
            const result = await registerNpxServer(packageName, serverName);
            
            if (result.success) {
                console.log(`   ✅ ${result.message}`);
                results.successful++;
                results.details.push({
                    name: serverName,
                    package: packageName,
                    status: 'success',
                    message: result.message
                });
            } else {
                console.log(`   ❌ Failed: ${result.error}`);
                results.failed++;
                results.details.push({
                    name: serverName,
                    package: packageName,
                    status: 'failed',
                    error: result.error
                });
            }
            
            // Rate limiting - wait 2 seconds between registrations
            if (i < npxServers.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            // Show progress every 10 servers
            if ((i + 1) % 10 === 0) {
                console.log(`\n📊 Progress: ${i+1}/${npxServers.length} (Success: ${results.successful}, Failed: ${results.failed}, Skipped: ${results.skipped})`);
            }
        }
        
        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 NPX REGISTRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total NPX servers: ${results.total}`);
        console.log(`✅ Successfully registered: ${results.successful}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log(`⏩ Skipped: ${results.skipped}`);
        console.log('='.repeat(60));
        
        // Save results
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsPath = path.join(__dirname, `npx-registration-results-${timestamp}.json`);
        await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
        console.log(`\n📁 Results saved to: ${resultsPath}`);
        
        // Show some successful registrations
        const successes = results.details.filter(d => d.status === 'success').slice(0, 5);
        if (successes.length > 0) {
            console.log('\n✅ Sample successful registrations:');
            successes.forEach(s => {
                console.log(`   - ${s.name} (${s.package})`);
            });
        }
        
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Run the script
main().catch(console.error);