#!/usr/bin/env node

/**
 * Test configuration extraction from MCP.so pages
 */

import puppeteer from 'puppeteer';

const testServers = [
    {
        name: 'mcp-server-llmling',
        url: 'https://mcp.so/server/mcp-server-llmling/phil65',
        expectedPackage: 'mcp-server-llmling'
    },
    {
        name: 'mcp-server-shell',
        url: 'https://mcp.so/server/mcp-server-shell/odysseus0',
        expectedPackage: 'mcp-server-shell'
    },
    {
        name: 'perplexity-mcp-server',
        url: 'https://mcp.so/server/perplexity-mcp-server/spragginsdesigns',
        expectedPackage: 'perplexity-mcp-server'
    },
    {
        name: 'mcp-server-bluesky',
        url: 'https://mcp.so/server/mcp-server-bluesky/morinokami',
        expectedPackage: 'mcp-server-bluesky'
    },
    {
        name: 'mcp-server-replicate',
        url: 'https://mcp.so/server/mcp-server-replicate/gerred',
        expectedPackage: 'mcp-server-replicate'
    }
];

async function extractConfigs(page, server) {
    console.log(`\n🔍 Extracting from ${server.name}...`);
    console.log(`   URL: ${server.url}`);
    
    try {
        // Navigate to the page
        await page.goto(server.url, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Wait a bit for dynamic content
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Take a screenshot for debugging
        await page.screenshot({ 
            path: `debug-${server.name}.png`,
            fullPage: true 
        });
        console.log(`   📸 Screenshot saved: debug-${server.name}.png`);
        
        // Extract all text content and structure
        const pageData = await page.evaluate(() => {
            const data = {
                title: document.title,
                url: window.location.href,
                codeBlocks: [],
                preBlocks: [],
                jsonConfigs: [],
                allText: document.body?.innerText || ''
            };
            
            // Get all <code> elements
            const codeElements = document.querySelectorAll('code');
            codeElements.forEach((el, i) => {
                const text = el.textContent?.trim() || '';
                if (text.length > 10) {
                    data.codeBlocks.push({
                        index: i,
                        text: text.substring(0, 500),
                        fullText: text,
                        className: el.className || 'no-class',
                        parentTag: el.parentElement?.tagName || 'none'
                    });
                }
            });
            
            // Get all <pre> elements
            const preElements = document.querySelectorAll('pre');
            preElements.forEach((el, i) => {
                const text = el.textContent?.trim() || '';
                if (text.length > 10) {
                    data.preBlocks.push({
                        index: i,
                        text: text.substring(0, 500),
                        fullText: text,
                        className: el.className || 'no-class'
                    });
                }
            });
            
            // Look for JSON-like structures in the page text
            const jsonPattern = /\{[\s\S]*?"mcpServers"[\s\S]*?\}/g;
            const matches = data.allText.match(jsonPattern);
            if (matches) {
                matches.forEach(match => {
                    try {
                        const parsed = JSON.parse(match);
                        data.jsonConfigs.push({
                            raw: match,
                            parsed: parsed
                        });
                    } catch (e) {
                        // Not valid JSON
                    }
                });
            }
            
            return data;
        });
        
        // Analyze the extracted data
        console.log(`   📊 Found:`);
        console.log(`      - ${pageData.codeBlocks.length} code blocks`);
        console.log(`      - ${pageData.preBlocks.length} pre blocks`);
        console.log(`      - ${pageData.jsonConfigs.length} JSON configs`);
        
        // Look for actual configuration
        let foundConfig = null;
        
        // Check JSON configs first
        if (pageData.jsonConfigs.length > 0) {
            console.log(`\n   ✅ Found JSON configuration!`);
            pageData.jsonConfigs.forEach((config, i) => {
                console.log(`\n   📄 Config ${i + 1}:`);
                console.log(JSON.stringify(config.parsed, null, 2).substring(0, 500) + '...');
                
                if (config.parsed.mcpServers) {
                    const servers = Object.keys(config.parsed.mcpServers);
                    console.log(`   🎯 MCP Servers: ${servers.join(', ')}`);
                    foundConfig = config.parsed;
                }
            });
        }
        
        // Check code blocks for commands
        const commandPatterns = [
            /uvx\s+([a-zA-Z0-9@/_-]+)/,
            /npx\s+([a-zA-Z0-9@/_-]+)/,
            /npm\s+install\s+-g\s+([a-zA-Z0-9@/_-]+)/
        ];
        
        pageData.codeBlocks.forEach((block, i) => {
            for (const pattern of commandPatterns) {
                const match = block.fullText.match(pattern);
                if (match) {
                    console.log(`\n   🚀 Found command in code block ${i}:`);
                    console.log(`      Command: ${match[0]}`);
                    console.log(`      Package: ${match[1]}`);
                    
                    if (!foundConfig) {
                        foundConfig = {
                            type: 'command',
                            command: match[0],
                            package: match[1]
                        };
                    }
                }
            }
        });
        
        // Check pre blocks
        pageData.preBlocks.forEach((block, i) => {
            for (const pattern of commandPatterns) {
                const match = block.fullText.match(pattern);
                if (match) {
                    console.log(`\n   🚀 Found command in pre block ${i}:`);
                    console.log(`      Command: ${match[0]}`);
                    console.log(`      Package: ${match[1]}`);
                    
                    if (!foundConfig) {
                        foundConfig = {
                            type: 'command',
                            command: match[0],
                            package: match[1]
                        };
                    }
                }
            }
        });
        
        // Let's also check what the raw text contains
        if (!foundConfig) {
            console.log(`\n   🔍 Searching raw text for patterns...`);
            
            // Look for Chinese text that was mentioned
            if (pageData.allText.includes('可执行文件的目录）添加到系统的')) {
                console.log(`   ⚠️ Found Chinese text in page!`);
                console.log(`   This suggests the scraper is picking up UI elements instead of config.`);
            }
            
            // Try to find any installation instructions
            const installPatterns = [
                /install.*?:[\s\S]{0,200}(uvx|npx|npm)/gi,
                /installation[\s\S]{0,500}(uvx|npx|npm)/gi,
                /claude.*?desktop[\s\S]{0,500}\{[\s\S]*?\}/gi
            ];
            
            for (const pattern of installPatterns) {
                const matches = pageData.allText.match(pattern);
                if (matches) {
                    console.log(`   📝 Found installation text:`);
                    console.log(`      ${matches[0].substring(0, 200)}...`);
                }
            }
        }
        
        return {
            server: server.name,
            url: server.url,
            foundConfig: foundConfig,
            stats: {
                codeBlocks: pageData.codeBlocks.length,
                preBlocks: pageData.preBlocks.length,
                jsonConfigs: pageData.jsonConfigs.length
            }
        };
        
    } catch (error) {
        console.log(`   ❌ Error: ${error.message}`);
        return {
            server: server.name,
            url: server.url,
            error: error.message
        };
    }
}

async function main() {
    console.log('🧪 Testing MCP.so configuration extraction...\n');
    
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
        const page = await browser.newPage();
        
        // Set viewport and user agent
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        const results = [];
        
        for (const server of testServers) {
            const result = await extractConfigs(page, server);
            results.push(result);
            
            // Small delay between requests
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Summary
        console.log('\n\n📊 EXTRACTION SUMMARY:');
        console.log('='.repeat(60));
        
        const successful = results.filter(r => r.foundConfig);
        const failed = results.filter(r => r.error);
        const noConfig = results.filter(r => !r.foundConfig && !r.error);
        
        console.log(`\nTotal tested: ${results.length}`);
        console.log(`✅ Configs found: ${successful.length}`);
        console.log(`⚠️ No configs: ${noConfig.length}`);
        console.log(`❌ Errors: ${failed.length}`);
        
        if (successful.length > 0) {
            console.log('\n✅ Servers with configs:');
            successful.forEach(r => {
                if (r.foundConfig.type === 'command') {
                    console.log(`   - ${r.server}: ${r.foundConfig.command}`);
                } else if (r.foundConfig.mcpServers) {
                    const servers = Object.keys(r.foundConfig.mcpServers);
                    console.log(`   - ${r.server}: JSON config with ${servers.length} server(s)`);
                }
            });
        }
        
        if (noConfig.length > 0) {
            console.log('\n⚠️ Servers without configs:');
            noConfig.forEach(r => {
                console.log(`   - ${r.server} (${r.stats.codeBlocks} code, ${r.stats.preBlocks} pre blocks)`);
            });
        }
        
        // Recommendations
        console.log('\n\n💡 ANALYSIS:');
        console.log('='.repeat(60));
        
        if (successful.length === 0) {
            console.log('❌ No configurations were successfully extracted.');
            console.log('\nPossible reasons:');
            console.log('1. The configurations are loaded dynamically after page load');
            console.log('2. The configurations are in a different tab/section');
            console.log('3. The page structure has changed');
            console.log('4. We need to interact with the page to reveal configs');
            console.log('\nCheck the debug screenshots for visual inspection.');
        } else {
            console.log(`✅ Found configurations for ${successful.length}/${results.length} servers.`);
            console.log('\nThe extraction method is partially working but may need:');
            console.log('1. Better selectors for finding config blocks');
            console.log('2. Tab/section navigation to access configs');
            console.log('3. Handling of different config formats');
        }
        
    } finally {
        await browser.close();
    }
}

main().catch(console.error);