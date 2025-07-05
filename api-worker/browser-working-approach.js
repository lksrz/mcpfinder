// Working approach based on browser-collect-mcp-so-v2.js
// This gets servers from current page first, then tries to get more via fetch
// Paste this into browser console while on https://mcp.so/servers

(async function() {
    console.log('🚀 Starting MCP.so package extraction (working approach)');
    
    const allPackages = [];
    const usedNames = new Set();
    const results = {
        totalPages: 0,
        totalServers: 0,
        foundPackages: 0,
        notFound: 0,
        errors: []
    };
    
    // Function to generate unique server name
    function generateUniqueName(baseName, packageName, url) {
        let cleanBaseName = baseName.replace(/:/g, '').trim();
        
        if (!usedNames.has(cleanBaseName)) {
            usedNames.add(cleanBaseName);
            return cleanBaseName;
        }
        
        let fallbackName;
        if (url && url.startsWith('http')) {
            fallbackName = url
                .replace(/https?:\/\//, '')
                .replace(/\//g, '-')
                .replace(/\./g, '-')
                .replace(/[^a-zA-Z0-9-]/g, '')
                .toLowerCase();
        } else if (packageName) {
            fallbackName = packageName.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
        } else {
            fallbackName = cleanBaseName;
        }
        
        if (!usedNames.has(fallbackName)) {
            usedNames.add(fallbackName);
            return fallbackName;
        }
        
        let counter = 2;
        let numberedName;
        do {
            numberedName = `${fallbackName}-${counter}`;
            counter++;
        } while (usedNames.has(numberedName));
        
        usedNames.add(numberedName);
        return numberedName;
    }
    
    // Function to get server links from current page (like v2 does)
    function getServerLinksFromCurrentPage() {
        let serverLinks = [];
        
        // Method 1: Look for links containing /servers/
        const method1 = Array.from(document.querySelectorAll('a[href*="/servers/"]'))
            .filter(a => a.href.includes('/servers/') && !a.href.endsWith('/servers/'))
            .map(a => ({
                href: a.href,
                name: a.textContent.trim() || a.getAttribute('title') || 'Unknown',
                slug: a.href.split('/servers/')[1].split('?')[0]
            }));
        
        // Method 2: Look in specific containers
        const method2 = Array.from(document.querySelectorAll('.server-card a, .server-item a, [class*="server"] a'))
            .filter(a => a.href && a.href.includes('/servers/'))
            .map(a => ({
                href: a.href,
                name: a.textContent.trim() || 'Unknown',
                slug: a.href.split('/servers/')[1].split('?')[0]
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
                slug: (a.href || a.getAttribute('href')).split('/servers/')[1].split('?')[0]
            }));
        
        // Combine and deduplicate
        const allLinks = [...method1, ...method2, ...method3];
        const uniqueLinks = Array.from(new Map(allLinks.map(link => [link.href, link])).values());
        serverLinks = uniqueLinks.filter(link => link.slug && link.slug.length > 0);
        
        return serverLinks;
    }
    
    // Function to extract package data from server (like v2 does)
    async function extractPackageFromServer(server) {
        try {
            console.log(`Fetching: ${server.name}`);
            const response = await fetch(server.href + '?tab=content');
            const html = await response.text();
            
            // Extract server name
            let serverName = server.name || server.slug;
            const titleMatch = html.match(/<title[^>]*>([^<]+)/);
            if (titleMatch) {
                serverName = titleMatch[1].replace(' | mcp.so', '').trim();
            }
            
            const baseServerName = serverName.replace(/:/g, '').trim();
            
            // Look for JSON configuration blocks with mcpServers
            const jsonConfigMatches = html.match(/{\s*"mcpServers"[\s\S]*?}/g);
            if (jsonConfigMatches) {
                for (const jsonMatch of jsonConfigMatches) {
                    try {
                        const config = JSON.parse(jsonMatch);
                        if (config.mcpServers) {
                            const serverKey = Object.keys(config.mcpServers)[0];
                            const serverConfig = config.mcpServers[serverKey];
                            
                            if (serverConfig.command === 'npx' && serverConfig.args?.[0]) {
                                const packageName = serverConfig.args[0];
                                if (packageName && !packageName.includes('@mcpfinder')) {
                                    const uniqueName = generateUniqueName(baseServerName, packageName, null);
                                    return `npx:${uniqueName}:${packageName}`;
                                }
                            } else if (serverConfig.command === 'uvx' && serverConfig.args?.[0]) {
                                const packageName = serverConfig.args[0];
                                const uniqueName = generateUniqueName(baseServerName, packageName, null);
                                return `uvx:${uniqueName}:${packageName}`;
                            } else if (serverConfig.args?.includes('mcp-remote')) {
                                const remoteIndex = serverConfig.args.indexOf('mcp-remote');
                                if (remoteIndex >= 0 && serverConfig.args[remoteIndex + 1]) {
                                    const url = serverConfig.args[remoteIndex + 1];
                                    const protocol = url.includes('/sse') ? 'sse' : 'http';
                                    const uniqueName = generateUniqueName(baseServerName, null, url);
                                    return `${protocol}:${uniqueName}:${url}`;
                                }
                            }
                        }
                    } catch (parseError) {
                        // Continue to other methods
                    }
                }
            }
            
            // Look for Smithery install commands
            const smitheryMatch = html.match(/npx -y @smithery\/cli@latest install ([^\s]+)/);
            if (smitheryMatch) {
                const packageName = smitheryMatch[1];
                const uniqueName = generateUniqueName(baseServerName, packageName, null);
                return `npx:${uniqueName}:${packageName}`;
            }
            
            // Look for NPX command (exclude @mcpfinder references)
            const npxMatches = html.matchAll(/npx\s+(?:-y\s+)?([A-Za-z0-9@/._-]+)/g);
            for (const match of npxMatches) {
                const packageName = match[1];
                if (!packageName.includes('@mcpfinder') && !packageName.includes('@smithery') && packageName.length > 2) {
                    const uniqueName = generateUniqueName(baseServerName, packageName, null);
                    return `npx:${uniqueName}:${packageName}`;
                }
            }
            
            // Look for UVX command
            const uvxMatch = html.match(/uvx\s+([A-Za-z0-9_.-]+)/);
            if (uvxMatch?.[1]) {
                const packageName = uvxMatch[1];
                const uniqueName = generateUniqueName(baseServerName, packageName, null);
                return `uvx:${uniqueName}:${packageName}`;
            }
            
            // Look for HTTP/SSE URLs
            const urlMatch = html.match(/(https?:\/\/[^\s<"']+(?:\/sse|\/mcp|api\/mcp)[^\s<"']*)/);
            if (urlMatch) {
                const url = urlMatch[1].replace(/[<>"']/g, '');
                const protocol = url.includes('/sse') ? 'sse' : 'http';
                const uniqueName = generateUniqueName(baseServerName, null, url);
                return `${protocol}:${uniqueName}:${url}`;
            }
            
            results.notFound++;
            console.warn(`❌ No package found for: ${server.name}`);
            return null;
            
        } catch (error) {
            console.error(`Error fetching ${server.name}:`, error);
            results.notFound++;
            results.errors.push(`${server.name}: ${error.message}`);
            return null;
        }
    }
    
    // Function to download file
    function downloadFile(packages, filename) {
        if (packages.length === 0) return;
        
        const content = packages.join('\n');
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        
        a.click();
        
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        
        console.log(`💾 Downloaded: ${filename}`);
    }
    
    // Main logic - start with current page, then try other pages
    console.log('🔍 Getting servers from current page...');
    
    let allServerLinks = getServerLinksFromCurrentPage();
    console.log(`Found ${allServerLinks.length} servers on current page`);
    
    if (allServerLinks.length === 0) {
        console.log('❌ No servers found on current page. Make sure you are on https://mcp.so/servers');
        return;
    }
    
    // Get the current page number
    const currentUrl = new URL(window.location.href);
    const currentPageNum = parseInt(currentUrl.searchParams.get('page')) || 1;
    console.log(`Current page: ${currentPageNum}`);
    
    // Process current page servers first
    console.log(`Processing ${allServerLinks.length} servers from page ${currentPageNum}...`);
    
    const batchSize = 5;
    for (let i = 0; i < allServerLinks.length; i += batchSize) {
        const batch = allServerLinks.slice(i, Math.min(i + batchSize, allServerLinks.length));
        console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(allServerLinks.length/batchSize)}...`);
        
        const batchResults = await Promise.all(batch.map(server => extractPackageFromServer(server)));
        
        batchResults.forEach(result => {
            if (result) {
                allPackages.push(result);
                results.foundPackages++;
            }
        });
        
        // Small delay between batches
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Download file for current page
    if (allPackages.length > 0) {
        downloadFile(allPackages, `mcp-packages-page-${currentPageNum}-${new Date().toISOString().split('T')[0]}.txt`);
    }
    
    // Now try to get more pages by manually navigating
    console.log('\n🔄 To get more pages:');
    console.log('1. Manually navigate to the next page in your browser');
    console.log('2. Run this script again');
    console.log('3. Repeat for each page you want to process');
    
    // Print results for current page
    console.log('\n' + '='.repeat(60));
    console.log(`📊 PAGE ${currentPageNum} SUMMARY`);
    console.log('='.repeat(60));
    console.log(`Servers found: ${allServerLinks.length}`);
    console.log(`Packages extracted: ${results.foundPackages}`);
    console.log(`Servers without packages: ${results.notFound}`);
    console.log('='.repeat(60));
    
    // Show extracted packages
    if (allPackages.length > 0) {
        console.log('\n📝 EXTRACTED PACKAGES:');
        allPackages.forEach((pkg, i) => console.log(`${i + 1}. ${pkg}`));
    }
    
    // Copy to clipboard
    if (allPackages.length > 0 && navigator.clipboard) {
        navigator.clipboard.writeText(allPackages.join('\n')).then(() => {
            console.log('\n✅ Packages copied to clipboard!');
        }).catch(() => {
            console.log('\n❌ Could not copy to clipboard');
        });
    }
    
    console.log(`\n🎉 Page ${currentPageNum} processing complete!`);
    
    return {
        page: currentPageNum,
        packages: allPackages,
        stats: results
    };
})();