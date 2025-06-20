/**
 * Browser Console Script to Scrape MCP.so Server Configurations
 * 
 * This script loads the merged server data and fetches the configuration
 * from each server's content tab to find actual installation commands
 */

// Configuration
const BATCH_SIZE = 50; // Process in batches
const DELAY_BETWEEN_REQUESTS = 500; // 0.5 seconds between requests
const SAVE_EVERY = 100; // Save progress every 100 servers

// Global state
let allServers = [];
let viableServers = [];
let processedCount = 0;
let currentBatch = 0;
let extractionPaused = false;

// Load the merged server data (you'll need to paste this)
let serverData = null; // Will be loaded from merged JSON

// Download data as file
function downloadData(data, filename) {
    try {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log(`📥 Downloaded: ${filename}`);
    } catch (e) {
        console.error('Download failed:', e);
    }
}

// Save progress to localStorage
function saveProgress() {
    try {
        const data = {
            viableServers: viableServers,
            processedCount: processedCount,
            currentBatch: currentBatch,
            savedAt: new Date().toISOString()
        };
        localStorage.setItem('mcpso_config_progress', JSON.stringify(data));
        console.log(`💾 Progress saved: ${processedCount} processed, ${viableServers.length} viable`);
    } catch (e) {
        console.error('Failed to save progress:', e);
    }
}

// Load progress from localStorage
function loadProgress() {
    try {
        const saved = localStorage.getItem('mcpso_config_progress');
        if (saved) {
            const data = JSON.parse(saved);
            viableServers = data.viableServers || [];
            processedCount = data.processedCount || 0;
            currentBatch = data.currentBatch || 0;
            console.log(`📂 Loaded progress: ${processedCount} processed, ${viableServers.length} viable`);
            return true;
        }
    } catch (e) {
        console.error('Failed to load progress:', e);
    }
    return false;
}

// Extract configuration from server content tab
async function fetchServerConfig(server) {
    try {
        const configUrl = `${server.url}?tab=content`;
        
        const response = await fetch(configUrl, {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'User-Agent': navigator.userAgent
            }
        });
        
        if (!response.ok) {
            return { server, error: `HTTP ${response.status}` };
        }
        
        const html = await response.text();
        
        // Parse the HTML to find configuration
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        // Look for configuration in various places
        const config = extractConfigFromHtml(doc);
        
        if (config) {
            return {
                server: {
                    ...server,
                    config: config,
                    configUrl: configUrl
                },
                viable: isConfigViable(config)
            };
        }
        
        return { server, error: 'No config found' };
        
    } catch (error) {
        return { server, error: error.message };
    }
}

// Extract configuration JSON from HTML
function extractConfigFromHtml(doc) {
    // Method 1: Look for JSON in code blocks
    const codeBlocks = doc.querySelectorAll('code, pre');
    for (const block of codeBlocks) {
        const text = block.textContent;
        if (text.includes('mcpServers') || text.includes('"command"')) {
            try {
                const config = JSON.parse(text);
                if (config.mcpServers) {
                    return config;
                }
            } catch (e) {
                // Try to extract just the mcpServers part
                const match = text.match(/\{[\s\S]*"mcpServers"[\s\S]*\}/);
                if (match) {
                    try {
                        return JSON.parse(match[0]);
                    } catch (e2) {
                        // Ignore
                    }
                }
            }
        }
    }
    
    // Method 2: Look for specific patterns
    const bodyText = doc.body.textContent;
    
    // Look for uvx commands
    const uvxMatch = bodyText.match(/uvx\s+([^\s]+)/);
    if (uvxMatch) {
        return {
            mcpServers: {
                server: {
                    command: 'uvx',
                    args: [uvxMatch[1]]
                }
            }
        };
    }
    
    // Look for npx commands
    const npxMatch = bodyText.match(/npx\s+([^\s]+)/);
    if (npxMatch) {
        return {
            mcpServers: {
                server: {
                    command: 'npx',
                    args: [npxMatch[1]]
                }
            }
        };
    }
    
    // Look for HTTP endpoints
    const httpMatch = bodyText.match(/https?:\/\/[^\s]+/);
    if (httpMatch && !httpMatch[0].includes('github.com') && !httpMatch[0].includes('mcp.so')) {
        return {
            mcpServers: {
                server: {
                    command: 'http',
                    url: httpMatch[0]
                }
            }
        };
    }
    
    return null;
}

// Check if configuration is viable (installable)
function isConfigViable(config) {
    if (!config || !config.mcpServers) return false;
    
    for (const serverConfig of Object.values(config.mcpServers)) {
        const command = serverConfig.command?.toLowerCase();
        
        // Check for viable commands
        if (command === 'npx' || command === 'uvx' || command === 'http' || serverConfig.url) {
            return true;
        }
    }
    
    return false;
}

