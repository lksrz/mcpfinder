// Final fixed script that properly extracts clean JSON from HTML
// Paste this into browser console while on https://mcp.so/servers

(async function() {
    console.log('🚀 Starting MCP.so package extraction (clean JSON extraction)');
    
    const allPackages = [];
    const usedNames = new Set();
    const results = {
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
    function waitForContent(timeout = 15000) {
        return new Promise((resolve) => {
            const checkContent = () => {
                const serverLinks = document.querySelectorAll('a[href^="/server/"]');
                if (serverLinks.length > 0) {
                    resolve();
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
                resolve();
            }, timeout);
        });
    }
    
    // Function to get server links from current page
    async function getServerLinksFromCurrentPage() {
        console.log('⏳ Waiting for content to load...');
        await waitForContent();
        
        const serverLinks = [];
        const links = document.querySelectorAll('a[href^="/server/"]');
        
        console.log(`Found ${links.length} server links`);
        
        links.forEach(link => {
            const href = link.getAttribute('href');
            if (href) {
                const fullUrl = `https://mcp.so${href}`;
                
                // Extract server name from the DOM structure
                let serverName = 'Unknown';
                const nameElement = link.querySelector('.font-medium');
                if (nameElement) {
                    serverName = nameElement.textContent?.trim() || 'Unknown';
                }
                
                // Create unique slug from href
                const slug = href.replace('/server/', '').replace(/\?.*$/, '');
                
                if (!serverLinks.find(s => s.slug === slug)) {
                    serverLinks.push({
                        href: fullUrl,
                        slug: slug,
                        name: serverName
                    });
                }
            }
        });
        
        return serverLinks;
    }
    
    // Function to clean HTML content and extract valid JSON
    function extractCleanJsonFromHtml(htmlContent) {
        // Create a temporary DOM element to parse HTML
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlContent;
        
        // Get the plain text content (this removes all HTML tags)
        const plainText = tempDiv.textContent || tempDiv.innerText || '';
        
        // Find all potential JSON objects that contain mcpServers
        const potentialJsonMatches = [];
        let startIndex = 0;
        
        while (true) {
            // Find the start of a potential JSON object
            const mcpServersIndex = plainText.indexOf('"mcpServers"', startIndex);
            if (mcpServersIndex === -1) break;
            
            // Find the opening brace before mcpServers
            let openBraceIndex = mcpServersIndex;
            while (openBraceIndex > 0 && plainText[openBraceIndex] !== '{') {
                openBraceIndex--;
            }
            
            if (openBraceIndex === 0 && plainText[0] !== '{') {
                startIndex = mcpServersIndex + 1;
                continue;
            }
            
            // Now find the matching closing brace
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
            console.log(`📡 Fetching: ${server.name}`);
            
            // Try the server page with content tab
            const serverUrl = server.href.includes('?') 
                ? server.href.replace(/\?.*$/, '?tab=content')
                : `${server.href}?tab=content`;
            
            const response = await fetch(serverUrl);
            if (!response.ok) {
                console.warn(`❌ HTTP ${response.status} for ${server.name}`);
                return null;
            }
            
            const html = await response.text();
            const baseServerName = server.name.replace(/:/g, '').trim();
            
            console.log(`🔍 Processing ${server.name}...`);
            
            // PRIORITY 1: Look for "Server Config" section specifically
            const serverConfigPattern = /<h2[^>]*>Server Config<\/h2>([\s\S]*?)(?=<h2|<div class="rounded-lg mb-8"|$)/i;
            const serverConfigMatch = html.match(serverConfigPattern);
            
            if (serverConfigMatch) {
                console.log(`🎯 Found "Server Config" section for ${server.name}`);
                const configSection = serverConfigMatch[1];
                
                // Extract clean JSON from this section
                const jsonMatches = extractCleanJsonFromHtml(configSection);
                
                if (jsonMatches && jsonMatches.length > 0) {
                    for (const jsonMatch of jsonMatches) {
                        const result = parseJsonConfig(jsonMatch, baseServerName, server.name);
                        if (result) {
                            console.log(`✅ ${server.name}: Found in Server Config - ${result}`);
                            return result;
                        }
                    }
                }
            }
            
            // PRIORITY 2: Look for JSON in code blocks with clean extraction
            const codeBlockPattern = /<pre[^>]*>[\s\S]*?<code[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/gi;
            let codeMatch;
            
            while ((codeMatch = codeBlockPattern.exec(html)) !== null) {
                const codeContent = codeMatch[1];
                const jsonMatches = extractCleanJsonFromHtml(codeContent);
                
                if (jsonMatches && jsonMatches.length > 0) {
                    for (const jsonMatch of jsonMatches) {
                        const result = parseJsonConfig(jsonMatch, baseServerName, server.name);
                        if (result) {
                            console.log(`✅ ${server.name}: Found in code block - ${result}`);
                            return result;
                        }
                    }
                }
            }
            
            // PRIORITY 3: Look anywhere but filter heavily
            const allJsonMatches = extractCleanJsonFromHtml(html);
            if (allJsonMatches && allJsonMatches.length > 0) {
                // Sort by relevance - prefer configs that don't look like examples
                const sortedMatches = allJsonMatches.sort((a, b) => {
                    const aScore = getRelevanceScore(a, server.name);
                    const bScore = getRelevanceScore(b, server.name);
                    return bScore - aScore; // Higher score first
                });
                
                for (const jsonMatch of sortedMatches) {
                    const result = parseJsonConfig(jsonMatch, baseServerName, server.name);
                    if (result) {
                        console.log(`✅ ${server.name}: Found in page content - ${result}`);
                        return result;
                    }
                }
            }
            
            // PRIORITY 4: Look for other installation methods
            return findAlternativeInstallMethod(html, baseServerName, server.name);
            
        } catch (error) {
            console.error(`❌ Error analyzing ${server.name}:`, error.message);
            results.errors.push(`${server.name}: ${error.message}`);
            return null;
        }
    }
    
    // Function to score JSON relevance (higher = more likely to be the real config)
    function getRelevanceScore(jsonString, serverName) {
        let score = 0;
        
        // Penalty for example/template indicators
        if (jsonString.includes('@modelcontextprotocol/inspector')) score -= 10;
        if (jsonString.includes('"neon"') && !serverName.toLowerCase().includes('neon')) score -= 10;
        if (jsonString.includes('@playwright/mcp') && !serverName.toLowerCase().includes('playwright')) score -= 10;
        if (jsonString.includes('example')) score -= 5;
        if (jsonString.includes('template')) score -= 5;
        if (jsonString.includes('your-')) score -= 5;
        
        // Bonus for server-specific content
        if (jsonString.toLowerCase().includes(serverName.toLowerCase().replace(/[^a-z0-9]/g, ''))) score += 5;
        
        // Bonus for uvx commands (less likely to be examples)
        if (jsonString.includes('"uvx"')) score += 3;
        
        // Bonus for unique package names
        if (jsonString.includes('mcp-server-time')) score += 5;
        if (jsonString.includes('edgeone-pages-mcp')) score += 5;
        if (jsonString.includes('agentql-mcp')) score += 5;
        
        return score;
    }
    
    // Helper function to parse JSON config with better validation
    function parseJsonConfig(jsonMatch, baseServerName, serverName) {
        try {
            // Clean up the JSON string
            const cleanJson = jsonMatch.trim();
            const config = JSON.parse(cleanJson);
            
            if (config.mcpServers) {
                const serverKey = Object.keys(config.mcpServers)[0];
                const serverConfig = config.mcpServers[serverKey];
                
                console.log(`🔎 ${serverName}: Parsing config for key "${serverKey}":`, serverConfig);
                
                // Handle different config types
                if (serverConfig.command === 'npx' && serverConfig.args?.length > 0) {
                    // Handle args like ["-y", "package-name"] or ["package-name"]
                    let packageName;
                    if (serverConfig.args[0] === '-y' && serverConfig.args[1]) {
                        packageName = serverConfig.args[1];
                    } else {
                        packageName = serverConfig.args[0];
                    }
                    
                    if (packageName && !packageName.includes('@mcpfinder') && packageName !== '-y') {
                        const uniqueName = generateUniqueName(baseServerName, packageName, null);
                        return `npx:${uniqueName}:${packageName}`;
                    }
                } else if (serverConfig.command === 'uvx' && serverConfig.args?.[0]) {
                    const packageName = serverConfig.args[0];
                    const uniqueName = generateUniqueName(baseServerName, packageName, null);
                    return `uvx:${uniqueName}:${packageName}`;
                } else if (serverConfig.url) {
                    // Handle URL-based configs like EdgeOne Pages
                    const url = serverConfig.url;
                    const protocol = url.includes('/sse') ? 'sse' : 'http';
                    const uniqueName = generateUniqueName(baseServerName, null, url);
                    return `${protocol}:${uniqueName}:${url}`;
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
            console.log(`❌ JSON parse error for ${serverName}:`, parseError.message);
            console.log(`   JSON candidate (first 200 chars): ${jsonMatch.substring(0, 200)}...`);
        }
        return null;
    }
    
    // Helper function to find alternative install methods
    function findAlternativeInstallMethod(html, baseServerName, serverName) {
        console.log(`🔍 Looking for alternative install methods for ${serverName}`);
        
        // Extract clean text from HTML for better pattern matching
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        const cleanText = tempDiv.textContent || tempDiv.innerText || '';
        
        // Look for Smithery install commands
        const smitheryMatch = cleanText.match(/npx -y @smithery\/cli@latest install ([^\s]+)/);
        if (smitheryMatch) {
            const packageName = smitheryMatch[1];
            const uniqueName = generateUniqueName(baseServerName, packageName, null);
            return `npx:${uniqueName}:${packageName}`;
        }
        
        // Look for standalone NPX commands (exclude common examples)
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
        
        // Look for HTTP/SSE URLs
        const urlMatch = cleanText.match(/(https?:\/\/[^\s"']+(?:\/sse|\/mcp|api\/mcp)[^\s"']*)/);
        if (urlMatch) {
            const url = urlMatch[1];
            const protocol = url.includes('/sse') ? 'sse' : 'http';
            const uniqueName = generateUniqueName(baseServerName, null, url);
            return `${protocol}:${uniqueName}:${url}`;
        }
        
        console.warn(`❌ No valid package config found for: ${serverName}`);
        return null;
    }
    
    // Function to download file
    function downloadFile(packages, filename) {
        if (packages.length === 0) {
            console.warn('⚠️ No packages to download');
            return;
        }
        
        console.log(`📥 Preparing download of ${packages.length} packages...`);
        const content = packages.join('\n');
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        
        try {
            a.click();
            console.log(`💾 Downloaded: ${filename}`);
        } catch (e) {
            console.error('❌ Download failed:', e);
        }
        
        setTimeout(() => {
            if (document.body.contains(a)) {
                document.body.removeChild(a);
            }
            URL.revokeObjectURL(url);
        }, 1000);
    }
    
    // Main execution
    console.log('🔍 Scanning current page for servers...');
    
    const serverLinks = await getServerLinksFromCurrentPage();
    
    if (serverLinks.length === 0) {
        console.log('❌ No servers found! Make sure you are on https://mcp.so/servers and the page is fully loaded');
        return;
    }
    
    // Get current page number
    const currentUrl = new URL(window.location.href);
    const currentPageNum = parseInt(currentUrl.searchParams.get('page')) || 1;
    
    console.log(`✅ Found ${serverLinks.length} servers on page ${currentPageNum}`);
    console.log('Sample servers:', serverLinks.slice(0, 3).map(s => s.name).join(', '));
    
    // Process servers in batches
    console.log(`\n🔄 Processing ${serverLinks.length} servers...`);
    
    const batchSize = 2; // Even smaller batch for detailed logging
    for (let i = 0; i < serverLinks.length; i += batchSize) {
        const batch = serverLinks.slice(i, Math.min(i + batchSize, serverLinks.length));
        const batchNum = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(serverLinks.length / batchSize);
        
        console.log(`\n📦 Batch ${batchNum}/${totalBatches}: Processing servers ${i + 1}-${Math.min(i + batchSize, serverLinks.length)}`);
        
        const batchResults = await Promise.all(batch.map(server => extractPackageFromServer(server)));
        
        batchResults.forEach(result => {
            if (result) {
                allPackages.push(result);
                results.foundPackages++;
            } else {
                results.notFound++;
            }
        });
        
        // Progress update
        const processed = Math.min(i + batchSize, serverLinks.length);
        const progress = Math.round((processed / serverLinks.length) * 100);
        console.log(`   Progress: ${progress}% (${processed}/${serverLinks.length})`);
        
        // Rate limiting
        if (i + batchSize < serverLinks.length) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    
    // Results and download
    console.log('\n' + '='.repeat(60));
    console.log(`📊 PAGE ${currentPageNum} RESULTS`);
    console.log('='.repeat(60));
    console.log(`Total servers: ${serverLinks.length}`);
    console.log(`✅ Packages found: ${results.foundPackages}`);
    console.log(`❌ No packages: ${results.notFound}`);
    console.log(`🚫 Errors: ${results.errors.length}`);
    console.log('='.repeat(60));
    
    if (allPackages.length > 0) {
        // Remove duplicates
        const uniquePackages = [...new Set(allPackages)];
        
        console.log(`\n📝 EXTRACTED PACKAGES (${uniquePackages.length} unique):`);
        uniquePackages.forEach((pkg, i) => console.log(`${i + 1}. ${pkg}`));
        
        // Download file
        downloadFile(uniquePackages, `mcp-packages-page-${currentPageNum}-${new Date().toISOString().split('T')[0]}.txt`);
        
        // Copy to clipboard
        if (navigator.clipboard) {
            navigator.clipboard.writeText(uniquePackages.join('\n')).then(() => {
                console.log('\n✅ All packages copied to clipboard!');
            }).catch(() => {
                console.log('\n❌ Could not copy to clipboard');
            });
        }
    } else {
        console.log('\n❌ No packages extracted from this page');
    }
    
    if (results.errors.length > 0) {
        console.log('\n🚫 Errors encountered:');
        results.errors.slice(0, 5).forEach(error => console.log(`  - ${error}`));
        if (results.errors.length > 5) {
            console.log(`  ... and ${results.errors.length - 5} more errors`);
        }
    }
    
    console.log(`\n🎉 Page ${currentPageNum} complete!`);
    
    // Check if there's a next page and continue automatically
    const nextPageButton = document.querySelector('a[href*="page=' + (currentPageNum + 1) + '"]');
    const hasMorePages = nextPageButton || currentPageNum === 1; // Assume more pages if we're on page 1
    
    if (hasMorePages && currentPageNum < 10) { // Limit to 10 pages for safety
        console.log(`\n🔄 Moving to page ${currentPageNum + 1}...`);
        
        // Navigate to next page
        const nextPageUrl = `${window.location.origin}${window.location.pathname}?page=${currentPageNum + 1}`;
        
        try {
            // Fetch the next page content
            const nextPageResponse = await fetch(nextPageUrl);
            if (nextPageResponse.ok) {
                const nextPageHtml = await nextPageResponse.text();
                
                // Create a temporary document to parse the next page
                const tempDoc = document.implementation.createHTMLDocument();
                tempDoc.documentElement.innerHTML = nextPageHtml;
                
                // Extract server links from the next page
                const nextPageLinks = Array.from(tempDoc.querySelectorAll('a[href^="/server/"]')).map(link => {
                    const href = link.getAttribute('href');
                    let serverName = 'Unknown';
                    const nameElement = link.querySelector('.font-medium');
                    if (nameElement) {
                        serverName = nameElement.textContent?.trim() || 'Unknown';
                    }
                    
                    return {
                        href: `https://mcp.so${href}`,
                        slug: href.replace('/server/', '').replace(/\?.*$/, ''),
                        name: serverName
                    };
                }).filter(link => link.slug);
                
                if (nextPageLinks.length > 0) {
                    console.log(`\n📄 Page ${currentPageNum + 1}: Found ${nextPageLinks.length} servers`);
                    
                    // Process next page servers
                    for (let i = 0; i < nextPageLinks.length; i += batchSize) {
                        const batch = nextPageLinks.slice(i, Math.min(i + batchSize, nextPageLinks.length));
                        const batchNum = Math.floor(i / batchSize) + 1;
                        const totalBatches = Math.ceil(nextPageLinks.length / batchSize);
                        
                        console.log(`\n📦 Page ${currentPageNum + 1} - Batch ${batchNum}/${totalBatches}: Processing servers ${i + 1}-${Math.min(i + batchSize, nextPageLinks.length)}`);
                        
                        const batchResults = await Promise.all(batch.map(server => extractPackageFromServer(server)));
                        
                        batchResults.forEach(result => {
                            if (result) {
                                allPackages.push(result);
                                results.foundPackages++;
                            } else {
                                results.notFound++;
                            }
                        });
                        
                        // Rate limiting
                        if (i + batchSize < nextPageLinks.length) {
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        }
                    }
                    
                    // Download updated file with all pages
                    const uniquePackages = [...new Set(allPackages)];
                    downloadFile(uniquePackages, `mcp-packages-all-pages-${new Date().toISOString().split('T')[0]}.txt`);
                    
                    console.log(`\n📊 TOTAL RESULTS (Pages 1-${currentPageNum + 1})`);
                    console.log('='.repeat(60));
                    console.log(`✅ Total packages found: ${results.foundPackages}`);
                    console.log(`❌ Servers without packages: ${results.notFound}`);
                    console.log(`📦 Unique packages: ${uniquePackages.length}`);
                    console.log('='.repeat(60));
                } else {
                    console.log(`\n❌ No servers found on page ${currentPageNum + 1}, stopping`);
                }
            } else {
                console.log(`\n❌ Failed to fetch page ${currentPageNum + 1}, stopping`);
            }
        } catch (error) {
            console.error(`\n❌ Error processing page ${currentPageNum + 1}:`, error);
        }
    } else {
        console.log('\n🏁 Finished processing all available pages!');
        console.log('\n💡 Final summary:');
        console.log(`  - Total pages processed: ${currentPageNum}`);
        console.log(`  - Total packages found: ${results.foundPackages}`);
        console.log(`  - Servers without packages: ${results.notFound}`);
    }
    
    return {
        pages: currentPageNum,
        packages: allPackages,
        stats: results
    };
})();