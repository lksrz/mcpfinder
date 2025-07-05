// Auto-crawling script that processes pages automatically
// Usage examples:
// processPages()           - Start from page 1
// processPages(3)          - Start from page 3  
// processPages(5, 10)      - Process pages 5-10 only

async function processPages(startPage = 1, endPage = null) {
    console.log(`🚀 Starting MCP.so extraction from page ${startPage}${endPage ? ` to ${endPage}` : ' to end'}`);
    
    const allPackages = [];
    const usedNames = new Set();
    const results = {
        foundPackages: 0,
        notFound: 0,
        errors: [],
        pagesProcessed: 0
    };
    
    // Function to generate unique server name
    function generateUniqueName(baseName, packageName, url) {
        let cleanBaseName = baseName.replace(/:/g, '-').trim();
        
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
    
    // Function to clean HTML content and extract valid JSON
    function extractCleanJsonFromHtml(htmlContent) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlContent;
        const plainText = tempDiv.textContent || tempDiv.innerText || '';
        
        const potentialJsonMatches = [];
        let startIndex = 0;
        
        while (true) {
            const mcpServersIndex = plainText.indexOf('"mcpServers"', startIndex);
            if (mcpServersIndex === -1) break;
            
            let openBraceIndex = mcpServersIndex;
            while (openBraceIndex > 0 && plainText[openBraceIndex] !== '{') {
                openBraceIndex--;
            }
            
            if (openBraceIndex === 0 && plainText[0] !== '{') {
                startIndex = mcpServersIndex + 1;
                continue;
            }
            
            let braceCount = 0;
            let closeBraceIndex = openBraceIndex;
            
            for (let i = openBraceIndex; i < plainText.length; i++) {
                if (plainText[i] === '{') {
                    braceCount++;
                } else if (plainText[i] === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        closeBraceIndex = i;
                        break;
                    }
                }
            }
            
            if (braceCount === 0) {
                const jsonCandidate = plainText.substring(openBraceIndex, closeBraceIndex + 1);
                potentialJsonMatches.push(jsonCandidate);
            }
            
            startIndex = mcpServersIndex + 1;
        }
        
        return potentialJsonMatches;
    }
    
    // Function to extract package data from server page
    async function extractPackageFromServer(server) {
        try {
            console.log(`🔍 Fetching: ${server.name}`);
            const serverUrl = server.href.includes('?') 
                ? server.href.replace(/\?.*$/, '?tab=content')
                : `${server.href}?tab=content`;
            
            // Add timeout to fetch requests
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
            
            const response = await fetch(serverUrl, { 
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; MCPFinder)'
                }
            });
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                console.log(`❌ HTTP ${response.status} for ${server.name}`);
                return null;
            }
            
            const html = await response.text();
            const baseServerName = server.name.replace(/:/g, '-').trim();
            
            // Look for "Server Config" section specifically
            const serverConfigPattern = /<h2[^>]*>Server Config<\/h2>([\s\S]*?)(?=<h2|<div class="rounded-lg mb-8"|$)/i;
            const serverConfigMatch = html.match(serverConfigPattern);
            
            if (serverConfigMatch) {
                const configSection = serverConfigMatch[1];
                const jsonMatches = extractCleanJsonFromHtml(configSection);
                
                if (jsonMatches && jsonMatches.length > 0) {
                    for (const jsonMatch of jsonMatches) {
                        // Check if this JSON contains supported commands/protocols
                        const hasSupported = jsonMatch.includes('"npx"') || 
                                           jsonMatch.includes('"uvx"') || 
                                           jsonMatch.includes('http://') || 
                                           jsonMatch.includes('https://') ||
                                           jsonMatch.includes('/sse');
                        
                        if (!hasSupported) {
                            // Skip this server entirely if Server Config doesn't have supported protocols
                            return null;
                        }
                        
                        const result = parseJsonConfig(jsonMatch, baseServerName, server.name);
                        if (result) {
                            return result;
                        }
                    }
                }
                
                // If we found Server Config section but no valid JSON, skip this server
                return null;
            }
            
            // If no Server Config section found, skip this server (don't look elsewhere)
            return null;
            
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log(`⏰ Timeout for ${server.name}`);
                results.errors.push(`${server.name}: Request timeout`);
            } else {
                console.log(`❌ Error for ${server.name}: ${error.message}`);
                results.errors.push(`${server.name}: ${error.message}`);
            }
            return null;
        }
    }
    
    // Helper function to parse JSON config
    function parseJsonConfig(jsonMatch, baseServerName, serverName) {
        try {
            const cleanJson = jsonMatch.trim();
            const config = JSON.parse(cleanJson);
            
            if (config.mcpServers) {
                const serverKey = Object.keys(config.mcpServers)[0];
                const serverConfig = config.mcpServers[serverKey];
                
                if (serverConfig.command === 'npx' && serverConfig.args?.length > 0) {
                    // Check if this is a mcp-remote case first
                    const remoteIndex = serverConfig.args.findIndex(arg => arg.includes('mcp-remote'));
                    if (remoteIndex >= 0 && serverConfig.args[remoteIndex + 1]) {
                        const url = serverConfig.args[remoteIndex + 1];
                        const protocol = url.includes('/sse') ? 'sse' : 'http';
                        const uniqueName = generateUniqueName(baseServerName, null, url);
                        return `${protocol}:${uniqueName}:${url}`;
                    }
                    
                    // Regular npx package case
                    let packageName;
                    if (serverConfig.args[0] === '-y' && serverConfig.args[1]) {
                        packageName = serverConfig.args[1];
                    } else {
                        packageName = serverConfig.args[0];
                    }
                    
                    if (packageName && !packageName.includes('@mcpfinder') && packageName !== '-y' && !packageName.includes('mcp-remote')) {
                        const uniqueName = generateUniqueName(baseServerName, packageName, null);
                        return `npx:${uniqueName}:${packageName}`;
                    }
                } else if (serverConfig.command === 'uvx' && serverConfig.args?.[0]) {
                    const packageName = serverConfig.args[0];
                    const uniqueName = generateUniqueName(baseServerName, packageName, null);
                    return `uvx:${uniqueName}:${packageName}`;
                } else if (serverConfig.url) {
                    const url = serverConfig.url;
                    const protocol = url.includes('/sse') ? 'sse' : 'http';
                    const uniqueName = generateUniqueName(baseServerName, null, url);
                    return `${protocol}:${uniqueName}:${url}`;
                }
            }
        } catch (parseError) {
            // Continue
        }
        return null;
    }
    
    // Helper function to find alternative install methods
    function findAlternativeInstallMethod(html, baseServerName, serverName) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        const cleanText = tempDiv.textContent || tempDiv.innerText || '';
        
        // Look for NPX commands
        const npxMatches = cleanText.matchAll(/npx\s+(?:-y\s+)?([A-Za-z0-9@/._-]+)/g);
        for (const match of npxMatches) {
            const packageName = match[1];
            if (!packageName.includes('@mcpfinder') && 
                !packageName.includes('@smithery') && 
                !packageName.includes('inspector') &&
                packageName !== 'neon' &&
                packageName !== 'mode' &&
                packageName.length > 2) {
                const uniqueName = generateUniqueName(baseServerName, packageName, null);
                return `npx:${uniqueName}:${packageName}`;
            }
        }
        
        // Look for UVX commands
        const uvxMatch = cleanText.match(/uvx\s+([A-Za-z0-9_.-]+)/);
        if (uvxMatch?.[1] && uvxMatch[1] !== 'neon' && uvxMatch[1] !== 'mode') {
            const packageName = uvxMatch[1];
            const uniqueName = generateUniqueName(baseServerName, packageName, null);
            return `uvx:${uniqueName}:${packageName}`;
        }
        
        return null;
    }
    
    // Function to get server links from HTML
    function getServerLinksFromHtml(html, pageNum) {
        const tempDoc = document.implementation.createHTMLDocument();
        tempDoc.documentElement.innerHTML = html;
        
        const serverLinks = [];
        const links = tempDoc.querySelectorAll('a[href^="/server/"]');
        
        links.forEach(link => {
            const href = link.getAttribute('href');
            if (href) {
                let serverName = 'Unknown';
                const nameElement = link.querySelector('.font-medium');
                if (nameElement) {
                    serverName = nameElement.textContent?.trim() || 'Unknown';
                }
                
                const slug = href.replace('/server/', '').replace(/\?.*$/, '');
                if (!serverLinks.find(s => s.slug === slug)) {
                    serverLinks.push({
                        href: `https://mcp.so${href}`,
                        slug: slug,
                        name: serverName
                    });
                }
            }
        });
        
        return serverLinks;
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
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        
        setTimeout(() => {
            if (document.body.contains(a)) {
                document.body.removeChild(a);
            }
            URL.revokeObjectURL(url);
        }, 1000);
        
        console.log(`💾 Downloaded: ${filename}`);
    }
    
    // Function to process a single page
    async function processPage(pageNum) {
        console.log(`\n📄 Processing page ${pageNum}...`);
        
        const pageUrl = `https://mcp.so/servers?page=${pageNum}`;
        const response = await fetch(pageUrl);
        
        if (!response.ok) {
            console.log(`❌ Failed to fetch page ${pageNum}`);
            return { success: false, packages: [] };
        }
        
        const html = await response.text();
        const serverLinks = getServerLinksFromHtml(html, pageNum);
        
        if (serverLinks.length === 0) {
            console.log(`❌ No servers found on page ${pageNum}`);
            return { success: false, packages: [] };
        }
        
        console.log(`✅ Found ${serverLinks.length} servers on page ${pageNum}`);
        results.pagesProcessed++;
        
        // Track packages for this page only
        const pagePackages = [];
        let pageFoundCount = 0;
        let pageNotFoundCount = 0;
        
        // Process servers one by one (no batching)
        console.log(`  🔄 Processing ${serverLinks.length} servers individually...`);
        
        for (let i = 0; i < serverLinks.length; i++) {
            const server = serverLinks[i];
            const progress = `${i + 1}/${serverLinks.length}`;
            
            try {
                console.log(`  [${progress}] 🔍 ${server.name}`);
                const result = await extractPackageFromServer(server);
                
                if (result) {
                    pagePackages.push(result);
                    allPackages.push(result);
                    pageFoundCount++;
                    results.foundPackages++;
                    console.log(`  [${progress}] ✅ Found: ${result}`);
                } else {
                    pageNotFoundCount++;
                    results.notFound++;
                    console.log(`  [${progress}] ❌ Skipped: ${server.name}`);
                }
            } catch (error) {
                console.log(`  [${progress}] ❌ Error: ${server.name} - ${error.message}`);
                pageNotFoundCount++;
                results.notFound++;
            }
            
            // Delay between requests to be nice to the server
            if (i < serverLinks.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
        
        // Download separate file for this page
        if (pagePackages.length > 0) {
            const uniquePagePackages = [...new Set(pagePackages)];
            downloadFile(uniquePagePackages, `mcp-packages-page-${pageNum}-${new Date().toISOString().split('T')[0]}.txt`);
            console.log(`📊 Page ${pageNum}: ${pageFoundCount} packages, ${pageNotFoundCount} empty servers`);
        } else {
            console.log(`📊 Page ${pageNum}: No packages found from ${serverLinks.length} servers`);
        }
        
        return { success: true, packages: pagePackages };
    }
    
    // Main execution - process pages
    let currentPage = startPage;
    let hasMorePages = true;
    let consecutiveEmptyPages = 0;
    
    while (hasMorePages && consecutiveEmptyPages < 3 && (endPage === null || currentPage <= endPage)) {
        const result = await processPage(currentPage);
        
        if (!result.success || result.packages.length === 0) {
            consecutiveEmptyPages++;
            console.log(`⚠️ Empty page ${currentPage} (${consecutiveEmptyPages}/3 consecutive empty pages)`);
            
            if (consecutiveEmptyPages >= 3) {
                hasMorePages = false;
                console.log(`\n🏁 Stopped at page ${currentPage} after 3 consecutive empty pages`);
            }
        } else {
            consecutiveEmptyPages = 0; // Reset counter on successful page
        }
        
        currentPage++;
        
        // Show progress every 5 pages
        if (currentPage % 5 === 0) {
            console.log(`\n📊 Progress: Processed ${currentPage - 1} pages, found ${results.foundPackages} packages total`);
        }
    }
    
    // Final results
    console.log('\n' + '='.repeat(70));
    console.log('📊 FINAL RESULTS - ALL PAGES PROCESSED');
    console.log('='.repeat(70));
    console.log(`Pages processed: ${results.pagesProcessed}`);
    console.log(`Total servers found: ${results.foundPackages + results.notFound}`);
    console.log(`✅ Packages extracted: ${results.foundPackages}`);
    console.log(`❌ Servers without packages: ${results.notFound}`);
    console.log(`🚫 Errors: ${results.errors.length}`);
    
    if (allPackages.length > 0) {
        const uniquePackages = [...new Set(allPackages)];
        console.log(`📦 Unique packages: ${uniquePackages.length}`);
        
        // Final download with all results
        downloadFile(uniquePackages, `mcp-packages-ALL-PAGES-${new Date().toISOString().split('T')[0]}.txt`);
        
        // Copy to clipboard
        if (navigator.clipboard) {
            navigator.clipboard.writeText(uniquePackages.join('\n')).then(() => {
                console.log('✅ All packages copied to clipboard!');
            }).catch(() => {
                console.log('❌ Could not copy to clipboard');
            });
        }
        
        console.log('\n📝 Sample packages extracted:');
        uniquePackages.slice(0, 10).forEach((pkg, i) => console.log(`${i + 1}. ${pkg}`));
        if (uniquePackages.length > 10) {
            console.log(`... and ${uniquePackages.length - 10} more packages`);
        }
    }
    
    console.log('\n🎉 ALL PAGES PROCESSING COMPLETE!');
    return {
        pagesProcessed: results.pagesProcessed,
        totalPackages: allPackages.length,
        uniquePackages: [...new Set(allPackages)].length,
        stats: results
    };
}

// Auto-run from page 1 if called directly
// To use with parameters, call: processPages(3) or processPages(5, 10)
processPages();