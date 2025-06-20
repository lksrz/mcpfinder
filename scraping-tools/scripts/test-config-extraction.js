#!/usr/bin/env node

/**
 * Test configuration extraction from MCP.so using Puppeteer
 */

import puppeteer from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Use stealth plugin to avoid detection
puppeteerExtra.use(StealthPlugin());

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

async function extractConfigFromPage(page, server) {
    console.log(`\n🔍 Testing ${server.name}...`);
    console.log(`   URL: ${server.url}`);
    
    try {
        // Navigate to the server page
        await page.goto(server.url, { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });
        
        // Wait for content to load
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Click on the Content tab if it exists
        const contentTab = await page.evaluate(() => {
            // Look for Content tab/button
            const selectors = [
                'button:contains("Content")',
                '[role="tab"]:contains("Content")',
                'a:contains("Content")',
                'button',
                '[role="tab"]',
                'a'
            ];
            
            for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                for (const el of elements) {
                    if (el.textContent?.includes('Content')) {
                        return { found: true, selector };
                    }
                }
            }
            return { found: false };
        });
        
        if (contentTab.found) {
            console.log('   📑 Found Content tab, clicking...');
            // Click the Content tab
            await page.evaluate(() => {
                const elements = document.querySelectorAll('button, [role="tab"], a');
                for (const el of elements) {
                    if (el.textContent?.includes('Content')) {
                        el.click();
                        break;
                    }
                }
            });
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        // Look for configuration code blocks
        const configs = await page.evaluate(() => {
            const results = [];
            
            // Try to find code blocks
            const codeBlocks = document.querySelectorAll('pre, code, .code-block, [class*="code"], [class*="Code"]');
            
            for (const block of codeBlocks) {
                const text = block.textContent?.trim() || '';
                
                // Check if this looks like a config
                if (text.includes('mcpServers') || 
                    text.includes('npx') || 
                    text.includes('uvx') ||
                    text.includes('command') ||
                    text.includes('args')) {
                    
                    results.push({
                        text: text,
                        className: block.className,
                        tagName: block.tagName,
                        parent: block.parentElement?.className || 'no-parent'
                    });
                }
            }
            
            // Also try to find JSON-like structures
            const allText = document.body.textContent || '';
            const jsonMatches = allText.match(/\{[\s\S]*?"mcpServers"[\s\S]*?\}/g);
            if (jsonMatches) {
                jsonMatches.forEach(match => {
                    results.push({
                        text: match,
                        className: 'json-match',
                        tagName: 'TEXT',
                        parent: 'body'
                    });
                });
            }
            
            return results;
        });
        
        if (configs.length > 0) {
            console.log(`   ✅ Found ${configs.length} potential config(s)`);
            
            // Analyze each config
            for (let i = 0; i < configs.length; i++) {
                const config = configs[i];
                console.log(`\n   📄 Config ${i + 1}:`);
                console.log(`      Tag: ${config.tagName}`);
                console.log(`      Class: ${config.className}`);
                console.log(`      Parent: ${config.parent}`);
                console.log(`      Content preview: ${config.text.slice(0, 200)}...`);
                
                // Try to parse as JSON
                try {
                    if (config.text.includes('{') && config.text.includes('}')) {
                        const jsonMatch = config.text.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            const parsed = JSON.parse(jsonMatch[0]);
                            console.log(`      ✅ Valid JSON found`);
                            
                            // Look for mcpServers
                            if (parsed.mcpServers) {
                                const serverNames = Object.keys(parsed.mcpServers);
                                console.log(`      📦 MCP Servers: ${serverNames.join(', ')}`);
                                
                                // Extract commands
                                for (const [name, config] of Object.entries(parsed.mcpServers)) {
                                    if (config.command) {
                                        console.log(`      🚀 ${name}: ${config.command} ${config.args?.join(' ') || ''}`);
                                    }
                                }
                            }
                        }
                    }
                } catch (e) {
                    // Not valid JSON, check for command patterns
                    const npxMatch = config.text.match(/npx\s+([a-zA-Z0-9@/_-]+)/);
                    const uvxMatch = config.text.match(/uvx\s+([a-zA-Z0-9@/_-]+)/);
                    
                    if (npxMatch) {
                        console.log(`      📦 NPX command: npx ${npxMatch[1]}`);
                    }
                    if (uvxMatch) {
                        console.log(`      📦 UVX command: uvx ${uvxMatch[1]}`);
                    }
                }
            }
            
            return {
                server: server.name,
                url: server.url,
                configsFound: configs.length,
                configs: configs.map(c => ({
                    preview: c.text.slice(0, 200),
                    tag: c.tagName,
                    class: c.className
                }))
            };
        } else {
            console.log(`   ⚠️ No configuration found`);
            
            // Let's see what's actually on the page
            const pageContent = await page.evaluate(() => {
                return {
                    title: document.title,
                    headings: Array.from(document.querySelectorAll('h1, h2, h3')).map(h => h.textContent?.trim()),
                    buttons: Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()),
                    links: Array.from(document.querySelectorAll('a')).slice(0, 10).map(a => a.textContent?.trim())
                };
            });
            
            console.log(`   📋 Page structure:`);
            console.log(`      Title: ${pageContent.title}`);
            console.log(`      Headings: ${pageContent.headings.join(', ')}`);
            console.log(`      Buttons: ${pageContent.buttons.join(', ')}`);
            
            return {
                server: server.name,
                url: server.url,
                configsFound: 0,
                pageStructure: pageContent
            };
        }
        
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
    console.log('🧪 Testing MCP.so configuration extraction with Puppeteer...\n');
    
    const browser = await puppeteerExtra.launch({
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
            const result = await extractConfigFromPage(page, server);
            results.push(result);
            
            // Delay between requests
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        // Summary
        console.log('\n\n📊 SUMMARY:');
        console.log('='.repeat(50));
        
        const successful = results.filter(r => r.configsFound > 0);
        console.log(`Total tested: ${results.length}`);
        console.log(`Configs found: ${successful.length}`);
        console.log(`No configs: ${results.filter(r => r.configsFound === 0 && !r.error).length}`);
        console.log(`Errors: ${results.filter(r => r.error).length}`);
        
        console.log('\n✅ Servers with configs:');
        successful.forEach(r => {
            console.log(`   - ${r.server}: ${r.configsFound} config(s)`);
        });
        
        console.log('\n⚠️ Servers without configs:');
        results.filter(r => r.configsFound === 0 && !r.error).forEach(r => {
            console.log(`   - ${r.server}`);
        });
        
    } finally {
        await browser.close();
    }
}

main().catch(console.error);