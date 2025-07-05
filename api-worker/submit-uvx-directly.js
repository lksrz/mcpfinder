const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Parse UVX package name from args
function parseUvxPackage(args) {
    if (!args || args.length === 0) return null;
    
    let packageName = args[0];
    
    // Handle special cases
    if (packageName === '--from') {
        if (args[1] && args[1].includes('git+')) return null;
        return args[1] || null;
    }
    
    if (packageName.startsWith('--python=')) {
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
    
    // Extract just the package name
    if (packageName && !packageName.startsWith('-')) {
        return packageName;
    }
    
    return null;
}

async function submitToAPI(manifest) {
    const API_URL = 'https://mcpfinder.dev/api/v1/register';
    
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'MCPfinder-BatchSubmit/1.0'
            },
            body: JSON.stringify(manifest)
        });
        
        const result = await response.json();
        
        if (!response.ok) {
            throw new Error(result.error || result.message || 'Registration failed');
        }
        
        return { success: true, result };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function main() {
    console.log('🚀 Direct UVX Server Submission to MCPfinder API\n');
    
    try {
        // Load unprocessed servers
        const unprocessedPath = path.join(__dirname, 'unprocessed-servers.json');
        const unprocessedData = await fs.readFile(unprocessedPath, 'utf-8');
        const unprocessed = JSON.parse(unprocessedData);
        
        const uvxServers = unprocessed.uvx;
        console.log(`📊 Found ${uvxServers.length} UVX servers to submit\n`);
        
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
            
            const packageName = parseUvxPackage(server.args);
            
            if (!packageName) {
                console.log('   ⏩ Skipped: Could not parse package name');
                results.skipped++;
                continue;
            }
            
            console.log(`   Package: ${packageName}`);
            
            // Create minimal manifest for Python/UVX package
            const manifest = {
                name: server.name,
                description: `${server.name} - Python MCP server installed via uvx`,
                url: `uvx://${packageName}`,
                protocol_version: 'MCP/1.0',
                capabilities: [
                    {
                        name: 'python-package',
                        type: 'tool',
                        description: 'This is a Python package that requires uvx to run'
                    }
                ],
                tags: ['python', 'uvx', 'unanalyzed'],
                manifest: {
                    transports: [{
                        type: 'stdio',
                        command: 'uvx',
                        args: packageName.split(' ')
                    }],
                    protocol_version: 'MCP/1.0'
                },
                isMinimal: true
            };
            
            const result = await submitToAPI(manifest);
            
            if (result.success) {
                console.log(`   ✅ Successfully submitted!`);
                if (result.result.id) {
                    console.log(`   ID: ${result.result.id}`);
                }
                results.successful++;
                results.details.push({
                    name: server.name,
                    package: packageName,
                    status: 'success',
                    id: result.result.id
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
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            // Progress update
            if ((i + 1) % 10 === 0) {
                console.log(`\n📊 Progress: ${i+1}/${uvxServers.length} (Success: ${results.successful}, Failed: ${results.failed})`);
            }
        }
        
        // Summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 DIRECT SUBMISSION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total UVX servers: ${results.total}`);
        console.log(`✅ Successfully submitted: ${results.successful}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log(`⏩ Skipped: ${results.skipped}`);
        console.log('='.repeat(60));
        
        // Save results
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsPath = path.join(__dirname, `uvx-direct-submission-results-${timestamp}.json`);
        await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
        console.log(`\n📁 Results saved to: ${resultsPath}`);
        
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

main().catch(console.error);