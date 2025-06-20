#!/usr/bin/env node

/**
 * Extract MCP.so server configurations using Puppeteer
 * This properly renders the page to extract the actual config data
 */

import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';

async function extractServerConfig(browser, server) {
    console.log(`🔍 Extracting config for ${server.name}...`);
    
    const page = await browser.newPage();
    
    try {
        const configUrl = `${server.url}?tab=content`;
        await page.goto(configUrl, { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });
        
        // Wait for content to load
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Try multiple extraction methods
        const config = await page.evaluate(() => {
            // Method 1: Look for JSON in code blocks
            const codeBlocks = document.querySelectorAll('pre code, pre');
            for (const block of codeBlocks) {
                const text = block.textContent.trim();
                if (text.includes('mcpServers') && text.includes('{')) {
                    try {
                        // Extract JSON from the text
                        const jsonMatch = text.match(/\{[\s\S]*"mcpServers"[\s\S]*\}/);
                        if (jsonMatch) {
                            return JSON.parse(jsonMatch[0]);
                        }
                    } catch (e) {}
                }
            }
            
            // Method 2: Look for command patterns in text
            const pageText = document.body.innerText;
            const commands = [];
            
            // NPX pattern
            const npxMatches = pageText.matchAll(/npx\s+([@\w\-\/]+)/g);
            for (const match of npxMatches) {
                commands.push({
                    command: 'npx',
                    package: match[1]
                });
            }
            
            // UVX pattern
            const uvxMatches = pageText.matchAll(/uvx\s+([@\w\-\/]+)/g);
            for (const match of uvxMatches) {
                commands.push({
                    command: 'uvx',
                    package: match[1]
                });
            }
            
            if (commands.length > 0) {
                return {
                    mcpServers: {
                        server: {
                            command: commands[0].command,
                            args: [commands[0].package]
                        }
                    }
                };
            }
            
            return null;
        });
        
        if (config) {
            console.log(`   ✅ Found config: ${config.mcpServers?.server?.command} ${config.mcpServers?.server?.args?.[0]}`);
            return {
                ...server,
                config,
                configUrl,
                extractedAt: new Date().toISOString()
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
    console.log('🚀 Starting MCP.so config extraction with Puppeteer...\n');
    
    // Load the list of servers to process
    const serversData = await fs.readFile('data/mcp-so-servers-merged.json', 'utf-8');
    const allServers = JSON.parse(serversData);
    
    // For testing, just process first 50 servers
    const serversToProcess = allServers.slice(0, 50);
    
    console.log(`📊 Processing ${serversToProcess.length} servers...\n`);
    
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const results = [];
    const batchSize = 5;
    
    try {
        for (let i = 0; i < serversToProcess.length; i += batchSize) {
            const batch = serversToProcess.slice(i, i + batchSize);
            
            console.log(`\n📦 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(serversToProcess.length/batchSize)}...`);
            
            const batchResults = await Promise.all(
                batch.map(server => extractServerConfig(browser, server))
            );
            
            const validResults = batchResults.filter(r => r !== null);
            results.push(...validResults);
            
            // Save intermediate results
            await fs.writeFile(
                'data/mcp-so-configs-puppeteer.json',
                JSON.stringify(results, null, 2)
            );
            
            console.log(`   💾 Saved ${results.length} configs so far`);
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
    } finally {
        await browser.close();
    }
    
    // Analyze results
    const viableServers = results.filter(s => {
        const cmd = s.config?.mcpServers?.server?.command;
        const args = s.config?.mcpServers?.server?.args;
        return (cmd === 'npx' || cmd === 'uvx') && args && args[0] && !args[0].includes('可执行文件');
    });
    
    console.log('\n📊 Extraction Summary:');
    console.log(`   Total processed: ${serversToProcess.length}`);
    console.log(`   Configs found: ${results.length}`);
    console.log(`   Viable (npx/uvx): ${viableServers.length}`);
    
    console.log('\n✅ Sample viable servers:');
    viableServers.slice(0, 10).forEach(s => {
        const cmd = s.config.mcpServers.server.command;
        const pkg = s.config.mcpServers.server.args[0];
        console.log(`   - ${cmd} ${pkg} (${s.name.split('@')[0]})`);
    });
    
    // Save final viable servers
    await fs.writeFile(
        'data/mcp-so-viable-puppeteer.json',
        JSON.stringify(viableServers, null, 2)
    );
    
    console.log(`\n✅ Saved ${viableServers.length} viable servers to data/mcp-so-viable-puppeteer.json`);
}

main().catch(console.error);