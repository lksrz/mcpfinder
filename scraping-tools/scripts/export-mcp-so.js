#!/usr/bin/env node

/**
 * Browser Console Script to Export mcp.so Data
 * 
 * Instructions:
 * 1. Open https://mcp.so/servers?tag=latest in your browser
 * 2. Open Developer Console (F12)
 * 3. Copy and paste this entire script into the console
 * 4. Wait for it to complete (it will auto-scroll through pages)
 * 5. Save the output JSON file
 */

// Configuration
const DELAY_BETWEEN_PAGES = 2000; // 2 seconds
const MAX_PAGES = 510; // Adjust based on actual page count

// Data storage
const allServers = [];

// Extract servers from current page
function extractServersFromPage() {
    const servers = [];
    
    // Method 1: Extract from server links
    document.querySelectorAll('a[href*="/server/"]').forEach(link => {
        const href = link.getAttribute('href');
        if (!href || href === '/servers') return;
        
        // Get parent container
        const container = link.closest('div[class*="card"], article, .server-item, [class*="grid"] > div');
        
        // Extract server info
        const server = {
            name: link.textContent.trim(),
            url: href.startsWith('http') ? href : `https://mcp.so${href}`,
            extractedAt: new Date().toISOString()
        };
        
        // Try to get description
        if (container) {
            const descriptions = container.querySelectorAll('p, div[class*="description"], div[class*="text-muted"]');
            if (descriptions.length > 0) {
                server.description = descriptions[0].textContent.trim();
            }
            
            // Try to get author
            const authorElements = container.querySelectorAll('span[class*="author"], div[class*="author"], a[href*="/user/"]');
            if (authorElements.length > 0) {
                server.author = authorElements[0].textContent.trim();
            }
            
            // Try to get tags
            const tagElements = container.querySelectorAll('span[class*="tag"], span[class*="badge"], div[class*="tag"]');
            if (tagElements.length > 0) {
                server.tags = Array.from(tagElements).map(el => el.textContent.trim());
            }
            
            // Look for install commands in the container
            const codeBlocks = container.querySelectorAll('code, pre');
            codeBlocks.forEach(code => {
                const text = code.textContent;
                if (text.includes('npx') || text.includes('npm install') || text.includes('uvx')) {
                    server.installCommand = text.trim();
                }
            });
        }
        
        // Parse URL to get slug and author
        const urlParts = href.split('/');
        if (urlParts.length >= 2) {
            server.slug = urlParts[urlParts.length - 2];
            server.authorFromUrl = urlParts[urlParts.length - 1];
        }
        
        servers.push(server);
    });
    
    // Method 2: Try to extract from React/Next.js data
    try {
        // Look for __NEXT_DATA__ script tag
        const scripts = document.querySelectorAll('script#__NEXT_DATA__');
        scripts.forEach(script => {
            try {
                const data = JSON.parse(script.textContent);
                if (data.props?.pageProps?.servers) {
                    console.log('Found servers in __NEXT_DATA__');
                    servers.push(...data.props.pageProps.servers);
                }
            } catch (e) {
                // Ignore parse errors
            }
        });
    } catch (e) {
        console.log('Could not extract from __NEXT_DATA__');
    }
    
    // Deduplicate
    const uniqueServers = [];
    const seen = new Set();
    
    servers.forEach(server => {
        const key = server.url || server.name;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueServers.push(server);
        }
    });
    
    return uniqueServers;
}

// Navigate to next page
async function goToNextPage(currentPage) {
    const nextPage = currentPage + 1;
    const nextUrl = `https://mcp.so/servers?tag=latest&page=${nextPage}`;
    
    // Try clicking next button first
    const nextButtons = document.querySelectorAll('a[href*="page=' + nextPage + '"], button:contains("Next"), a:contains("Next")');
    if (nextButtons.length > 0) {
        nextButtons[0].click();
    } else {
        // Fallback to direct navigation
        window.location.href = nextUrl;
    }
    
    // Wait for page to load
    return new Promise(resolve => {
        setTimeout(resolve, DELAY_BETWEEN_PAGES);
    });
}

// Main extraction function
async function extractAllServers() {
    console.log('Starting mcp.so data extraction...');
    console.log('This will take several minutes. Please keep this tab active.');
    
    let currentPage = 1;
    let foundServers = true;
    
    while (foundServers && currentPage <= MAX_PAGES) {
        console.log(`Extracting page ${currentPage}...`);
        
        // Extract from current page
        const pageServers = extractServersFromPage();
        console.log(`Found ${pageServers.length} servers on page ${currentPage}`);
        
        if (pageServers.length === 0) {
            // Try one more time after a delay
            await new Promise(resolve => setTimeout(resolve, 1000));
            const retryServers = extractServersFromPage();
            if (retryServers.length === 0) {
                console.log('No more servers found. Extraction complete.');
                foundServers = false;
                break;
            } else {
                allServers.push(...retryServers);
            }
        } else {
            allServers.push(...pageServers);
        }
        
        // Go to next page
        if (foundServers && currentPage < MAX_PAGES) {
            await goToNextPage(currentPage);
            currentPage++;
        } else {
            break;
        }
    }
    
    // Final deduplication
    const finalServers = [];
    const seen = new Set();
    
    allServers.forEach(server => {
        const key = server.url || server.name;
        if (!seen.has(key)) {
            seen.add(key);
            finalServers.push(server);
        }
    });
    
    console.log(`\nExtraction complete!`);
    console.log(`Total servers found: ${finalServers.length}`);
    console.log(`\nTo save the data:`);
    console.log(`1. Copy the JSON output below`);
    console.log(`2. Save it as 'mcp-so-servers.json'`);
    console.log(`3. Run: node src/scrapers/mcp-so-bulk-analyzer.js analyze mcp-so-servers.json`);
    
    // Output the data
    console.log('\n=== JSON DATA START ===');
    console.log(JSON.stringify(finalServers, null, 2));
    console.log('=== JSON DATA END ===');
    
    // Also try to trigger download
    try {
        const blob = new Blob([JSON.stringify(finalServers, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'mcp-so-servers.json';
        a.click();
        console.log('\nFile download triggered!');
    } catch (e) {
        console.log('\nCould not trigger automatic download. Please copy the JSON manually.');
    }
    
    return finalServers;
}

// Manual single-page extraction (if auto-navigation doesn't work)
function extractCurrentPageOnly() {
    const servers = extractServersFromPage();
    console.log(`Found ${servers.length} servers on current page`);
    console.log(JSON.stringify(servers, null, 2));
    return servers;
}

// Start extraction
console.log('==============================================');
console.log('mcp.so Data Extractor');
console.log('==============================================');
console.log('Commands:');
console.log('- extractAllServers()   : Extract from all pages (auto-navigate)');
console.log('- extractCurrentPageOnly() : Extract from current page only');
console.log('==============================================');
console.log('\nTo start full extraction, run: extractAllServers()');