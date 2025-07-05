// Browser console script to extract package names from all MCP.so servers
// Outputs a simple text file with one package per line
// Paste this into the browser console while on https://mcp.so/

(async function() {
    console.log('🚀 Starting MCP.so package extraction');
    
    const packages = [];
    const usedNames = new Set(); // Track used server names to avoid conflicts
    const results = {
        totalPages: 0,
        totalServers: 0,
        processedServers: 0,
        foundPackages: 0,
        notFound: 0,
        errors: []
    };
    
    // Function to generate unique server name
    function generateUniqueName(baseName, packageName, url) {
        // Clean base name
        let cleanBaseName = baseName.replace(/:/g, '').trim();
        
        // Try original name first
        if (!usedNames.has(cleanBaseName)) {
            usedNames.add(cleanBaseName);
            return cleanBaseName;
        }
        
        // Generate fallback name based on package/URL
        let fallbackName;
        if (url && url.startsWith('http')) {
            // For URLs, convert to readable format
            fallbackName = url
                .replace(/https?:\/\//, '')
                .replace(/\//g, '-')
                .replace(/\./g, '-')
                .replace(/[^a-zA-Z0-9-]/g, '')
                .toLowerCase();
        } else if (packageName) {
            // For packages, use package name
            fallbackName = packageName.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
        } else {
            fallbackName = cleanBaseName;
        }
        
        // Try fallback name
        if (!usedNames.has(fallbackName)) {
            usedNames.add(fallbackName);
            return fallbackName;
        }
        
        // Add numeric suffix if still conflicts
        let counter = 2;
        let numberedName;
        do {
            numberedName = `${fallbackName}-${counter}`;
            counter++;
        } while (usedNames.has(numberedName));
        
        usedNames.add(numberedName);
        return numberedName;
    }
    
    // Function to get all server links from a listing page
    async function getServerLinksFromPage(pageNum) {
        try {
            const url = `https://mcp.so/servers?tag=latest&page=${pageNum}`;
            console.log(`Fetching page ${pageNum}...`);
            
            const response = await fetch(url);
            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            
            const serverLinks = [];
            
            // Try different selectors to find server links
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
                    Array.from(links).forEach(link => {
                        const href = link.getAttribute('href');
                        if (href && href.includes('/servers/') && !href.endsWith('/servers/')) {
                            const fullUrl = href.startsWith('http') ? href : `https://mcp.so${href}`;
                            const slug = href.split('/servers/')[1].split('?')[0];
                            
                            if (slug && !serverLinks.find(s => s.slug === slug)) {
                                serverLinks.push({
                                    href: fullUrl,
                                    slug: slug
                                });
                            }
                        }
                    });
                    break;
                }
            }
            
            return serverLinks;
        } catch (error) {
            console.error(`Error fetching page ${pageNum}:`, error);
            results.errors.push(`Page ${pageNum}: ${error.message}`);
            return [];
        }
    }
    
    // Function to extract package from server page
    async function extractPackageFromServer(server) {
        try {
            const serverUrl = `${server.href}?tab=content`;
            
            const response = await fetch(serverUrl);
            const html = await response.text();
            
            results.processedServers++;
            
            // Extract server name from the page
            let serverName = server.slug;
            const titleMatch = html.match(/<title[^>]*>([^<]+)/);
            if (titleMatch) {
                serverName = titleMatch[1].replace(' | mcp.so', '').trim();
            } else {
                // Try to extract from h1 or other headings
                const h1Match = html.match(/<h1[^>]*>([^<]+)/);
                if (h1Match) {
                    serverName = h1Match[1].trim();
                }
            }
            
            // Clean server name - remove colons to avoid conflicts with our separator
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
                            
                            if (serverConfig.command === 'npx' && serverConfig.args && serverConfig.args[0]) {
                                const packageName = serverConfig.args[0];
                                if (packageName && !packageName.includes('@mcpfinder')) {
                                    const uniqueName = generateUniqueName(baseServerName, packageName, null);
                                    packages.push(`npx:${uniqueName}:${packageName}`);
                                    results.foundPackages++;
                                    return;
                                }
                            } else if (serverConfig.command === 'uvx' && serverConfig.args && serverConfig.args[0]) {
                                const packageName = serverConfig.args[0];
                                const uniqueName = generateUniqueName(baseServerName, packageName, null);
                                packages.push(`uvx:${uniqueName}:${packageName}`);
                                results.foundPackages++;
                                return;
                            } else if (serverConfig.args && serverConfig.args.includes('mcp-remote')) {
                                // Handle mcp-remote SSE URLs
                                const remoteIndex = serverConfig.args.indexOf('mcp-remote');
                                if (remoteIndex >= 0 && serverConfig.args[remoteIndex + 1]) {
                                    const url = serverConfig.args[remoteIndex + 1];
                                    const protocol = url.includes('/sse') ? 'sse' : 'http';
                                    const uniqueName = generateUniqueName(baseServerName, null, url);
                                    packages.push(`${protocol}:${uniqueName}:${url}`);
                                    results.foundPackages++;
                                    return;
                                }
                            }
                        }
                    } catch (parseError) {
                        // Continue to other extraction methods
                    }
                }
            }
            
            // Look for Smithery install commands
            const smitheryMatch = html.match(/npx -y @smithery\/cli@latest install ([^\s]+)/);
            if (smitheryMatch) {
                const packageName = smitheryMatch[1];
                const uniqueName = generateUniqueName(baseServerName, packageName, null);
                packages.push(`npx:${uniqueName}:${packageName}`);
                results.foundPackages++;
                return;
            }
            
            // Look for standalone NPX commands (excluding @mcpfinder and @smithery)
            const npxMatches = html.matchAll(/npx\s+(?:-y\s+)?([A-Za-z0-9@/._-]+)/g);
            for (const match of npxMatches) {
                const packageName = match[1];
                if (!packageName.includes('@mcpfinder') && !packageName.includes('@smithery') && packageName.length > 2) {
                    const uniqueName = generateUniqueName(baseServerName, packageName, null);
                    packages.push(`npx:${uniqueName}:${packageName}`);
                    results.foundPackages++;
                    return;
                }
            }
            
            // Look for standalone UVX commands
            const uvxMatch = html.match(/uvx\s+([A-Za-z0-9_.-]+)/);
            if (uvxMatch && uvxMatch[1]) {
                const packageName = uvxMatch[1];
                const uniqueName = generateUniqueName(baseServerName, packageName, null);
                packages.push(`uvx:${uniqueName}:${packageName}`);
                results.foundPackages++;
                return;
            }
            
            // Look for HTTP/SSE URLs
            const urlMatch = html.match(/(https?:\/\/[^\s<"']+(?:\/sse|\/mcp|api\/mcp)[^\s<"']*)/);
            if (urlMatch) {
                const url = urlMatch[1].replace(/[<>"']/g, '');
                const protocol = url.includes('/sse') ? 'sse' : 'http';
                const uniqueName = generateUniqueName(baseServerName, null, url);
                packages.push(`${protocol}:${uniqueName}:${url}`);
                results.foundPackages++;
                return;
            }
            
            results.notFound++;
            
        } catch (error) {
            console.error(`Error analyzing ${server.slug}:`, error);
            results.notFound++;
            results.errors.push(`${server.slug}: ${error.message}`);
        }
    }
    
    // Collect all server links from all pages
    console.log('Collecting server links from all pages...');
    
    let currentPage = 1;
    let hasMorePages = true;
    const allServers = [];
    
    while (hasMorePages && currentPage <= 506) {
        const serversOnPage = await getServerLinksFromPage(currentPage);
        
        if (serversOnPage.length === 0) {
            hasMorePages = false;
        } else {
            allServers.push(...serversOnPage);
            results.totalPages = currentPage;
            
            if (currentPage % 10 === 0) {
                console.log(`Processed ${currentPage} pages, found ${allServers.length} servers so far...`);
            }
        }
        
        currentPage++;
        await new Promise(resolve => setTimeout(resolve, 50)); // Rate limiting
        
        // Stop if we're getting fewer servers (likely end of results)
        if (currentPage > 10 && serversOnPage.length < 20) {
            console.log(`Fewer servers on page ${currentPage-1}, stopping crawl`);
            break;
        }
    }
    
    // Deduplicate servers
    const uniqueServers = Array.from(new Map(allServers.map(s => [s.slug, s])).values());
    results.totalServers = uniqueServers.length;
    
    console.log(`\nFound ${uniqueServers.length} unique servers across ${results.totalPages} pages`);
    console.log('Extracting packages from each server...\n');
    
    // Process servers in batches
    const batchSize = 10;
    for (let i = 0; i < uniqueServers.length; i += batchSize) {
        const batch = uniqueServers.slice(i, Math.min(i + batchSize, uniqueServers.length));
        const progress = Math.round((i / uniqueServers.length) * 100);
        
        console.log(`Progress: ${progress}% (${i + 1}-${Math.min(i + batchSize, uniqueServers.length)}/${uniqueServers.length})`);
        
        await Promise.all(batch.map(server => extractPackageFromServer(server)));
        
        // Rate limiting
        if (i + batchSize < uniqueServers.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    // Remove duplicates from packages
    const uniquePackages = [...new Set(packages)];
    
    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 PACKAGE EXTRACTION SUMMARY');
    console.log('='.repeat(60));
    console.log(`Pages crawled: ${results.totalPages}`);
    console.log(`Servers found: ${results.totalServers}`);
    console.log(`Servers processed: ${results.processedServers}`);
    console.log(`Packages found: ${results.foundPackages}`);
    console.log(`Unique packages: ${uniquePackages.length}`);
    console.log(`Servers without packages: ${results.notFound}`);
    console.log('='.repeat(60));
    
    // Create the text file content
    const textContent = uniquePackages.join('\n');
    
    // Download as text file
    const blob = new Blob([textContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mcp-packages-${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    
    console.log('\n💾 Downloading package list...');
    a.click();
    
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
    
    // Also show the results in console
    console.log('\n📝 EXTRACTED PACKAGES:');
    console.log('='.repeat(60));
    uniquePackages.forEach((pkg, i) => console.log(`${i + 1}. ${pkg}`));
    
    // Copy to clipboard
    if (navigator.clipboard) {
        navigator.clipboard.writeText(textContent).then(() => {
            console.log('\n✅ Package list copied to clipboard!');
        }).catch(() => {
            console.log('\n❌ Could not copy to clipboard');
        });
    }
    
    if (results.errors.length > 0) {
        console.log('\n❌ Errors encountered:');
        results.errors.slice(0, 10).forEach(error => console.log(`  - ${error}`));
        if (results.errors.length > 10) {
            console.log(`  ... and ${results.errors.length - 10} more errors`);
        }
    }
    
    console.log('\n🎉 Package extraction complete!');
    console.log(`📁 Downloaded: mcp-packages-${new Date().toISOString().split('T')[0]}.txt`);
    
    return {
        packages: uniquePackages,
        stats: results
    };
})();