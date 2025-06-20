#!/usr/bin/env node

/**
 * Export mcp.so data using Playwright with stealth mode
 * 
 * First install dependencies:
 * npm install playwright playwright-extra playwright-extra-plugin-stealth
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;
const path = require('path');

// Use stealth plugin
chromium.use(StealthPlugin());

class McpSoExporter {
    constructor() {
        this.baseUrl = 'https://mcp.so/servers';
        this.servers = [];
        this.browser = null;
        this.page = null;
    }

    async setup() {
        console.log('Setting up browser...');
        this.browser = await chromium.launch({
            headless: false, // Set to true for headless mode
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        const context = await this.browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 },
            locale: 'en-US',
        });

        this.page = await context.newPage();

        // Additional evasion techniques
        await this.page.evaluateOnNewDocument(() => {
            // Override the navigator.webdriver property
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined
            });

            // Override navigator.plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5]
            });

            // Override navigator.languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en']
            });
        });
    }

    async waitForCloudflare() {
        console.log('Checking for Cloudflare challenge...');
        await this.page.waitForTimeout(5000);

        // Check if we're on a challenge page
        const content = await this.page.content();
        if (content.toLowerCase().includes('just a moment')) {
            console.log('Cloudflare challenge detected, waiting...');
            await this.page.waitForTimeout(10000);
        }
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
                    name: link.textContent.trim(),
                    url: href.startsWith('http') ? href : `https://mcp.so${href}`,
                    extractedAt: new Date().toISOString()
                };

                if (container) {
                    // Extract description
                    const descElements = container.querySelectorAll('p, div[class*="description"], div[class*="text-muted"]');
                    if (descElements.length > 0) {
                        server.description = descElements[0].textContent.trim();
                    }

                    // Extract author
                    const authorElements = container.querySelectorAll('span[class*="author"], div[class*="author"], a[href*="/user/"]');
                    if (authorElements.length > 0) {
                        server.author = authorElements[0].textContent.trim();
                    }

                    // Extract install commands
                    const codeBlocks = container.querySelectorAll('code, pre');
                    codeBlocks.forEach(code => {
                        const text = code.textContent;
                        if (text.includes('npx') || text.includes('npm install') || text.includes('uvx')) {
                            server.installCommand = text.trim();
                        }
                    });
                }

                // Parse URL
                const urlParts = href.split('/');
                if (urlParts.length >= 2) {
                    server.slug = urlParts[urlParts.length - 2];
                    server.authorFromUrl = urlParts[urlParts.length - 1];
                }

                servers.push(server);
            });

            // Try to extract from __NEXT_DATA__
            try {
                const scripts = document.querySelectorAll('script#__NEXT_DATA__');
                scripts.forEach(script => {
                    try {
                        const data = JSON.parse(script.textContent);
                        if (data.props?.pageProps?.servers) {
                            servers.push(...data.props.pageProps.servers);
                        }
                    } catch (e) {}
                });
            } catch (e) {}

            return servers;
        });
    }

    async navigateAllPages(maxPages = 510) {
        let currentPage = 1;

        // Go to first page
        const url = `${this.baseUrl}?tag=latest`;
        console.log(`Loading ${url}`);
        await this.page.goto(url, { waitUntil: 'networkidle' });
        await this.waitForCloudflare();

        while (currentPage <= maxPages) {
            console.log(`\nProcessing page ${currentPage}...`);

            // Wait for content
            try {
                await this.page.waitForSelector('a[href*="/server/"]', { timeout: 10000 });
            } catch (e) {
                console.log('Timeout waiting for servers to load');
            }

            // Extract servers
            const pageServers = await this.extractServersFromPage();
            console.log(`Found ${pageServers.length} servers on page ${currentPage}`);

            if (pageServers.length === 0) {
                console.log('No servers found, checking if we\'ve reached the end...');
                await this.page.waitForTimeout(2000);
                const retryServers = await this.extractServersFromPage();
                if (retryServers.length === 0) {
                    console.log('No more servers, stopping.');
                    break;
                }
                this.servers.push(...retryServers);
            } else {
                this.servers.push(...pageServers);
            }

            // Go to next page
            currentPage++;
            const nextUrl = `${this.baseUrl}?tag=latest&page=${currentPage}`;

            try {
                // Try clicking next button
                await this.page.click(`a[href*="page=${currentPage}"]`);
                await this.page.waitForTimeout(2000);
            } catch (e) {
                // Direct navigation
                await this.page.goto(nextUrl, { waitUntil: 'networkidle' });
                await this.page.waitForTimeout(2000);
            }
        }

        console.log(`\nExtraction complete. Total servers: ${this.servers.length}`);
    }

    async saveData(filename = 'mcp-so-servers.json') {
        // Deduplicate
        const seen = new Set();
        const uniqueServers = [];

        this.servers.forEach(server => {
            const key = server.url || server.name;
            if (key && !seen.has(key)) {
                seen.add(key);
                uniqueServers.push(server);
            }
        });

        await fs.writeFile(filename, JSON.stringify(uniqueServers, null, 2));
        console.log(`\nSaved ${uniqueServers.length} unique servers to ${filename}`);
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    const mode = args[0] || 'all';
    const maxPages = parseInt(args[1]) || 510;
    const outputFile = args[2] || 'mcp-so-servers.json';

    console.log('==============================================');
    console.log('mcp.so Data Exporter (Playwright)');
    console.log('==============================================');
    console.log(`Mode: ${mode}`);
    console.log(`Max pages: ${maxPages}`);
    console.log(`Output: ${outputFile}`);
    console.log('==============================================\n');

    const exporter = new McpSoExporter();

    try {
        await exporter.setup();

        if (mode === 'all') {
            await exporter.navigateAllPages(maxPages);
            await exporter.saveData(outputFile);
        } else if (mode === 'single') {
            const servers = await exporter.extractServersFromPage();
            console.log(JSON.stringify(servers, null, 2));
        }

        console.log('\nNext steps:');
        console.log(`1. Check the exported file: ${outputFile}`);
        console.log(`2. Analyze the data: node src/scrapers/mcp-so-bulk-analyzer.js analyze ${outputFile}`);

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await exporter.close();
    }
}

// Run if called directly
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { McpSoExporter };