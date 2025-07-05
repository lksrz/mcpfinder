// Fixed browser console script for mcp.so dynamic content
// Paste this into browser console while on https://mcp.so/servers

(async function() {
    console.log('🚀 Starting MCP.so package extraction (fixed for dynamic content)');
    
    const packages = [];
    const usedNames = new Set();
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
    function waitForElements(selector, timeout = 10000) {
        return new Promise((resolve) => {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
                resolve(elements);
                return;
            }
            
            const observer = new MutationObserver(() => {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    observer.disconnect();
                    resolve(elements);
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
    
    // Function to get server links from current page
    async function getServerLinksFromCurrentPage() {
        console.log('Waiting for server links to load...');
        
        // Wait for links to load (try multiple possible selectors)
        const possibleSelectors = [
            'a[href*="/servers/"]:not([href$="/servers"])',
            '[href*="/servers/"]:not([href$="/servers"])',
            'a[href^="/servers/"]',
            'a[href*="mcp.so/servers/"]'
        ];
        
        let serverLinks = [];
        
        for (const selector of possibleSelectors) {
            await waitForElements(selector, 5000);
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
    
    // Function to navigate to next page and get links
    async function getServerLinksFromPage(pageNum) {
        try {
            console.log(`Navigating to page ${pageNum}...`);
            
            // Navigate to the page
            const url = `https://mcp.so/servers?page=${pageNum}`;
            
            if (pageNum === 1 && window.location.href.includes('mcp.so/servers')) {
                // We're already on the servers page
                return await getServerLinksFromCurrentPage();
            } else {
                // Navigate to the page
                window.history.pushState({}, '', url);
                window.location.href = url;
                
                // Wait for page to load
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                return await getServerLinksFromCurrentPage();
            }
            
        } catch (error) {
            console.error(`Error getting page ${pageNum}:`, error);
            results.errors.push(`Page ${pageNum}: ${error.message}`);
            return [];
        }
    }
    
    // Function to extract package from server page
    async function extractPackageFromServer(server) {
        try {
            const serverUrl = `${server.href}?tab=content`;
            console.log(`Analyzing: ${server.name || server.slug}`);
            
            const response = await fetch(serverUrl);
            const html = await response.text();
            
            results.processedServers++;
            
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
                                    packages.push(`npx:${uniqueName}:${packageName}`);
                                    results.foundPackages++;
                                    return;
                                }
                            } else if (serverConfig.command === 'uvx' && serverConfig.args?.[0]) {
                                const packageName = serverConfig.args[0];
                                const uniqueName = generateUniqueName(baseServerName, packageName, null);
                                packages.push(`uvx:${uniqueName}:${packageName}`);
                                results.foundPackages++;
                                return;
                            } else if (serverConfig.args?.includes('mcp-remote')) {
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
                        // Continue to other methods
                    }
                }
            }
            
            // Look for other patterns
            const smitheryMatch = html.match(/npx -y @smithery\/cli@latest install ([^\s]+)/);
            if (smitheryMatch) {
                const packageName = smitheryMatch[1];
                const uniqueName = generateUniqueName(baseServerName, packageName, null);
                packages.push(`npx:${uniqueName}:${packageName}`);
                results.foundPackages++;
                return;
            }
            
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
            
            const uvxMatch = html.match(/uvx\s+([A-Za-z0-9_.-]+)/);
            if (uvxMatch?.[1]) {
                const packageName = uvxMatch[1];
                const uniqueName = generateUniqueName(baseServerName, packageName, null);
                packages.push(`uvx:${uniqueName}:${packageName}`);
                results.foundPackages++;
                return;
            }
            
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
    
    // Main extraction logic
    console.log('Starting extraction from current page...');
    
    // First, get servers from the current page
    let allServers = await getServerLinksFromCurrentPage();
    console.log(`Found ${allServers.length} servers on current page`);
    
    if (allServers.length === 0) {
        console.log('❌ No servers found on current page. Make sure you are on https://mcp.so/servers');
        return;
    }
    
    // Process first batch from current page
    console.log('Processing servers from current page...');
    const batchSize = 5;
    
    for (let i = 0; i < allServers.length; i += batchSize) {
        const batch = allServers.slice(i, Math.min(i + batchSize, allServers.length));
        const progress = Math.round((i / allServers.length) * 100);
        
        console.log(`Progress: ${progress}% (${i + 1}-${Math.min(i + batchSize, allServers.length)}/${allServers.length})`);
        
        await Promise.all(batch.map(server => extractPackageFromServer(server)));
        
        if (i + batchSize < allServers.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    // Print results
    const uniquePackages = [...new Set(packages)];
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 PACKAGE EXTRACTION SUMMARY');
    console.log('='.repeat(60));
    console.log(`Servers found: ${allServers.length}`);
    console.log(`Servers processed: ${results.processedServers}`);
    console.log(`Packages found: ${results.foundPackages}`);
    console.log(`Unique packages: ${uniquePackages.length}`);
    console.log(`Servers without packages: ${results.notFound}`);
    console.log('='.repeat(60));
    
    if (uniquePackages.length === 0) {
        console.log('❌ No packages found. The site structure might have changed.');
        return;
    }
    
    // Create and download file
    const textContent = uniquePackages.join('\n');
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
    
    // Show results
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
    }
    
    console.log('\n🎉 Extraction complete!');
    console.log(`📁 Downloaded: mcp-packages-${new Date().toISOString().split('T')[0]}.txt`);
    console.log('\n💡 Note: This extracted from current page only. To get all servers, you would need to manually navigate through pages or use a different approach.');
    
    return {
        packages: uniquePackages,
        stats: results
    };
})();