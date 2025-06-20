#!/usr/bin/env node

/**
 * Test configuration extraction from MCP.so pages with cookie handling
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

async function handleCookieConsent(page) {
    try {
        // Look for cookie consent buttons
        const acceptButtonSelectors = [
            'button:contains("Accept")',
            'button:contains("accept")',
            '[class*="accept"]',
            '[id*="accept"]',
            'button.primary',
            'button[type="button"]'
        ];
        
        const accepted = await page.evaluate((selectors) => {
            // Try to find and click accept button
            const buttons = document.querySelectorAll('button');
            for (const button of buttons) {
                const text = button.textContent?.toLowerCase() || '';
                if (text.includes('accept') || text.includes('agree') || text.includes('ok')) {
                    button.click();
                    return true;
                }
            }
            
            // Also try closing any modal overlays
            const modals = document.querySelectorAll('[role="dialog"], .modal, [class*="modal"], [class*="overlay"]');
            for (const modal of modals) {
                const closeButton = modal.querySelector('button');
                if (closeButton) {
                    closeButton.click();
                    return true;
                }
            }
            
            return false;
        }, acceptButtonSelectors);
        
        if (accepted) {
            console.log('   🍪 Handled cookie consent');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    } catch (e) {
        // Ignore errors in cookie handling
    }
}

async function extractConfigsFromPage(page, server) {
    console.log(`\n🔍 Extracting from ${server.name}...`);
    console.log(`   URL: ${server.url}`);
    
    try {
        // Navigate to the page
        await page.goto(server.url, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        // Handle cookie consent
        await handleCookieConsent(page);
        
        // Try to navigate to different tabs
        const tabsToTry = ['Installation', 'Install', 'Setup', 'Configuration', 'Config', 'Getting Started'];
        
        for (const tabName of tabsToTry) {
            const clicked = await page.evaluate((tab) => {
                const elements = document.querySelectorAll('a, button, [role="tab"], li');
                for (const el of elements) {
                    if (el.textContent?.toLowerCase().includes(tab.toLowerCase())) {
                        el.click();
                        return true;
                    }
                }
                return false;
            }, tabName);
            
            if (clicked) {
                console.log(`   📑 Clicked ${tabName} tab`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                break;
            }
        }
        
        // Extract configuration data
        const configData = await page.evaluate(() => {
            const data = {
                title: document.title,
                url: window.location.href,
                configs: [],
                codeBlocks: [],
                preBlocks: [],
                commands: []
            };
            
            // Get all text content
            const bodyText = document.body?.innerText || '';
            
            // Look for JSON configurations
            const jsonMatches = bodyText.match(/\{[\s\S]*?"mcpServers"[\s\S]*?\}/g);
            if (jsonMatches) {
                jsonMatches.forEach(match => {
                    try {
                        const parsed = JSON.parse(match);
                        data.configs.push({
                            type: 'json',
                            content: parsed
                        });
                    } catch (e) {
                        // Not valid JSON
                    }
                });
            }
            
            // Get all code blocks
            const codeElements = document.querySelectorAll('code, pre, .code-block, [class*="code"], .highlight');
            codeElements.forEach(el => {
                const text = el.textContent?.trim() || '';
                if (text.length > 10) {
                    // Check for command patterns
                    if (text.includes('uvx') || text.includes('npx') || text.includes('npm install')) {
                        data.commands.push({
                            element: el.tagName,
                            class: el.className,
                            text: text
                        });
                    }
                    
                    data.codeBlocks.push({
                        tag: el.tagName,
                        class: el.className,
                        text: text.substring(0, 200),
                        fullText: text
                    });
                }
            });
            
            // Look for installation instructions in regular text
            const installSections = bodyText.split(/\n\n+/);
            installSections.forEach(section => {
                if (section.toLowerCase().includes('install') || 
                    section.toLowerCase().includes('claude desktop')) {
                    
                    // Check for command patterns
                    const uvxMatch = section.match(/uvx\s+([a-zA-Z0-9@/_-]+)/);
                    const npxMatch = section.match(/npx\s+([a-zA-Z0-9@/_-]+)/);
                    const npmMatch = section.match(/npm\s+install\s+-g\s+([a-zA-Z0-9@/_-]+)/);
                    
                    if (uvxMatch || npxMatch || npmMatch) {
                        data.commands.push({
                            element: 'text',
                            class: 'body-text',
                            text: section.substring(0, 300)
                        });
                    }
                }
            });
            
            return data;
        });
        
        // Take screenshot after extraction
        await page.screenshot({ 
            path: `extracted-${server.name}.png`,
            fullPage: true 
        });
        
        // Analyze results
        console.log(`   📊 Extraction results:`);
        console.log(`      - ${configData.configs.length} JSON configs`);
        console.log(`      - ${configData.commands.length} commands found`);
        console.log(`      - ${configData.codeBlocks.length} code blocks`);
        
        let foundConfig = null;
        
        // Check JSON configs
        if (configData.configs.length > 0) {
            console.log(`\n   ✅ Found JSON configuration!`);
            configData.configs.forEach((config, i) => {
                if (config.content.mcpServers) {
                    const servers = Object.keys(config.content.mcpServers);
                    console.log(`   Config ${i + 1}: ${servers.join(', ')}`);
                    foundConfig = config.content;
                }
            });
        }
        
        // Check commands
        if (configData.commands.length > 0) {
            console.log(`\n   🚀 Found commands:`);
            configData.commands.forEach((cmd, i) => {
                console.log(`   ${i + 1}. ${cmd.text.substring(0, 100)}...`);
                
                // Extract package name
                const patterns = [
                    /uvx\s+([a-zA-Z0-9@/_-]+)/,
                    /npx\s+([a-zA-Z0-9@/_-]+)/,
                    /npm\s+install\s+-g\s+([a-zA-Z0-9@/_-]+)/
                ];
                
                for (const pattern of patterns) {
                    const match = cmd.text.match(pattern);
                    if (match) {
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
        }
        
        // Sample some code blocks
        if (configData.codeBlocks.length > 0 && !foundConfig) {
            console.log(`\n   📝 Sample code blocks:`);
            configData.codeBlocks.slice(0, 3).forEach((block, i) => {
                console.log(`   ${i + 1}. [${block.tag}] ${block.text}...`);
            });
        }
        
        return {
            server: server.name,
            url: server.url,
            config: foundConfig,
            stats: {
                configs: configData.configs.length,
                commands: configData.commands.length,
                codeBlocks: configData.codeBlocks.length
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
    console.log('🧪 Testing MCP.so configuration extraction with cookie handling...\n');
    
    const browser = await puppeteer.launch({
        headless: 'new', // Run in headless mode
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
        const page = await browser.newPage();
        
        // Set viewport and user agent
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        const results = [];
        
        for (const server of testServers) {
            const result = await extractConfigsFromPage(page, server);
            results.push(result);
            
            // Small delay between requests
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        // Summary
        console.log('\n\n📊 FINAL SUMMARY:');
        console.log('='.repeat(60));
        
        const successful = results.filter(r => r.config);
        const failed = results.filter(r => r.error);
        const noConfig = results.filter(r => !r.config && !r.error);
        
        console.log(`\nTotal tested: ${results.length}`);
        console.log(`✅ Configs found: ${successful.length}`);
        console.log(`⚠️ No configs: ${noConfig.length}`);
        console.log(`❌ Errors: ${failed.length}`);
        
        if (successful.length > 0) {
            console.log('\n✅ Successfully extracted configs:');
            successful.forEach(r => {
                if (r.config.type === 'command') {
                    console.log(`   - ${r.server}: ${r.config.command}`);
                } else if (r.config.mcpServers) {
                    console.log(`   - ${r.server}: JSON config`);
                }
            });
        }
        
        if (noConfig.length > 0) {
            console.log('\n⚠️ No configs found for:');
            noConfig.forEach(r => {
                console.log(`   - ${r.server}`);
            });
        }
        
        // Analysis
        console.log('\n\n💡 FINDINGS:');
        console.log('='.repeat(60));
        
        if (successful.length === 0) {
            console.log('❌ Unable to extract configurations from any servers.');
            console.log('\nThis suggests:');
            console.log('a) The configs might not be present on the main page');
            console.log('b) They require authentication or special access');
            console.log('c) The page structure is different than expected');
            console.log('d) The content is loaded dynamically and requires more interaction');
        } else {
            console.log(`✅ Successfully extracted ${successful.length}/${results.length} configurations.`);
            
            // Check if packages match expected
            let matchCount = 0;
            successful.forEach(r => {
                const expectedServer = testServers.find(s => s.name === r.server);
                if (expectedServer && r.config.package === expectedServer.expectedPackage) {
                    matchCount++;
                }
            });
            
            if (matchCount === successful.length) {
                console.log('✅ All extracted packages match expected names!');
            } else {
                console.log(`⚠️ Only ${matchCount}/${successful.length} packages match expected names.`);
                console.log('This suggests the extraction might be picking up wrong elements.');
            }
        }
        
        console.log('\nCheck the extracted-*.png screenshots for visual confirmation.');
        
    } finally {
        await browser.close();
    }
}

main().catch(console.error);