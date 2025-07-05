// Fixed script with correct selectors for mcp.so
// Paste this into browser console while on https://mcp.so/servers

(async function() {
    console.log('🚀 Starting MCP.so package extraction (fixed selectors)');
    
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
    
    // Function to wait for content to load
    function waitForContent(timeout = 10000) {
        return new Promise((resolve) => {
            const checkContent = () => {
                const serverLinks = document.querySelectorAll('a[href*="/server/"]');
                if (serverLinks.length > 0) {
                    resolve(serverLinks);
                    return true;
                }
                return false;
            };
            
            if (checkContent()) return;
            
            const observer = new MutationObserver(() => {
                if (checkContent()) {
                    observer.disconnect();
                }
            });
            
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
            
            setTimeout(() => {
                observer.disconnect();
                resolve(document.querySelectorAll('a[href*="/server/"]'));
            }, timeout);
        });
    }
    
    // Function to get server links from current page
    async function getServerLinksFromCurrentPage() {
        console.log('⏳ Waiting for content to load...');
        
        // Wait for content to load
        await waitForContent();
        
        let serverLinks = [];
        
        // Updated selectors based on actual page structure
        const selectors = [
            'a[href*="/server/"]',  // Main pattern: /server/name/owner
            'a[href^="/server/"]'   // Alternative pattern
        ];
        
        for (const selector of selectors) {
            const links = document.querySelectorAll(selector);
            
            if (links.length > 0) {
                console.log(`Found ${links.length} links with selector: ${selector}`);
                
                Array.from(links).forEach(link => {
                    const href = link.getAttribute('href');
                    if (href && href.includes('/server/')) {
                        const fullUrl = href.startsWith('http') ? href : `https://mcp.so${href}`;
                        
                        // Extract slug from /server/name/owner pattern
                        const pathParts = href.split('/server/')[1];
                        if (pathParts) {
                            const slug = pathParts.split('?')[0].split('#')[0];
                            
                            // Extract server name from the link text or DOM
                            let name = 'Unknown';
                            
                            // Try to get name from the link text or nearby elements
                            const linkText = link.textContent?.trim();
                            if (linkText && linkText.length > 0 && linkText !== 'Unknown') {
                                name = linkText;
                            } else {
                                // Try to find name in parent container
                                const parent = link.closest('div');
                                if (parent) {
                                    const nameElement = parent.querySelector('.font-medium');
                                    if (nameElement) {
                                        name = nameElement.textContent?.trim() || 'Unknown';
                                    }
                                }
                            }
                            
                            if (slug && !serverLinks.find(s => s.slug === slug)) {
                                serverLinks.push({
                                    href: fullUrl,
                                    slug: slug,
                                    name: name
                                });
                            }
                        }
                    }
                });
                
                if (serverLinks.length > 0) break; // Use first working selector
            }
        }
        
        return serverLinks;
    }
    
    // Function to extract package data from server page
    async function extractPackageFromServer(server) {
        try {
            console.log(`Fetching: ${server.name} (${server.slug})`);
            
            // Try different tab options
            const urls = [
                `${server.href}?tab=content`,
                `${server.href}?tab=tools`,
                server.href
            ];
            
            let html = '';
            let serverUrl = '';
            
            for (const url of urls) {
                try {
                    const response = await fetch(url);
                    if (response.ok) {
                        html = await response.text();
                        serverUrl = url;
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }
            
            if (!html) {
                console.warn(`❌ Could not fetch ${server.name}`);
                return null;
            }
            
            // Extract server name from page if needed
            let serverName = server.name;
            if (serverName === 'Unknown' || !serverName) {
                const titleMatch = html.match(/<title[^>]*>([^<]+)/);
                if (titleMatch) {
                    serverName = titleMatch[1].replace(' | mcp.so', '').trim();
                }
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
    
    // Main logic
    console.log('🔍 Getting servers from current page...');
    
    let allServerLinks = await getServerLinksFromCurrentPage();
    console.log(`Found ${allServerLinks.length} servers on current page`);
    
    if (allServerLinks.length === 0) {
        console.log('❌ No servers found on current page. Make sure you are on https://mcp.so/servers and the page is fully loaded');
        return;
    }
    
    // Log first few servers found
    console.log('Sample servers found:');
    allServerLinks.slice(0, 3).forEach((server, i) => {
        console.log(`  ${i + 1}. ${server.name} (${server.slug})`);
    });
    
    // Get the current page number
    const currentUrl = new URL(window.location.href);
    const currentPageNum = parseInt(currentUrl.searchParams.get('page')) || 1;
    console.log(`Current page: ${currentPageNum}`);
    
    // Process current page servers
    console.log(`Processing ${allServerLinks.length} servers from page ${currentPageNum}...`);
    
    const batchSize = 5;
    for (let i = 0; i < allServerLinks.length; i += batchSize) {
        const batch = allServerLinks.slice(i, Math.min(i + batchSize, allServerLinks.length));
        console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(allServerLinks.length/batchSize)} (servers ${i + 1}-${Math.min(i + batchSize, allServerLinks.length)})...`);
        
        const batchResults = await Promise.all(batch.map(server => extractPackageFromServer(server)));
        
        batchResults.forEach(result => {
            if (result) {
                allPackages.push(result);
                results.foundPackages++;
            }
        });
        
        // Small delay between batches
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Download file for current page
    if (allPackages.length > 0) {
        downloadFile(allPackages, `mcp-packages-page-${currentPageNum}-${new Date().toISOString().split('T')[0]}.txt`);
    }
    
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
        
        // Copy to clipboard
        if (navigator.clipboard) {
            navigator.clipboard.writeText(allPackages.join('\n')).then(() => {
                console.log('\n✅ Packages copied to clipboard!');
            }).catch(() => {
                console.log('\n❌ Could not copy to clipboard');
            });
        }
    } else {
        console.log('\n❌ No packages extracted from this page');
    }
    
    console.log(`\n🎉 Page ${currentPageNum} processing complete!`);
    console.log('\n💡 To process more pages:');
    console.log('1. Navigate to the next page manually');
    console.log('2. Run this script again');
    console.log('3. Repeat for each page');
    
    return {
        page: currentPageNum,
        packages: allPackages,
        stats: results
    };
})();