// Process servers in batches
async function processServerBatch(servers, startIndex = 0) {
    const endIndex = Math.min(startIndex + BATCH_SIZE, servers.length);
    
    console.log(`🔄 Processing servers ${startIndex + 1}-${endIndex} of ${servers.length}...`);
    
    for (let i = startIndex; i < endIndex && !extractionPaused; i++) {
        const server = servers[i];
        
        try {
            const result = await fetchServerConfig(server);
            
            if (result.viable) {
                viableServers.push(result.server);
                console.log(`✅ [${i + 1}] VIABLE: ${server.name} - ${result.server.config.mcpServers ? Object.values(result.server.config.mcpServers)[0].command : 'unknown'}`);
            } else if (result.error) {
                console.log(`❌ [${i + 1}] ERROR: ${server.name} - ${result.error}`);
            } else {
                console.log(`⚪ [${i + 1}] NOT VIABLE: ${server.name}`);
            }
            
            processedCount++;
            
            // Save progress periodically
            if (processedCount % SAVE_EVERY === 0) {
                saveProgress();
                downloadData(viableServers, `mcp-so-configs-viable-${processedCount}.json`);
            }
            
            // Delay between requests
            if (i < endIndex - 1) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_REQUESTS));
            }
            
        } catch (error) {
            console.error(`❌ [${i + 1}] Exception: ${server.name} - ${error.message}`);
            processedCount++;
        }
    }
    
    return endIndex;
}

// Main extraction function
async function extractServerConfigs(startFromIndex = 0) {
    if (!serverData || !Array.isArray(serverData)) {
        console.error('❌ No server data loaded! Please run loadServerData() first.');
        return;
    }
    
    console.log('🚀 Starting MCP.so server configuration extraction...');
    console.log(`📊 Total servers to process: ${serverData.length}`);
    
    if (startFromIndex === 0) {
        loadProgress();
    }
    
    let currentIndex = startFromIndex || processedCount;
    extractionPaused = false;
    
    while (currentIndex < serverData.length && !extractionPaused) {
        const nextIndex = await processServerBatch(serverData, currentIndex);
        currentIndex = nextIndex;
        
        // Check if we should pause
        if (currentIndex < serverData.length && !extractionPaused) {
            console.log(`⏸️  Batch complete. Continue with extractServerConfigs(${currentIndex})`);
            break; // Let user manually continue
        }
    }
    
    if (currentIndex >= serverData.length) {
        finishExtraction();
    }
}

// Finish extraction
function finishExtraction() {
    saveProgress();
    downloadData(viableServers, 'mcp-so-configs-final.json');
    
    console.log('\n🎉 Configuration extraction complete!');
    console.log(`📊 Results:`);
    console.log(`   Total processed: ${processedCount}`);
    console.log(`   Viable servers found: ${viableServers.length}`);
    console.log(`   Viability rate: ${(viableServers.length/processedCount*100).toFixed(2)}%`);
    
    // Show breakdown by command type
    const commands = {};
    viableServers.forEach(server => {
        if (server.config && server.config.mcpServers) {
            Object.values(server.config.mcpServers).forEach(config => {
                const cmd = config.command || 'unknown';
                commands[cmd] = (commands[cmd] || 0) + 1;
            });
        }
    });
    
    console.log(`\n📋 Command breakdown:`);
    Object.entries(commands).forEach(([cmd, count]) => {
        console.log(`   ${cmd}: ${count}`);
    });
}

// Utility functions
function pauseExtraction() {
    extractionPaused = true;
    console.log('⏸️  Extraction paused. Run resumeExtraction() to continue.');
}

function resumeExtraction() {
    extractionPaused = false;
    extractServerConfigs(processedCount);
}

function getStatus() {
    console.log(`📊 Status: ${processedCount} processed, ${viableServers.length} viable`);
    return { processedCount, viableCount: viableServers.length };
}

function clearProgress() {
    localStorage.removeItem('mcpso_config_progress');
    viableServers = [];
    processedCount = 0;
    currentBatch = 0;
    console.log('🧹 Progress cleared.');
}

// Load server data (you need to paste the JSON data)
async function loadServerData(url) {
    if (url) {
        console.log(`📁 Loading server data from: ${url}`);
        try {
            const response = await fetch(url);
            serverData = await response.json();
            console.log(`✅ Loaded ${serverData.length} servers`);
            return serverData.length;
        } catch (error) {
            console.error('❌ Failed to load data:', error);
            return null;
        }
    } else {
        console.log('📁 Please paste the server data from mcp-so-servers-merged.json into the serverData variable');
        console.log('Example: serverData = [paste JSON array here]');
        console.log('\nOr load from URL:');
        console.log('loadServerData("https://example.com/mcp-so-servers-merged.json")');
    }
}

// Initialize
console.log('==============================================');
console.log('🔧 MCP.so Server Configuration Scraper');
console.log('==============================================');
console.log('Commands:');
console.log('- loadServerData()           : Instructions to load data');
console.log('- extractServerConfigs()     : Start extraction');
console.log('- extractServerConfigs(N)    : Resume from index N');
console.log('- pauseExtraction()          : Pause the extraction');
console.log('- resumeExtraction()         : Resume extraction');
console.log('- getStatus()                : Check current progress');
console.log('- clearProgress()            : Clear saved progress');
console.log('==============================================');
console.log('\n1. First run: loadServerData()');
console.log('2. Then run: extractServerConfigs()');