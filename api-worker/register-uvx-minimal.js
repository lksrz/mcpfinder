const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');

// Parse UVX package name from args
function parseUvxPackage(args) {
    if (!args || args.length === 0) return null;
    
    let packageName = args[0];
    
    // Handle special cases
    if (packageName === '--from') {
        // Skip git URLs
        if (args[1] && args[1].includes('git+')) return null;
        // Otherwise take the package after --from
        return args[1] || null;
    }
    
    if (packageName.startsWith('--python=')) {
        // Take the next argument
        return args[1] || null;
    }
    
    if (packageName === '-n' && args.length > 1) {
        return args[1];
    }
    
    // Skip paths and executables
    if (packageName.includes('/') || packageName.includes('.exe')) {
        return null;
    }
    
    // Clean up versions
    packageName = packageName.replace(/@latest$/, '');
    
    // Extract just the package name if there are additional arguments
    if (packageName && !packageName.startsWith('-')) {
        return packageName;
    }
    
    return null;
}

async function registerUvxMinimal(packageName, serverName) {
    try {
        // Register with minimal info, marked as Python package
        const registerCommand = `node ../mcpfinder-server/index.js register "${packageName}" --headless --description "${serverName} - Python MCP server (requires uvx)" --tags "python,uvx"`;
        
        console.log(`📦 Registering: ${packageName}`);
        
        const { stdout, stderr } = await execAsync(registerCommand, {
            cwd: __dirname,
            env: { ...process.env },
            timeout: 45000
        });
        
        // Check result
        if (stdout.includes('Successfully registered') || stdout.includes('unverified')) {
            return { success: true, message: 'Registered successfully' };
        } else if (stdout.includes('already exists') || stdout.includes('Already registered')) {
            return { success: true, message: 'Already exists' };
        } else {
            return { success: false, error: 'Unknown result', stdout };
        }
    } catch (error) {
        // If it fails due to inability to connect (no uvx), try minimal registration
        if (error.message.includes('uvx ENOENT') || error.message.includes('Cannot connect')) {
            console.log('   ⚠️  Cannot introspect (uvx not available), attempting minimal registration...');
            
            try {
                // Try again without uvx flag, just as a package name
                const minimalCommand = `node ../mcpfinder-server/index.js register "${packageName}" --headless --description "${serverName} - Python MCP server" --tags "python"`;
                
                const { stdout } = await execAsync(minimalCommand, {
                    cwd: __dirname,
                    env: { ...process.env },
                    timeout: 30000
                });
                
                if (stdout.includes('registered') || stdout.includes('exists')) {
                    return { success: true, message: 'Registered with minimal info' };
                }
            } catch (minimalError) {
                return { success: false, error: `Failed minimal registration: ${minimalError.message}` };
            }
        }
        
        return { success: false, error: error.message };
    }
}

async function main() {
    console.log('🚀 Starting UVX Server Registration (Minimal Mode)\n');
    
    try {
        // Load unprocessed servers
        const unprocessedPath = path.join(__dirname, 'unprocessed-servers.json');
        const unprocessedData = await fs.readFile(unprocessedPath, 'utf-8');
        const unprocessed = JSON.parse(unprocessedData);
        
        const uvxServers = unprocessed.uvx;
        console.log(`📊 Found ${uvxServers.length} UVX servers to register\n`);
        
        const results = {
            total: uvxServers.length,
            successful: 0,
            failed: 0,
            skipped: 0,
            details: []
        };
        
        // Process each server
        for (let i = 0; i < uvxServers.length; i++) {
            const server = uvxServers[i];
            console.log(`\n[${i+1}/${uvxServers.length}] Processing: ${server.name}`);
            console.log(`   Args: ${server.args.join(' ')}`);
            
            const packageName = parseUvxPackage(server.args);
            
            if (!packageName) {
                console.log('   ⏩ Skipped: Could not parse package name');
                results.skipped++;
                results.details.push({
                    name: server.name,
                    status: 'skipped',
                    reason: 'Could not parse package name',
                    args: server.args
                });
                continue;
            }
            
            console.log(`   Package: ${packageName}`);
            
            const result = await registerUvxMinimal(packageName, server.name);
            
            if (result.success) {
                console.log(`   ✅ ${result.message}`);
                results.successful++;
                results.details.push({
                    name: server.name,
                    package: packageName,
                    status: 'success',
                    message: result.message
                });
            } else {
                console.log(`   ❌ Failed: ${result.error}`);
                results.failed++;
                results.details.push({
                    name: server.name,
                    package: packageName,
                    status: 'failed',
                    error: result.error
                });
            }
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Progress update every 10
            if ((i + 1) % 10 === 0) {
                console.log(`\n📊 Progress: ${i+1}/${uvxServers.length} (Success: ${results.successful}, Failed: ${results.failed}, Skipped: ${results.skipped})`);
            }
        }
        
        // Summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 UVX REGISTRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total UVX servers: ${results.total}`);
        console.log(`✅ Successfully registered: ${results.successful}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log(`⏩ Skipped: ${results.skipped}`);
        console.log('='.repeat(60));
        
        // Save results
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsPath = path.join(__dirname, `uvx-registration-results-${timestamp}.json`);
        await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
        console.log(`\n📁 Results saved to: ${resultsPath}`);
        
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

main().catch(console.error);