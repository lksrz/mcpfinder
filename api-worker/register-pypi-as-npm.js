const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');

// List of known PyPI packages that are also available on npm
const knownNpmPackages = [
    'calculator', // mcp-server-calculator
    'basic-memory',
    'mcp-server-monday',
    // Add more as we discover them
];

// Special handling for uvx packages that need cleanup
function cleanPackageName(args) {
    if (!args || args.length === 0) return null;
    
    let packageName = args[0];
    
    // Handle special flags
    if (packageName === '--from' && args.length > 1) {
        // e.g., dify-mcp-server: ["--from", "git+https://..."]
        return null; // Skip git URLs
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

async function checkNpmPackage(packageName) {
    try {
        const { stdout } = await execAsync(`npm view ${packageName} name`, {
            timeout: 10000
        });
        return stdout.trim() === packageName;
    } catch (error) {
        return false;
    }
}

async function registerAsNpm(packageName, serverName) {
    try {
        // Try registering as npm package
        const registerCommand = `node ../mcpfinder-server/index.js register "${packageName}" --headless --description "${serverName} MCP server"`;
        
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
    console.log('🚀 Starting MCP Server Registration for PyPI packages as NPM\n');
    
    try {
        // Read the JSON file
        const jsonPath = path.join(__dirname, '../cli/urls_mcp_servers_results.json');
        const data = await fs.readFile(jsonPath, 'utf-8');
        const servers = JSON.parse(data);
        
        // Filter unprocessed PyPI servers
        const pypiServers = Object.entries(servers).filter(([name, data]) => {
            if (typeof data !== 'object' || !data) return false;
            
            // Skip if already processed
            if (data.processed && data.processed > 0) return false;
            
            // Only uvx servers
            return data.command === 'uvx' && data.args && data.args.length > 0;
        });
        
        console.log(`Found ${pypiServers.length} PyPI servers\n`);
        console.log('Checking which ones might be available on npm...\n');
        
        const results = {
            total: pypiServers.length,
            npmAvailable: 0,
            successful: 0,
            failed: 0,
            skipped: 0,
            details: []
        };
        
        // Check each server
        const serversToRegister = [];
        
        for (const [serverName, serverData] of pypiServers) {
            const packageName = cleanPackageName(serverData.args);
            
            if (!packageName) {
                console.log(`⏩ ${serverName}: Skipping (git URL or invalid package)`);
                results.skipped++;
                continue;
            }
            
            // Check if it's in our known list or available on npm
            process.stdout.write(`Checking ${serverName} (${packageName})... `);
            
            const isKnown = knownNpmPackages.some(known => 
                packageName.includes(known) || known.includes(packageName)
            );
            
            if (isKnown) {
                console.log('✅ Known npm package');
                serversToRegister.push({ serverName, packageName, reason: 'known' });
                results.npmAvailable++;
            } else {
                const isOnNpm = await checkNpmPackage(packageName);
                if (isOnNpm) {
                    console.log('✅ Found on npm');
                    serversToRegister.push({ serverName, packageName, reason: 'found' });
                    results.npmAvailable++;
                } else {
                    console.log('❌ Not found on npm');
                }
            }
            
            // Rate limit checks
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        console.log(`\n\n📊 Found ${serversToRegister.length} packages available on npm\n`);
        
        if (serversToRegister.length === 0) {
            console.log('No PyPI packages found on npm to register.');
            return;
        }
        
        // Show what we'll register
        console.log('Packages to register via npm:');
        serversToRegister.forEach(({ serverName, packageName, reason }) => {
            console.log(`  - ${serverName}: ${packageName} (${reason})`);
        });
        
        console.log('\nStarting registration...\n');
        
        // Process each server
        for (const { serverName, packageName } of serversToRegister) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`Processing: ${serverName}`);
            console.log(`Package: ${packageName}`);
            console.log(`${'='.repeat(60)}`);
            
            const result = await registerAsNpm(packageName, serverName);
            
            if (result.success) {
                console.log(`✅ Successfully registered ${serverName}`);
                results.successful++;
                results.details.push({
                    name: serverName,
                    package: packageName,
                    status: 'success'
                });
            } else {
                console.log(`❌ Failed to register ${serverName}`);
                console.log(`Error: ${result.error}`);
                results.failed++;
                results.details.push({
                    name: serverName,
                    package: packageName,
                    status: 'failed',
                    error: result.error
                });
            }
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 REGISTRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total PyPI servers: ${results.total}`);
        console.log(`Found on npm: ${results.npmAvailable}`);
        console.log(`✅ Successfully registered: ${results.successful}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log(`⏩ Skipped: ${results.skipped}`);
        console.log('='.repeat(60));
        
        // Save results
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsPath = path.join(__dirname, `pypi-npm-registration-results-${timestamp}.json`);
        await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
        console.log(`\n📁 Results saved to: ${resultsPath}`);
        
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Run the script
main().catch(console.error);