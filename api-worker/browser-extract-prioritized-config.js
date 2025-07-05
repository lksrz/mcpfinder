// Fixed script that prioritizes "Server Config" section
// Paste this into browser console while on https://mcp.so/servers

(async function() {
    console.log('🚀 Starting MCP.so package extraction (prioritized config detection)');
    
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
            
            // PRIORITY 1: Look for "Server Config" section specifically
            const serverConfigMatch = html.match(/<h2[^>]*>Server Config<\/h2>[\s\S]*?<\/div>/i);
            if (serverConfigMatch) {
                console.log(`🎯 Found "Server Config" section for ${server.name}`);
                const configSection = serverConfigMatch[0];
                
                // Look for JSON in this specific section
                const jsonMatches = configSection.match(/{\s*"mcpServers"[\s\S]*?}/g);
                if (jsonMatches) {
                    for (const jsonMatch of jsonMatches) {
                        const result = parseJsonConfig(jsonMatch, baseServerName, server.name);
                        if (result) {
                            console.log(`✅ Found config in Server Config section: ${result}`);
                            return result;
                        }
                    }
                }
            }
            
            // PRIORITY 2: Look for JSON configs in <pre><code> blocks (likely to be actual configs)
            const codeBlockPattern = /<pre[^>]*>[\s\S]*?<code[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/gi;
            let codeMatch;
            while ((codeMatch = codeBlockPattern.exec(html)) !== null) {
                const codeContent = codeMatch[1];
                // Decode HTML entities
                const decodedContent = codeContent
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#x27;/g, "'")
                    .replace(/&amp;/g, '&');
                
                const jsonMatches = decodedContent.match(/{\s*"mcpServers"[\s\S]*?}/g);
                if (jsonMatches) {
                    for (const jsonMatch of jsonMatches) {
                        const result = parseJsonConfig(jsonMatch, baseServerName, server.name);
                        if (result) {
                            console.log(`✅ Found config in code block: ${result}`);
                            return result;
                        }
                    }
                }
            }
            
            // PRIORITY 3: Look for JSON configs anywhere in the page but filter out examples
            const allJsonMatches = html.match(/{\s*"mcpServers"[\s\S]*?}/g);
            if (allJsonMatches) {
                for (const jsonMatch of allJsonMatches) {
                    // Skip obvious examples/templates
                    if (jsonMatch.includes('@modelcontextprotocol/inspector') ||
                        jsonMatch.includes('"neon"') && !server.name.toLowerCase().includes('neon') ||
                        jsonMatch.includes('example') ||
                        jsonMatch.includes('template') ||
                        jsonMatch.includes('your-server') ||
                        jsonMatch.includes('<your-') ||
                        jsonMatch.includes('mode"') && !server.name.toLowerCase().includes('mode')) {
                        continue; // Skip example configs
                    }
                    
                    const result = parseJsonConfig(jsonMatch, baseServerName, server.name);
                    if (result) {
                        console.log(`✅ Found config in page content: ${result}`);
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
    
    // Helper function to parse JSON config with better validation
    function parseJsonConfig(jsonMatch, baseServerName, originalServerName) {
        try {
            const config = JSON.parse(jsonMatch);
            if (config.mcpServers) {
                const serverKey = Object.keys(config.mcpServers)[0];
                const serverConfig = config.mcpServers[serverKey];
                
                // Handle different config types
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
            // Invalid JSON, continue
        }
        return null;
    }
    
    // Helper function to find alternative install methods
    function findAlternativeInstallMethod(html, baseServerName, originalServerName) {
        console.log(`🔍 Looking for alternative install methods for ${originalServerName}`);
        
        // Look for Smithery install commands
        const smitheryMatch = html.match(/npx -y @smithery\/cli@latest install ([^\s]+)/);
        if (smitheryMatch) {
            const packageName = smitheryMatch[1];
            const uniqueName = generateUniqueName(baseServerName, packageName, null);
            return `npx:${uniqueName}:${packageName}`;
        }
        
        // Look for standalone NPX commands (exclude common examples)
        const npxMatches = html.matchAll(/npx\s+(?:-y\s+)?([A-Za-z0-9@/._-]+)/g);
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
        const uvxMatch = html.match(/uvx\s+([A-Za-z0-9_.-]+)/);
        if (uvxMatch?.[1] && uvxMatch[1] !== 'neon' && uvxMatch[1] !== 'mode') {
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
        
        console.warn(`❌ No valid package config found for: ${originalServerName}`);
        results.notFound++;
        return null;
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
    
    const batchSize = 3; // Reduced batch size for better logging
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
            }
        });
        
        // Progress update
        const processed = Math.min(i + batchSize, serverLinks.length);
        const progress = Math.round((processed / serverLinks.length) * 100);
        console.log(`   Progress: ${progress}% (${processed}/${serverLinks.length})`);
        
        // Rate limiting
        if (i + batchSize < serverLinks.length) {
            await new Promise(resolve => setTimeout(resolve, 1500));
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
    console.log('\n💡 To process more pages:');
    console.log('  1. Navigate to next page (e.g., ?page=2)');
    console.log('  2. Run this script again');
    console.log('  3. Repeat until you have all pages');
    
    return {
        page: currentPageNum,
        packages: allPackages,
        stats: results
    };
})();