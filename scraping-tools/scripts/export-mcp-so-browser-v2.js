/**
 * Browser Console Script to Export mcp.so Data - Version 2
 * 
 * Features:
 * - Saves progress every 100 servers
 * - Resume from specific batch
 * - Better error handling
 * - Manual navigation support
 */

// Configuration
const DELAY_BETWEEN_PAGES = 3000; // 3 seconds (increased for stability)
const SAVE_EVERY = 100; // Save every 100 servers
const MAX_PAGES = 510;

// Global state
let allServers = [];
let currentBatch = 0;
let extractionPaused = false;

// Load saved progress from localStorage
function loadProgress() {
    try {
        const saved = localStorage.getItem('mcpso_extraction_progress');
        if (saved) {
            const data = JSON.parse(saved);
            allServers = data.servers || [];
            currentBatch = data.batch || 0;
            console.log(`Loaded ${allServers.length} servers from batch ${currentBatch}`);
            return true;
        }
    } catch (e) {
        console.error('Failed to load progress:', e);
    }
    return false;
}

// Save progress to localStorage (with quota handling)
function saveProgress() {
    try {
        // Only save essential progress info, not all servers
        const data = {
            totalServers: allServers.length,
            batch: currentBatch,
            savedAt: new Date().toISOString(),
            lastPage: Math.floor(allServers.length / 30)
        };
        localStorage.setItem('mcpso_extraction_progress', JSON.stringify(data));
        console.log(`Progress saved: ${allServers.length} servers, batch ${currentBatch}`);
    } catch (e) {
        console.error('Failed to save progress:', e);
        // Continue without localStorage - rely on downloads
        console.log('📥 Continuing without localStorage - relying on downloaded files');
    }
}

