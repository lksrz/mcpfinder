#!/usr/bin/env node

/**
 * Fully Automated mcp.so Data Extractor
 * 
 * This script automatically processes all 500+ pages from mcp.so
 * - Saves progress every 100 servers (3-4 pages)
 * - Downloads backup files automatically
 * - Resume from any batch
 * - No manual intervention required
 * 
 * Usage:
 * node scripts/export-mcp-so-automated.js
 * node scripts/export-mcp-so-automated.js --start-batch 5
 * node scripts/export-mcp-so-automated.js --max-pages 100
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;
const path = require('path');

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

class McpSoAutomatedExtractor {
    constructor(options = {}) {
        this.baseUrl = 'https://mcp.so/servers';
        this.servers = [];
        this.currentBatch = options.startBatch || 0;
        this.maxPages = options.maxPages || 510;
        this.saveEvery = 100; // Save every 100 servers
        this.pageDelay = 2000; // 2 seconds between pages
        this.progressFile = 'mcp-so-extraction-progress.json';
        this.browser = null;
        this.page = null;
    }

    async setup() {
        console.log('🚀 Setting up automated browser...');
        
        this.browser = await puppeteer.launch({
            headless: true, // Set to false for debugging
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
            ]
        });

        this.page = await this.browser.newPage();
        
        await this.page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await this.page.setViewport({ width: 1920, height: 1080 });
    }

    async loadProgress() {
        try {
            const data = await fs.readFile(this.progressFile, 'utf-8');
            const progress = JSON.parse(data);
            this.servers = progress.servers || [];
            this.currentBatch = progress.batch || 0;
            console.log(`📂 Loaded progress: ${this.servers.length} servers, batch ${this.currentBatch}`);
            return true;
        } catch (e) {
            console.log('📂 No previous progress found, starting fresh');
            return false;
        }
    }

    async saveProgress() {
        const progress = {
            servers: this.servers,
            batch: this.currentBatch,
            savedAt: new Date().toISOString(),
            totalPages: this.maxPages
        };
        
        await fs.writeFile(this.progressFile, JSON.stringify(progress, null, 2));
        console.log(`💾 Progress saved: ${this.servers.length} servers, batch ${this.currentBatch}`);
    }

    async downloadBackup(filename) {
        const filepath = path.join(process.cwd(), 'data', filename);
        
        // Ensure data directory exists
        await fs.mkdir(path.dirname(filepath), { recursive: true });
        
        // Deduplicate before saving
        const seen = new Set();
        const uniqueServers = this.servers.filter(server => {
            const key = server.url || server.name;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        
        await fs.writeFile(filepath, JSON.stringify(uniqueServers, null, 2));
        console.log(`📥 Downloaded backup: ${filename} (${uniqueServers.length} servers)`);
        return uniqueServers.length;
    }

    async extractServersFromPage() {
        return await this.page.evaluate(() => {
            const servers = [];
            
            // Extract from server links
            document.querySelectorAll('a[href*="/server/"]').forEach(link => {
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
                    const descElements = container.querySelectorAll('p, div[class*="description"], div[class*="text-muted"]');
                    if (descElements.length > 0) {
                        server.description = descElements[0].textContent?.trim() || '';
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
                    for (const code of codeBlocks) {
                        const text = code.textContent || '';
                        if (text.includes('npx') || text.includes('npm install') || text.includes('uvx')) {
                            server.installCommand = text.trim();
                            break;
                        }
                    }
                }
                
                // Parse URL for additional info
                const urlParts = href.split('/').filter(p => p);
                if (urlParts.length >= 2) {
                    server.slug = urlParts[urlParts.length - 2];
                    server.authorFromUrl = urlParts[urlParts.length - 1];
                }
                
                servers.push(server);
            });
            
            return servers;
        });
    }

    async navigateToPage(pageNum) {
        const url = pageNum === 1 
            ? `${this.baseUrl}?tag=latest`
            : `${this.baseUrl}?tag=latest&page=${pageNum}`;
        
        try {
            await this.page.goto(url, { 
                waitUntil: 'networkidle2',
                timeout: 30000 
            });
            
            // Wait a bit for dynamic content
            await this.page.waitForTimeout(this.pageDelay);
            
            // Check if we hit Cloudflare
            const content = await this.page.content();
            if (content.toLowerCase().includes('just a moment') || content.toLowerCase().includes('checking your browser')) {
                console.log('⏳ Cloudflare challenge detected, waiting...');
                await this.page.waitForTimeout(10000);
            }
            
            return true;
        } catch (error) {
            console.error(`❌ Failed to navigate to page ${pageNum}:`, error.message);
            return false;
        }
    }

    async extractAllPages() {
        console.log(`🔄 Starting extraction from batch ${this.currentBatch}...`);
        
        // Load previous progress if starting from batch 0
        if (this.currentBatch === 0) {
            await this.loadProgress();
        }
        
        // Calculate starting page based on current progress
        const startPage = Math.max(1, Math.floor(this.servers.length / 30) + 1);
        console.log(`📄 Starting from page ${startPage} (${this.servers.length} servers already collected)`);
        
        for (let currentPage = startPage; currentPage <= this.maxPages; currentPage++) {
            console.log(`\n📄 Processing page ${currentPage}/${this.maxPages}...`);
            
            // Navigate to page
            const navigated = await this.navigateToPage(currentPage);
            if (!navigated) {
                console.log(`⚠️  Skipping page ${currentPage} due to navigation error`);
                continue;
            }
            
            // Extract servers from current page
            const pageServers = await this.extractServersFromPage();
            console.log(`   Found ${pageServers.length} servers on page ${currentPage}`);
            
            if (pageServers.length === 0) {
                console.log('⚠️  No servers found, checking if we reached the end...');
                await this.page.waitForTimeout(3000);
                const retryServers = await this.extractServersFromPage();
                
                if (retryServers.length === 0) {
                    console.log('🏁 No more servers found, extraction complete!');
                    break;
                }
                this.servers.push(...retryServers);
            } else {
                this.servers.push(...pageServers);
            }
            
            // Check if we need to save progress and download backup
            const newBatch = Math.floor(this.servers.length / this.saveEvery);
            if (newBatch > this.currentBatch) {
                this.currentBatch = newBatch;
                await this.saveProgress();
                
                const filename = `mcp-so-servers-batch${this.currentBatch}-${this.servers.length}.json`;
                await this.downloadBackup(filename);
                
                console.log(`🎯 Batch ${this.currentBatch} completed (${this.servers.length} total servers)`);
            }
            
            // Small delay between pages
            if (currentPage < this.maxPages) {
                await this.page.waitForTimeout(1000);
            }
        }
        
        // Final save and download
        await this.saveProgress();
        const finalCount = await this.downloadBackup('mcp-so-servers-final.json');
        
        console.log(`\n🎉 Extraction complete!`);
        console.log(`📊 Total unique servers: ${finalCount}`);
        console.log(`📁 Files saved in ./data/ directory`);
        console.log(`\n📋 Next steps:`);
        console.log(`   1. Analyze data: node src/scrapers/mcp-so-bulk-analyzer.js analyze data/mcp-so-servers-final.json`);
        console.log(`   2. Register viable servers: node src/scrapers/mcp-so-bulk-analyzer.js register data/mcp-so-viable-servers.json`);
        
        return finalCount;
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
        }
        
        // Clean up progress file
        try {
            await fs.unlink(this.progressFile);
            console.log('🧹 Cleaned up progress file');
        } catch (e) {
            // Ignore cleanup errors
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    const options = {};
    
    // Parse command line arguments
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--start-batch' && args[i + 1]) {
            options.startBatch = parseInt(args[i + 1]);
            i++;
        } else if (args[i] === '--max-pages' && args[i + 1]) {
            options.maxPages = parseInt(args[i + 1]);
            i++;
        }
    }
    
    console.log('==============================================');
    console.log('🤖 MCP.so Automated Data Extractor');
    console.log('==============================================');
    if (options.startBatch) console.log(`🎯 Starting from batch: ${options.startBatch}`);
    if (options.maxPages) console.log(`📄 Max pages: ${options.maxPages}`);
    console.log('==============================================\n');
    
    const extractor = new McpSoAutomatedExtractor(options);
    
    try {
        await extractor.setup();
        const totalServers = await extractor.extractAllPages();
        
        console.log(`\n✅ Successfully extracted ${totalServers} servers!`);
        
    } catch (error) {
        console.error('\n❌ Extraction failed:', error);
        process.exit(1);
    } finally {
        await extractor.close();
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n⏹️  Extraction interrupted by user');
    process.exit(0);
});

// Run if called directly
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { McpSoAutomatedExtractor };