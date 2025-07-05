// Browser console script to collect all MCP servers and generate registration commands
// Paste this into the browser console while on https://mcp.so/

(async function() {
    console.log('🚀 Starting MCP.so server data collection for registration');
    
    // Get all server links
    const serverLinks = Array.from(document.querySelectorAll('a[href^="/servers/"]')).map(a => ({
        href: a.href,
        name: a.textContent.trim(),
        slug: a.href.split('/servers/')[1]
    }));
    
    console.log(`Found ${serverLinks.length} servers to process`);
    
    const commands = [];
    const results = {
        total: serverLinks.length,
        withPackage: 0,
        withoutPackage: 0,
        servers: []
    };
    
    // Function to fetch and parse each server page
    async function fetchServerData(server) {
        try {
            const response = await fetch(server.href);
            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            
            // Look for NPX command
            const npxMatch = html.match(/npx\s+(?:-y\s+)?([^\s<]+)(?![^<]*@mcpfinder)/);
            if (npxMatch && npxMatch[1]) {
                const packageName = npxMatch[1].replace(/[<>]/g, '');
                results.withPackage++;
                results.servers.push({
                    name: server.name,
                    package: packageName,
                    type: 'npx'
                });
                commands.push(`npx @mcpfinder/server register --headless ${packageName} # ${server.name}`);
                return;
            }
            
            // Look for UVX command
            const uvxMatch = html.match(/uvx\s+([^\s<]+)/);
            if (uvxMatch && uvxMatch[1]) {
                const packageName = uvxMatch[1].replace(/[<>]/g, '');
                results.withPackage++;
                results.servers.push({
                    name: server.name,
                    package: packageName,
                    type: 'uvx'
                });
                commands.push(`npx @mcpfinder/server register --headless ${packageName} --use-uvx # ${server.name}`);
                return;
            }
            
            // Look for HTTP/SSE URLs
            const urlMatch = html.match(/https?:\/\/[^\s<]+(?:\/sse|\/mcp)/);
            if (urlMatch) {
                results.withPackage++;
                results.servers.push({
                    name: server.name,
                    package: urlMatch[0],
                    type: 'url'
                });
                commands.push(`npx @mcpfinder/server register --headless "${urlMatch[0]}" # ${server.name}`);
                return;
            }
            
            results.withoutPackage++;
            console.warn(`❌ No package found for: ${server.name}`);
            
        } catch (error) {
            console.error(`Error fetching ${server.name}:`, error);
            results.withoutPackage++;
        }
    }
    
    // Process servers in batches to avoid overwhelming the server
    const batchSize = 5;
    for (let i = 0; i < serverLinks.length; i += batchSize) {
        const batch = serverLinks.slice(i, Math.min(i + batchSize, serverLinks.length));
        console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(serverLinks.length/batchSize)}...`);
        
        await Promise.all(batch.map(server => fetchServerData(server)));
        
        // Small delay between batches
        if (i + batchSize < serverLinks.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    // Print results
    console.log('\n' + '='.repeat(60));
    console.log('📊 COLLECTION SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total servers: ${results.total}`);
    console.log(`With package info: ${results.withPackage}`);
    console.log(`Without package info: ${results.withoutPackage}`);
    console.log('='.repeat(60));
    
    // Print all commands
    console.log('\n📝 REGISTRATION COMMANDS:');
    console.log('Copy and paste these commands into your terminal:\n');
    commands.forEach(cmd => console.log(cmd));
    
    // Create a bash script
    const bashScript = `#!/bin/bash
# MCP.so Server Registration Script
# Generated on ${new Date().toISOString()}

echo "🚀 Starting registration of ${commands.length} MCP servers"
echo ""

# Array to track results
successful=0
failed=0

${commands.map((cmd, i) => `
# Server ${i + 1}/${commands.length}
echo "[${i + 1}/${commands.length}] Running: ${cmd}"
if ${cmd}; then
    ((successful++))
    echo "✅ Success"
else
    ((failed++))
    echo "❌ Failed"
fi
echo ""
sleep 2
`).join('')}

echo "========================================"
echo "📊 REGISTRATION COMPLETE"
echo "========================================"
echo "Total: ${commands.length}"
echo "Successful: $successful"
echo "Failed: $failed"
echo "========================================"
`;
    
    // Create download link for bash script
    const blob = new Blob([bashScript], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `register-mcp-so-servers-${new Date().toISOString().split('T')[0]}.sh`;
    
    console.log('\n💾 Click here to download the bash script:');
    console.log(a);
    a.click();
    
    // Also save the data as JSON
    console.log('\n📄 Server data (JSON):');
    console.log(JSON.stringify(results.servers, null, 2));
    
    // Return the results for further processing
    return results;
})();