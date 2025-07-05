// Browser console script to collect all MCP servers and generate registration commands
// Paste this into the browser console while on https://mcp.so/

(async function() {
    console.log('🚀 Starting MCP.so server data collection for registration');
    
    // Debug: Check what's on the page
    console.log('Debugging: Looking for server links...');
    console.log('All links with /servers/:', document.querySelectorAll('a[href*="/servers/"]').length);
    
    // Try multiple selectors to find server links
    let serverLinks = [];
    
    // Method 1: Look for links containing /servers/
    const method1 = Array.from(document.querySelectorAll('a[href*="/servers/"]'))
        .filter(a => a.href.includes('/servers/') && !a.href.endsWith('/servers/'))
        .map(a => ({
            href: a.href,
            name: a.textContent.trim() || a.getAttribute('title') || 'Unknown',
            slug: a.href.split('/servers/')[1]
        }));
    
    // Method 2: Look in specific containers (adjust based on actual structure)
    const method2 = Array.from(document.querySelectorAll('.server-card a, .server-item a, [class*="server"] a'))
        .filter(a => a.href && a.href.includes('/servers/'))
        .map(a => ({
            href: a.href,
            name: a.textContent.trim() || 'Unknown',
            slug: a.href.split('/servers/')[1]
        }));
    
    // Method 3: Look for any link that matches the pattern
    const method3 = Array.from(document.querySelectorAll('a'))
        .filter(a => {
            const href = a.getAttribute('href') || '';
            return href.startsWith('/servers/') || (a.href && a.href.includes('mcp.so/servers/'));
        })
        .map(a => ({
            href: a.href || `https://mcp.so${a.getAttribute('href')}`,
            name: a.textContent.trim() || 'Unknown',
            slug: (a.href || a.getAttribute('href')).split('/servers/')[1]
        }));
    
    // Combine and deduplicate
    const allLinks = [...method1, ...method2, ...method3];
    const uniqueLinks = Array.from(new Map(allLinks.map(link => [link.href, link])).values());
    serverLinks = uniqueLinks.filter(link => link.slug && link.slug.length > 0);
    
    console.log(`Found ${serverLinks.length} unique server links`);
    console.log('Sample links:', serverLinks.slice(0, 5));
    
    if (serverLinks.length === 0) {
        console.error('❌ No server links found. Please make sure you are on https://mcp.so/');
        console.log('Trying alternative: Looking for any text that might be server names...');
        
        // Alternative: If no links found, prompt user
        const userInput = prompt('No server links found automatically. Please enter server slugs separated by commas (e.g., "playwright,browser-use,git"):');
        if (userInput) {
            serverLinks = userInput.split(',').map(slug => ({
                href: `https://mcp.so/servers/${slug.trim()}`,
                name: slug.trim(),
                slug: slug.trim()
            }));
        }
    }
    
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
            console.log(`Fetching: ${server.name}`);
            const response = await fetch(server.href);
            const html = await response.text();
            
            // Debug first server
            if (results.servers.length === 0) {
                console.log('Sample HTML snippet:', html.substring(0, 500));
            }
            
            // Look for NPX command (exclude @mcpfinder references)
            const npxMatches = html.matchAll(/npx\s+(?:-y\s+)?([A-Za-z0-9@/._-]+)/g);
            for (const match of npxMatches) {
                const packageName = match[1];
                if (!packageName.includes('@mcpfinder') && packageName.length > 2) {
                    results.withPackage++;
                    results.servers.push({
                        name: server.name,
                        package: packageName,
                        type: 'npx'
                    });
                    commands.push(`npx @mcpfinder/server register --headless "${packageName}" # ${server.name}`);
                    return;
                }
            }
            
            // Look for UVX command
            const uvxMatch = html.match(/uvx\s+([A-Za-z0-9_.-]+)/);
            if (uvxMatch && uvxMatch[1]) {
                const packageName = uvxMatch[1];
                results.withPackage++;
                results.servers.push({
                    name: server.name,
                    package: packageName,
                    type: 'uvx'
                });
                commands.push(`npx @mcpfinder/server register --headless "${packageName}" --use-uvx # ${server.name}`);
                return;
            }
            
            // Look for HTTP/SSE URLs
            const urlMatch = html.match(/(https?:\/\/[^\s<"]+(?:\/sse|\/mcp|api\/mcp)[^\s<"]*)/);
            if (urlMatch) {
                const url = urlMatch[1].replace(/[<>"]/g, '');
                results.withPackage++;
                results.servers.push({
                    name: server.name,
                    package: url,
                    type: 'url'
                });
                commands.push(`npx @mcpfinder/server register --headless "${url}" # ${server.name}`);
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
    
    if (commands.length === 0) {
        console.error('❌ No commands generated. Server structure might have changed.');
        return results;
    }
    
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
    document.body.appendChild(a);
    
    console.log('\n💾 Downloading bash script...');
    a.click();
    
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
    
    // Also save the data as JSON
    console.log('\n📄 Server data (JSON):');
    console.log(JSON.stringify(results.servers, null, 2));
    
    // Copy first command to clipboard if possible
    if (commands.length > 0 && navigator.clipboard) {
        navigator.clipboard.writeText(commands.join('\n')).then(() => {
            console.log('✅ All commands copied to clipboard!');
        }).catch(() => {
            console.log('❌ Could not copy to clipboard');
        });
    }
    
    return results;
})();