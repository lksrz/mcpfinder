// Auto-crawling script for all mcp.so pages with separate downloads
// Paste this into browser console while on https://mcp.so/servers

(async function() {
    console.log('🚀 Starting automatic crawl of ALL mcp.so pages');
    
    const allPackages = [];
    const usedNames = new Set();
    const globalResults = {
        totalPages: 0,
        totalServers: 0,
        totalPackages: 0,
        pageResults: []
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
    
    // Function to wait for elements to load
    function waitForElements(selector, timeout = 15000) {
        return new Promise((resolve) => {
            const checkElements = () => {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    resolve(elements);
                    return true;
                }
                return false;
            };
            
            if (checkElements()) return;
            
            const observer = new MutationObserver(() => {
                if (checkElements()) {
                    observer.disconnect();
                }
            });
            
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
            
            setTimeout(() => {
                observer.disconnect();
                resolve(document.querySelectorAll(selector));
            }, timeout);
        });
    }
    
    // Function to navigate to a specific page
    async function navigateToPage(pageNum) {
        console.log(`📄 Navigating to page ${pageNum}...`);
        
        const url = `https://mcp.so/servers?page=${pageNum}`;
        
        // Update URL and trigger navigation
        window.history.pushState({}, '', url);
        window.location.href = url;
        
        // Wait for navigation to complete
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Wait for content to load
        console.log(`⏳ Waiting for page ${pageNum} content to load...`);
        await waitForElements('a[href*="/servers/"]:not([href$="/servers"]), [href*="/servers/"]:not([href$="/servers"])', 10000);
        
        // Additional wait to ensure all content is loaded
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Function to get server links from current page
    function getServerLinksFromCurrentPage() {
        const serverLinks = [];
        
        const possibleSelectors = [
            'a[href*="/servers/"]:not([href$="/servers"])',
            '[href*="/servers/"]:not([href$="/servers"])',
            'a[href^="/servers/"]',
            'a[href*="mcp.so/servers/"]'
        ];
        
        for (const selector of possibleSelectors) {
            const elements = document.querySelectorAll(selector);
            
            if (elements.length > 0) {
                console.log(`Found ${elements.length} links with selector: ${selector}`);
                
                Array.from(elements).forEach(link => {
                    let href = link.getAttribute('href') || link.href;
                    if (href && href.includes('/servers/') && !href.endsWith('/servers')) {
                        if (!href.startsWith('http')) {
                            href = `https://mcp.so${href}`;
                        }
                        const slug = href.split('/servers/')[1].split('?')[0].split('#')[0];
                        
                        if (slug && slug.length > 0 && !serverLinks.find(s => s.slug === slug)) {
                            serverLinks.push({
                                href: href,
                                slug: slug,
                                name: link.textContent?.trim() || slug
                            });
                        }
                    }
                });
                
                if (serverLinks.length > 0) break;
            }
        }
        
        return serverLinks;
    }
    
    // Function to extract package from server page
    async function extractPackageFromServer(server) {
        try {
            const serverUrl = `${server.href}?tab=content`;
            
            const response = await fetch(serverUrl);
            const html = await response.text();
            
            // Extract server name
            let serverName = server.name || server.slug;
            const titleMatch = html.match(/<title[^>]*>([^<]+)/);
            if (titleMatch) {
                serverName = titleMatch[1].replace(' | mcp.so', '').trim();
            }
            
            const baseServerName = serverName.replace(/:/g, '').trim();
            
            // Look for JSON configuration blocks
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
            
            // Look for other patterns
            const smitheryMatch = html.match(/npx -y @smithery\/cli@latest install ([^\s]+)/);
            if (smitheryMatch) {
                const packageName = smitheryMatch[1];
                const uniqueName = generateUniqueName(baseServerName, packageName, null);
                return `npx:${uniqueName}:${packageName}`;
            }
            
            const npxMatches = html.matchAll(/npx\s+(?:-y\s+)?([A-Za-z0-9@/._-]+)/g);
            for (const match of npxMatches) {
                const packageName = match[1];
                if (!packageName.includes('@mcpfinder') && !packageName.includes('@smithery') && packageName.length > 2) {
                    const uniqueName = generateUniqueName(baseServerName, packageName, null);
                    return `npx:${uniqueName}:${packageName}`;
                }
            }
            
            const uvxMatch = html.match(/uvx\s+([A-Za-z0-9_.-]+)/);
            if (uvxMatch?.[1]) {
                const packageName = uvxMatch[1];
                const uniqueName = generateUniqueName(baseServerName, packageName, null);
                return `uvx:${uniqueName}:${packageName}`;
            }
            
            const urlMatch = html.match(/(https?:\/\/[^\s<"']+(?:\/sse|\/mcp|api\/mcp)[^\s<"']*)/);
            if (urlMatch) {
                const url = urlMatch[1].replace(/[<>"']/g, '');
                const protocol = url.includes('/sse') ? 'sse' : 'http';
                const uniqueName = generateUniqueName(baseServerName, null, url);
                return `${protocol}:${uniqueName}:${url}`;
            }
            
            return null;
            
        } catch (error) {
            console.error(`Error analyzing ${server.slug}:`, error);
            return null;
        }
    }
    
    // Function to download file for a page
    function downloadPageFile(packages, pageNum) {
        if (packages.length === 0) return;
        
        const content = packages.join('\n');
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mcp-packages-page-${pageNum}-${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(a);
        
        a.click();
        
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        
        console.log(`💾 Downloaded: mcp-packages-page-${pageNum}-${new Date().toISOString().split('T')[0]}.txt`);
    }
    
    // Main crawling loop
    console.log('Starting automatic page crawling...');
    
    let currentPage = 1;
    let consecutiveEmptyPages = 0;
    const maxEmptyPages = 3; // Stop after 3 consecutive empty pages
    const maxPages = 506; // Safety limit
    
    while (currentPage <= maxPages && consecutiveEmptyPages < maxEmptyPages) {
        try {
            // Navigate to current page
            await navigateToPage(currentPage);
            
            // Get server links from current page
            const serverLinks = getServerLinksFromCurrentPage();
            
            if (serverLinks.length === 0) {
                console.log(`❌ No servers found on page ${currentPage}`);
                consecutiveEmptyPages++;
                
                if (consecutiveEmptyPages >= maxEmptyPages) {
                    console.log(`Stopping after ${maxEmptyPages} consecutive empty pages`);
                    break;
                }
                
                currentPage++;
                continue;
            }
            
            consecutiveEmptyPages = 0; // Reset counter
            console.log(`✅ Found ${serverLinks.length} servers on page ${currentPage}`);
            
            // Process servers from this page
            const pagePackages = [];
            
            console.log(`Processing ${serverLinks.length} servers from page ${currentPage}...`);
            
            // Process in smaller batches to avoid overwhelming
            const batchSize = 3;
            for (let i = 0; i < serverLinks.length; i += batchSize) {
                const batch = serverLinks.slice(i, Math.min(i + batchSize, serverLinks.length));
                
                console.log(`  Batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(serverLinks.length/batchSize)} (servers ${i + 1}-${Math.min(i + batchSize, serverLinks.length)})`);
                
                const batchResults = await Promise.all(
                    batch.map(server => extractPackageFromServer(server))
                );
                
                batchResults.forEach(result => {
                    if (result) {
                        pagePackages.push(result);
                        allPackages.push(result);
                    }
                });
                
                // Small delay between batches
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // Download file for this page
            if (pagePackages.length > 0) {
                downloadPageFile(pagePackages, currentPage);
                console.log(`📦 Page ${currentPage}: Found ${pagePackages.length} packages`);
            } else {
                console.log(`📦 Page ${currentPage}: No packages found`);
            }
            
            // Store page results
            globalResults.pageResults.push({
                page: currentPage,
                servers: serverLinks.length,
                packages: pagePackages.length,
                packageList: pagePackages
            });
            
            globalResults.totalPages++;
            globalResults.totalServers += serverLinks.length;
            globalResults.totalPackages += pagePackages.length;
            
            currentPage++;
            
            // Delay before next page
            await new Promise(resolve => setTimeout(resolve, 2000));
            
        } catch (error) {
            console.error(`Error processing page ${currentPage}:`, error);
            currentPage++;
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
    
    // Download combined file
    if (allPackages.length > 0) {
        const uniquePackages = [...new Set(allPackages)];
        const combinedContent = uniquePackages.join('\n');
        const blob = new Blob([combinedContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mcp-packages-ALL-PAGES-${new Date().toISOString().split('T')[0]}.txt`;
        document.body.appendChild(a);
        
        a.click();
        
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        
        console.log(`💾 Downloaded combined file: mcp-packages-ALL-PAGES-${new Date().toISOString().split('T')[0]}.txt`);
    }
    
    // Final summary
    console.log('\n' + '='.repeat(70));
    console.log('🎉 AUTOMATIC CRAWL COMPLETE!');
    console.log('='.repeat(70));
    console.log(`Pages processed: ${globalResults.totalPages}`);
    console.log(`Total servers found: ${globalResults.totalServers}`);
    console.log(`Total packages extracted: ${globalResults.totalPackages}`);
    console.log(`Unique packages: ${[...new Set(allPackages)].length}`);
    console.log('='.repeat(70));
    
    console.log('\n📁 Files downloaded:');
    globalResults.pageResults.forEach(result => {
        if (result.packages > 0) {
            console.log(`  📄 Page ${result.page}: ${result.packages} packages`);
        }
    });
    console.log(`  📄 Combined: ${[...new Set(allPackages)].length} unique packages`);
    
    return globalResults;
})();