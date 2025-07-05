// Browser console script to automatically register MCP servers from mcp.so
// Paste this into the browser console while on https://mcp.so/

(async function() {
    console.log('🚀 Starting MCP.so server registration automation');
    
    // Configuration
    const DELAY_BETWEEN_SERVERS = 3000; // 3 seconds between each server
    const PAGE_LOAD_DELAY = 2000; // 2 seconds to wait for page load
    
    // Get all server links
    const serverLinks = Array.from(document.querySelectorAll('a[href^="/servers/"]')).map(a => ({
        href: a.href,
        name: a.textContent.trim()
    }));
    
    console.log(`Found ${serverLinks.length} servers to process`);
    
    // Track results
    const results = {
        processed: 0,
        registered: 0,
        failed: 0,
        errors: []
    };
    
    // Function to extract package info from the current page
    function extractPackageInfo() {
        // Look for NPX command
        const npxElement = Array.from(document.querySelectorAll('code')).find(el => 
            el.textContent.includes('npx ') && !el.textContent.includes('npx -y @mcpfinder/server')
        );
        
        if (npxElement) {
            const match = npxElement.textContent.match(/npx\s+(?:-y\s+)?([^\s]+)/);
            if (match) {
                return { type: 'npx', package: match[1] };
            }
        }
        
        // Look for UVX command
        const uvxElement = Array.from(document.querySelectorAll('code')).find(el => 
            el.textContent.includes('uvx ')
        );
        
        if (uvxElement) {
            const match = uvxElement.textContent.match(/uvx\s+([^\s]+)/);
            if (match) {
                return { type: 'uvx', package: match[1] };
            }
        }
        
        return null;
    }
    
    // Function to run registration command
    async function runRegistrationCommand(packageInfo, serverName) {
        return new Promise((resolve) => {
            const command = packageInfo.type === 'uvx' 
                ? `npx @mcpfinder/server register --headless ${packageInfo.package} --use-uvx`
                : `npx @mcpfinder/server register --headless ${packageInfo.package}`;
            
            console.log(`📝 Registration command for ${serverName}:`);
            console.log(command);
            console.log('Copy the above command and run it in your terminal');
            console.log('---');
            
            // Since we can't actually execute terminal commands from browser,
            // we'll log them for manual execution
            resolve({
                server: serverName,
                command: command,
                package: packageInfo.package,
                type: packageInfo.type
            });
        });
    }
    
    // Process each server
    for (let i = 0; i < serverLinks.length; i++) {
        const server = serverLinks[i];
        console.log(`\n[${i + 1}/${serverLinks.length}] Processing: ${server.name}`);
        
        try {
            // Navigate to server page
            window.location.href = server.href;
            
            // Wait for page to load
            await new Promise(resolve => setTimeout(resolve, PAGE_LOAD_DELAY));
            
            // Extract package info
            const packageInfo = extractPackageInfo();
            
            if (packageInfo) {
                const result = await runRegistrationCommand(packageInfo, server.name);
                results.processed++;
                results.registered++;
            } else {
                console.warn(`❌ Could not find package info for ${server.name}`);
                results.failed++;
                results.errors.push(`${server.name}: No package info found`);
            }
            
        } catch (error) {
            console.error(`❌ Error processing ${server.name}:`, error);
            results.failed++;
            results.errors.push(`${server.name}: ${error.message}`);
        }
        
        // Wait before next server
        if (i < serverLinks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_SERVERS));
        }
    }
    
    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 REGISTRATION SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total servers: ${serverLinks.length}`);
    console.log(`Processed: ${results.processed}`);
    console.log(`Ready to register: ${results.registered}`);
    console.log(`Failed: ${results.failed}`);
    
    if (results.errors.length > 0) {
        console.log('\n❌ Errors:');
        results.errors.forEach(err => console.log(`  - ${err}`));
    }
    
    console.log('\n✅ Script complete! Check the console for all registration commands.');
})();