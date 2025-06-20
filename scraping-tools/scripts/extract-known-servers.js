#!/usr/bin/env node

/**
 * Extract configs from known viable MCP.so servers
 */

import puppeteer from 'puppeteer';
import fs from 'fs/promises';

const knownViableServers = [
    { name: 'mcp-server-llmling', author: 'phil65', expectedPackage: 'mcp-server-llmling' },
    { name: 'mcp-server-shell', author: 'odysseus0', expectedPackage: 'mcp-server-shell' },
    { name: 'perplexity-mcp-server', author: 'spragginsdesigns', expectedPackage: 'perplexity-mcp-server' },
    { name: 'mcp-server-bluesky', author: 'morinokami', expectedPackage: 'mcp-server-bluesky' },
    { name: 'mcp-server-replicate', author: 'gerred', expectedPackage: '@gerred/mcp-server-replicate' },
    { name: 'mcp-server-groq', author: 'miguelff', expectedPackage: 'mcp-server-groq' },
    { name: 'mcp-server-tavily', author: 'RamXX', expectedPackage: 'mcp-tavily' },
    { name: 'mcp-server-exa', author: 'BenHagan', expectedPackage: 'mcp-server-exa' },
    { name: 'mcp-server-perplexity', author: 'thecaligarmo', expectedPackage: 'mcp-server-perplexity' },
    { name: 'mcp-server-duckduckgo', author: 'Sunwood-ai-labs', expectedPackage: 'duckduckgo-web-search' }
];

async function extractServerConfig(browser, server) {
    const page = await browser.newPage();
    const url = `https://mcp.so/server/${server.name}/${server.author}`;
    const configUrl = `${url}?tab=content`;
    
    console.log(`\n🔍 Checking ${server.name} by ${server.author}...`);
    console.log(`   URL: ${configUrl}`);
    
    try {
        await page.goto(configUrl, { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });
        
        // Wait for content
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Extract all text content and look for patterns
        const pageContent = await page.evaluate(() => {
            return {
                bodyText: document.body.innerText,
                codeBlocks: Array.from(document.querySelectorAll('pre, code')).map(el => el.textContent),
                jsonBlocks: Array.from(document.querySelectorAll('pre')).map(el => {
                    const text = el.textContent.trim();
                    if (text.includes('mcpServers')) {
                        return text;
                    }
                    return null;
                }).filter(Boolean)
            };
        });
        
        // Look for installation patterns
        let config = null;
        let transport = 'stdio';
        
        // Check for JSON config blocks
        for (const jsonText of pageContent.jsonBlocks) {
            try {
                const match = jsonText.match(/\{[\s\S]*"mcpServers"[\s\S]*\}/);
                if (match) {
                    const parsed = JSON.parse(match[0]);
                    if (parsed.mcpServers) {
                        config = parsed;
                        break;
                    }
                }
            } catch (e) {}
        }
        
        // If no JSON config, look for command patterns
        if (!config) {
            const text = pageContent.bodyText;
            
            // NPX pattern
            const npxMatch = text.match(/npx\s+([@\w\-\/]+)/);
            if (npxMatch) {
                config = {
                    mcpServers: {
                        server: {
                            command: 'npx',
                            args: [npxMatch[1]]
                        }
                    }
                };
            }
            
            // UVX pattern
            const uvxMatch = text.match(/uvx\s+([@\w\-\/]+)/);
            if (uvxMatch) {
                config = {
                    mcpServers: {
                        server: {
                            command: 'uvx',
                            args: [uvxMatch[1]]
                        }
                    }
                };
            }
        }
        
        if (config) {
            const cmd = config.mcpServers?.server?.command || 'unknown';
            const pkg = config.mcpServers?.server?.args?.[0] || 'unknown';
            console.log(`   ✅ Found: ${cmd} ${pkg}`);
            
            return {
                name: server.name,
                author: server.author,
                url: url,
                command: cmd,
                package: pkg,
                transport: transport,
                config: config,
                expectedPackage: server.expectedPackage,
                matches: pkg === server.expectedPackage || pkg.includes(server.expectedPackage)
            };
        } else {
            console.log(`   ⚠️ No config found`);
            return null;
        }
        
    } catch (error) {
        console.log(`   ❌ Error: ${error.message}`);
        return null;
    } finally {
        await page.close();
    }
}

async function main() {
    console.log('🚀 Extracting configs from known viable MCP.so servers...');
    
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const results = [];
    
    try {
        for (const server of knownViableServers) {
            const result = await extractServerConfig(browser, server);
            if (result) {
                results.push(result);
            }
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    } finally {
        await browser.close();
    }
    
    console.log('\n📊 Summary:');
    console.log(`   Tested: ${knownViableServers.length}`);
    console.log(`   Found: ${results.length}`);
    console.log(`   Matching expected: ${results.filter(r => r.matches).length}`);
    
    console.log('\n✅ Viable servers:');
    results.forEach(r => {
        const status = r.matches ? '✅' : '⚠️';
        console.log(`   ${status} ${r.command} ${r.package} (expected: ${r.expectedPackage})`);
    });
    
    // Save results
    await fs.writeFile(
        'data/mcp-so-known-viable.json',
        JSON.stringify(results, null, 2)
    );
    
    console.log('\n💾 Saved to data/mcp-so-known-viable.json');
}

main().catch(console.error);