// Download data as file
function downloadData(servers, filename) {
    try {
        const blob = new Blob([JSON.stringify(servers, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log(`File downloaded: ${filename}`);
    } catch (e) {
        console.error('Download failed:', e);
    }
}

// Extract servers from current page
function extractServersFromPage() {
    return extractServersFromDocument(document);
}

// Extract servers from a document (current page or parsed HTML)
function extractServersFromDocument(doc) {
    const servers = [];
    
    // Extract from server links
    doc.querySelectorAll('a[href*="/server/"]').forEach(link => {
        const href = link.getAttribute('href');
        if (!href || href === '/servers') return;
        
        const container = link.closest('div[class*="card"], article, .server-item, [class*="grid"] > div');
        
        const server = {
            name: link.textContent?.trim() || '',
            url: href.startsWith('http') ? href : `https://mcp.so${href}`,
            extractedAt: new Date().toISOString()
        };
        
        if (container) {
            // Extract description
            const descriptions = container.querySelectorAll('p, div[class*="description"], div[class*="text-muted"]');
            if (descriptions.length > 0) {
                server.description = descriptions[0].textContent?.trim() || '';
            }
            
            // Extract author
            const authorElements = container.querySelectorAll('span[class*="author"], div[class*="author"], a[href*="/user/"]');
            if (authorElements.length > 0) {
                server.author = authorElements[0].textContent?.trim() || '';
            }
            
            // Extract tags
            const tagElements = container.querySelectorAll('span[class*="tag"], span[class*="badge"], div[class*="tag"]');
            if (tagElements.length > 0) {
                server.tags = Array.from(tagElements).map(el => el.textContent?.trim()).filter(Boolean);
            }
            
            // Look for install commands
            const codeBlocks = container.querySelectorAll('code, pre');
            codeBlocks.forEach(code => {
                const text = code.textContent || '';
                if (text.includes('npx') || text.includes('npm install') || text.includes('uvx')) {
                    server.installCommand = text.trim();
                }
            });
        }
        
        // Parse URL
        const urlParts = href.split('/').filter(p => p);
        if (urlParts.length >= 2) {
            server.slug = urlParts[urlParts.length - 2];
            server.authorFromUrl = urlParts[urlParts.length - 1];
        }
        
        servers.push(server);
    });
    
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

// Get current page number from URL
function getCurrentPageNumber() {
    const urlParams = new URLSearchParams(window.location.search);
    const page = urlParams.get('page');
    return page ? parseInt(page) : 1;
}

// Navigate to specific page
async function navigateToPage(pageNum) {
    const url = pageNum === 1 
        ? 'https://mcp.so/servers?tag=latest' 
        : `https://mcp.so/servers?tag=latest&page=${pageNum}`;
    
    if (window.location.href !== url) {
        window.location.href = url;
        // Wait for navigation
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_PAGES));
    }
}

// Main extraction function with resume capability
async function extractAllServers(startFromBatch = 0, maxPages = 100) {
    console.log(`Starting mcp.so data extraction for ${maxPages} pages...`);
    
    let startPage;
    
    // Load previous progress if starting from batch 0
    if (startFromBatch === 0) {
        loadProgress();
        startPage = Math.max(1, Math.floor(allServers.length / 30) + 1);
    } else {
        // Clear and start from specific batch
        allServers = [];
        currentBatch = startFromBatch;
        // Calculate starting page from batch number (batch 112 = ~11,200 servers = page 374)
        startPage = Math.max(1, Math.floor(startFromBatch * 100 / 30) + 1);
        console.log(`Starting from batch ${startFromBatch} at page ${startPage}`);
    }
    
    const endPage = Math.min(startPage + maxPages - 1, MAX_PAGES);
    
    console.log(`Will extract pages ${startPage} to ${endPage}`);
    
    extractionPaused = false;
    
    for (let currentPage = startPage; currentPage <= endPage && !extractionPaused; currentPage++) {
        console.log(`\n📄 Extracting page ${currentPage}/${endPage}...`);
        
        try {
            // Navigate to page using fetch instead of page reload
            const url = currentPage === 1 
                ? 'https://mcp.so/servers?tag=latest' 
                : `https://mcp.so/servers?tag=latest&page=${currentPage}`;
            
            // Skip history API - causes security errors
            
            // Fetch page content using fetch API
            const response = await fetch(url, {
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'User-Agent': navigator.userAgent
                }
            });
            
            if (!response.ok) {
                console.log(`⚠️  Failed to fetch page ${currentPage}: ${response.status}`);
                continue;
            }
            
            const html = await response.text();
            
            // Parse HTML and extract servers
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            
            // Extract servers from parsed document
            const pageServers = extractServersFromDocument(doc);
            console.log(`   Found ${pageServers.length} servers on page ${currentPage}`);
            
            if (pageServers.length === 0) {
                console.log(`⚠️  No servers found on page ${currentPage}`);
                continue;
            }
            
            allServers.push(...pageServers);
            
            // Save progress every SAVE_EVERY servers OR every 10 pages
            const newBatch = Math.floor(allServers.length / SAVE_EVERY);
            const shouldDownload = newBatch > currentBatch || 
                                 (currentPage - startPage + 1) % 10 === 0 || 
                                 currentPage === endPage;
            
            if (newBatch > currentBatch) {
                currentBatch = newBatch;
                console.log(`🎯 Batch ${currentBatch} completed (${allServers.length} total servers)`);
            }
            
            if (shouldDownload) {
                saveProgress();
                
                // Download a backup file  
                const pageRange = `p${startPage}-${currentPage}`;
                const filename = `mcp-so-servers-${pageRange}-${allServers.length}.json`;
                downloadData(allServers, filename);
                console.log(`📥 Downloaded: ${filename}`);
            }
            
            // Short delay between requests
            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (error) {
            console.error(`❌ Error processing page ${currentPage}:`, error);
            continue;
        }
    }
    
    // Final save
    saveProgress();
    
    console.log(`\n✅ Extraction batch complete!`);
    console.log(`📊 Total servers collected: ${allServers.length}`);
    console.log(`📄 Processed pages ${startPage}-${Math.min(startPage + maxPages - 1, endPage)}`);
    
    if (endPage < MAX_PAGES) {
        console.log(`\n🔄 To continue extraction, run:`);
        console.log(`extractAllServers(${currentBatch}, ${maxPages})`);
    } else {
        finishExtraction();
    }
    
    return allServers.length;
}

// Manual extraction mode
async function extractBatch(numPages = 10) {
    console.log(`Extracting ${numPages} pages manually...`);
    console.log('Navigate to each page and run this function again.');
    
    loadProgress();
    
    const currentPage = getCurrentPageNumber();
    const pageServers = extractServersFromPage();
    
    console.log(`Page ${currentPage}: Found ${pageServers.length} servers`);
    allServers.push(...pageServers);
    
    // Save progress
    if (allServers.length >= (currentBatch + 1) * SAVE_EVERY) {
        currentBatch = Math.floor(allServers.length / SAVE_EVERY);
        saveProgress();
        downloadData(allServers, `mcp-so-servers-batch${currentBatch}.json`);
    }
    
    console.log(`Total servers collected: ${allServers.length}`);
    console.log(`Current batch: ${currentBatch}`);
    
    return allServers.length;
}

// Finish extraction and download final data
function finishExtraction() {
    // Deduplicate final list
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
    console.log(`Total unique servers: ${finalServers.length}`);
    
    // Download final file
    downloadData(finalServers, 'mcp-so-servers-final.json');
    
    // Clear localStorage
    localStorage.removeItem('mcpso_extraction_progress');
    
    console.log('\nNext steps:');
    console.log('1. Check your downloads folder for the JSON files');
    console.log('2. Run: node src/scrapers/mcp-so-bulk-analyzer.js analyze mcp-so-servers-final.json');
    
    return finalServers;
}

// Utility functions
function pauseExtraction() {
    extractionPaused = true;
    console.log('Extraction paused. Run resumeExtraction() to continue.');
}

function resumeExtraction() {
    loadProgress();
    console.log(`Resuming from ${allServers.length} servers...`);
    extractAllServers();
}

function clearProgress() {
    localStorage.removeItem('mcpso_extraction_progress');
    allServers = [];
    currentBatch = 0;
    console.log('Progress cleared.');
}

function getStatus() {
    loadProgress();
    console.log(`Status: ${allServers.length} servers collected`);
    console.log(`Current batch: ${currentBatch}`);
    console.log(`Estimated page: ${Math.floor(allServers.length / 30) + 1}`);
    return {
        totalServers: allServers.length,
        currentBatch: currentBatch,
        estimatedPage: Math.floor(allServers.length / 30) + 1
    };
}

// Initialize
console.log('==============================================');
console.log('mcp.so Data Extractor v2');
console.log('==============================================');
console.log('Commands:');
console.log('- extractAllServers()           : Extract 100 pages automatically');
console.log('- extractAllServers(0, 50)      : Extract 50 pages from start');
console.log('- extractAllServers(5, 100)     : Extract 100 pages from batch 5');
console.log('- extractBatch()                : Extract current page only (manual mode)');
console.log('- pauseExtraction()             : Pause the extraction');
console.log('- resumeExtraction()            : Resume from saved progress');
console.log('- getStatus()                   : Check current progress');
console.log('- finishExtraction()            : Deduplicate and download final data');
console.log('- clearProgress()               : Clear saved progress');
console.log('==============================================');

// Check for saved progress
if (loadProgress()) {
    console.log(`\nFound saved progress: ${allServers.length} servers`);
    console.log('Run extractAllServers() to continue or clearProgress() to start fresh');
}