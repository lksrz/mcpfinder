// Browser console script to crawl ALL MCP servers from mcp.so paginated pages
// Paste this into the browser console while on https://mcp.so/

(async function() {
    console.log('🚀 Starting comprehensive MCP.so server crawl and registration generation');
    
    const commands = [];
    const results = {
        totalPages: 0,
        totalServers: 0,
        processedServers: 0,
        withPackage: 0,
        withoutPackage: 0,
        servers: [],
        errors: []
    };
    
    // Function to get all server links from a listing page
    async function getServerLinksFromPage(pageNum) {
        try {
            const url = `https://mcp.so/servers?tag=latest&page=${pageNum}`;
            console.log(`Fetching page ${pageNum}: ${url}`);
            
            const response = await fetch(url);
            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            
            // Look for server links in the page
            const serverLinks = [];
            
            // Try different selectors to find server cards/links
            const possibleSelectors = [
                'a[href*="/servers/"]',
                '.server-card a',
                '.server-item a',
                '[data-server] a',
                '.card a[href*="/servers/"]'
            ];
            
            for (const selector of possibleSelectors) {
                const links = doc.querySelectorAll(selector);
                if (links.length > 0) {
                    console.log(`Found ${links.length} servers using selector: ${selector}`);
                    
                    Array.from(links).forEach(link => {
                        const href = link.getAttribute('href');
                        if (href && href.includes('/servers/') && !href.endsWith('/servers/')) {
                            const fullUrl = href.startsWith('http') ? href : `https://mcp.so${href}`;
                            const name = link.textContent.trim() || link.getAttribute('title') || 'Unknown';
                            const slug = href.split('/servers/')[1].split('?')[0];
                            
                            if (slug && !serverLinks.find(s => s.slug === slug)) {
                                serverLinks.push({
                                    href: fullUrl,
                                    name: name,
                                    slug: slug
                                });
                            }
                        }
                    });
                    break; // Use first working selector
                }
            }
            
            return serverLinks;
        } catch (error) {
            console.error(`Error fetching page ${pageNum}:`, error);
            results.errors.push(`Page ${pageNum}: ${error.message}`);
            return [];
        }
    }
    
    // Function to extract package info from a server page
    async function extractPackageFromServerPage(server) {
        try {
            const serverUrl = `${server.href}?tab=content`;
            console.log(`Analyzing server: ${server.name} (${server.slug})`);
            
            const response = await fetch(serverUrl);
            const html = await response.text();
            
            results.processedServers++;
            
            // Look for JSON configuration blocks
            const jsonConfigMatches = html.match(/{\s*"mcpServers"[\s\S]*?}/g);
            if (jsonConfigMatches) {
                for (const jsonMatch of jsonConfigMatches) {
                    try {
                        const config = JSON.parse(jsonMatch);
                        if (config.mcpServers) {
                            const serverKey = Object.keys(config.mcpServers)[0];
                            const serverConfig = config.mcpServers[serverKey];
                            
                            if (serverConfig.command === 'npx') {
                                const packageName = serverConfig.args[0];
                                if (packageName && !packageName.includes('@mcpfinder')) {
                                    results.withPackage++;
                                    results.servers.push({
                                        name: server.name,
                                        slug: server.slug,
                                        package: packageName,
                                        type: 'npx',
                                        config: serverConfig
                                    });
                                    commands.push(`npx @mcpfinder/server register --headless "${packageName}" # ${server.name}`);
                                    return;
                                }
                            } else if (serverConfig.command === 'uvx') {
                                const packageName = serverConfig.args[0];
                                if (packageName) {
                                    results.withPackage++;
                                    results.servers.push({
                                        name: server.name,
                                        slug: server.slug,
                                        package: packageName,
                                        type: 'uvx',
                                        config: serverConfig
                                    });
                                    commands.push(`npx @mcpfinder/server register --headless "${packageName}" --use-uvx # ${server.name}`);
                                    return;
                                }
                            } else if (serverConfig.args && serverConfig.args.includes('mcp-remote')) {
                                // Handle mcp-remote SSE URLs
                                const remoteIndex = serverConfig.args.indexOf('mcp-remote');
                                if (remoteIndex >= 0 && serverConfig.args[remoteIndex + 1]) {
                                    const url = serverConfig.args[remoteIndex + 1];
                                    results.withPackage++;
                                    results.servers.push({
                                        name: server.name,
                                        slug: server.slug,
                                        package: url,
                                        type: 'url',
                                        config: serverConfig
                                    });
                                    commands.push(`npx @mcpfinder/server register --headless "${url}" # ${server.name}`);
                                    return;
                                }
                            }
                        }
                    } catch (parseError) {
                        // Continue to other methods if JSON parsing fails
                    }
                }
            }
            
            // Look for Smithery install commands
            const smitheryMatch = html.match(/npx -y @smithery\/cli@latest install ([^\s]+)/);
            if (smitheryMatch) {
                const packageName = smitheryMatch[1];
                results.withPackage++;
                results.servers.push({
                    name: server.name,
                    slug: server.slug,
                    package: packageName,
                    type: 'smithery',
                    config: { smithery: true }
                });
                commands.push(`npx @mcpfinder/server register --headless "${packageName}" # ${server.name} (Smithery)`);
                return;
            }
            
            // Look for standalone NPX commands
            const npxMatches = html.matchAll(/npx\s+(?:-y\s+)?([A-Za-z0-9@/._-]+)/g);
            for (const match of npxMatches) {
                const packageName = match[1];
                if (!packageName.includes('@mcpfinder') && !packageName.includes('@smithery') && packageName.length > 2) {
                    results.withPackage++;
                    results.servers.push({
                        name: server.name,
                        slug: server.slug,
                        package: packageName,
                        type: 'npx'
                    });
                    commands.push(`npx @mcpfinder/server register --headless "${packageName}" # ${server.name}`);
                    return;
                }
            }
            
            // Look for standalone UVX commands
            const uvxMatch = html.match(/uvx\s+([A-Za-z0-9_.-]+)/);
            if (uvxMatch && uvxMatch[1]) {
                const packageName = uvxMatch[1];
                results.withPackage++;
                results.servers.push({
                    name: server.name,
                    slug: server.slug,
                    package: packageName,
                    type: 'uvx'
                });
                commands.push(`npx @mcpfinder/server register --headless "${packageName}" --use-uvx # ${server.name}`);
                return;
            }
            
            // Look for HTTP/SSE URLs
            const urlMatch = html.match(/(https?:\/\/[^\s<"']+(?:\/sse|\/mcp|api\/mcp)[^\s<"']*)/);
            if (urlMatch) {
                const url = urlMatch[1].replace(/[<>"']/g, '');
                results.withPackage++;
                results.servers.push({
                    name: server.name,
                    slug: server.slug,
                    package: url,
                    type: 'url'
                });
                commands.push(`npx @mcpfinder/server register --headless "${url}" # ${server.name}`);
                return;
            }
            
            results.withoutPackage++;
            console.warn(`❌ No package configuration found for: ${server.name}`);
            
        } catch (error) {
            console.error(`Error analyzing ${server.name}:`, error);
            results.withoutPackage++;
            results.errors.push(`${server.name}: ${error.message}`);
        }
    }
    
    // Main crawling logic
    console.log('Starting to crawl all pages...');
    
    let currentPage = 1;
    let hasMorePages = true;
    const allServers = [];
    
    // First, collect all server links from all pages
    while (hasMorePages && currentPage <= 506) {
        const serversOnPage = await getServerLinksFromPage(currentPage);
        
        if (serversOnPage.length === 0) {
            console.log(`No servers found on page ${currentPage}, stopping crawl`);
            hasMorePages = false;
        } else {
            allServers.push(...serversOnPage);
            results.totalPages = currentPage;
            console.log(`Page ${currentPage}: Found ${serversOnPage.length} servers (Total: ${allServers.length})`);
        }
        
        currentPage++;
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Safety check - if we get the same servers, we might be hitting the end
        if (currentPage > 10 && serversOnPage.length < 30) {
            console.log(`Fewer servers on page ${currentPage-1}, might be reaching the end`);
        }
    }
    
    // Deduplicate servers
    const uniqueServers = Array.from(new Map(allServers.map(s => [s.slug, s])).values());
    results.totalServers = uniqueServers.length;
    
    console.log(`\n📋 Found ${uniqueServers.length} unique servers across ${results.totalPages} pages`);
    console.log('Now analyzing each server for package configuration...\n');
    
    // Process servers in batches
    const batchSize = 5;
    for (let i = 0; i < uniqueServers.length; i += batchSize) {
        const batch = uniqueServers.slice(i, Math.min(i + batchSize, uniqueServers.length));
        const batchNum = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(uniqueServers.length / batchSize);
        
        console.log(`Processing batch ${batchNum}/${totalBatches} (servers ${i + 1}-${Math.min(i + batchSize, uniqueServers.length)})...`);
        
        await Promise.all(batch.map(server => extractPackageFromServerPage(server)));
        
        // Rate limiting between batches
        if (i + batchSize < uniqueServers.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    // Print final results
    console.log('\n' + '='.repeat(70));
    console.log('📊 COMPREHENSIVE CRAWL SUMMARY');
    console.log('='.repeat(70));
    console.log(`Total pages crawled: ${results.totalPages}`);
    console.log(`Total servers found: ${results.totalServers}`);
    console.log(`Servers processed: ${results.processedServers}`);
    console.log(`With package info: ${results.withPackage}`);
    console.log(`Without package info: ${results.withoutPackage}`);
    console.log(`Errors: ${results.errors.length}`);
    console.log('='.repeat(70));
    
    if (commands.length === 0) {
        console.error('❌ No registration commands generated!');
        return results;
    }
    
    // Print all commands
    console.log('\n📝 REGISTRATION COMMANDS:');
    console.log(`Generated ${commands.length} registration commands:\n`);
    commands.forEach((cmd, i) => console.log(`${i + 1}. ${cmd}`));
    
    // Create comprehensive bash script
    const bashScript = `#!/bin/bash
# Comprehensive MCP.so Server Registration Script
# Generated on ${new Date().toISOString()}
# Crawled ${results.totalPages} pages, found ${results.totalServers} servers

echo "🚀 Starting registration of ${commands.length} MCP servers from mcp.so"
echo "📊 Crawled ${results.totalPages} pages, found ${results.totalServers} total servers"
echo ""

# Array to track results
successful=0
failed=0
total=${commands.length}

${commands.map((cmd, i) => `
# Server ${i + 1}/${commands.length}
echo "=========================================="
echo "[${i + 1}/$total] ${cmd.split('# ')[1] || 'Unknown Server'}"
echo "Command: ${cmd.split(' #')[0]}"
echo "=========================================="
if ${cmd.split(' #')[0]}; then
    ((successful++))
    echo "✅ SUCCESS: Server registered"
else
    ((failed++))
    echo "❌ FAILED: Registration failed"
fi
echo ""
sleep 3
`).join('')}

echo "========================================"
echo "📊 FINAL REGISTRATION SUMMARY"
echo "========================================"
echo "Total servers attempted: $total"
echo "Successfully registered: $successful"
echo "Failed registrations: $failed"
echo "Success rate: $(( successful * 100 / total ))%"
echo "========================================"
`;
    
    // Download the script
    const blob = new Blob([bashScript], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `register-all-mcp-so-servers-${new Date().toISOString().split('T')[0]}.sh`;
    document.body.appendChild(a);
    
    console.log('\n💾 Downloading comprehensive registration script...');
    a.click();
    
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
    
    // Save detailed results as JSON
    const jsonBlob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
    const jsonUrl = URL.createObjectURL(jsonBlob);
    const jsonA = document.createElement('a');
    jsonA.href = jsonUrl;
    jsonA.download = `mcp-so-crawl-results-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(jsonA);
    jsonA.click();
    
    setTimeout(() => {
        document.body.removeChild(jsonA);
        URL.revokeObjectURL(jsonUrl);
    }, 100);
    
    console.log('💾 Also downloaded detailed JSON results');
    
    // Copy commands to clipboard
    if (navigator.clipboard) {
        navigator.clipboard.writeText(commands.join('\n')).then(() => {
            console.log('✅ All registration commands copied to clipboard!');
        }).catch(() => {
            console.log('❌ Could not copy to clipboard');
        });
    }
    
    if (results.errors.length > 0) {
        console.log('\n❌ Errors encountered:');
        results.errors.forEach(error => console.log(`  - ${error}`));
    }
    
    console.log('\n🎉 Comprehensive crawl complete!');
    return results;
})();