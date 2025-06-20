#!/usr/bin/env node

import { scrapeMcpSoFeed } from './mcp-so-feed.js';
import { scrapeGitHubRepos } from './github-scraper.js';
import { scrapeMcpServersOrg } from './mcpservers-org-scraper.js';
import { scrapeGlamaAi } from './glama-ai-scraper.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const LOG_FILE = path.join(__dirname, '../../../data/scraper-log.json');

/**
 * Save scraping results to log file
 */
async function saveResults(results) {
    try {
        const logDir = path.dirname(LOG_FILE);
        await fs.mkdir(logDir, { recursive: true });
        
        // Load existing log
        let log = [];
        try {
            const data = await fs.readFile(LOG_FILE, 'utf-8');
            log = JSON.parse(data);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('Error loading log file:', error);
            }
        }
        
        // Add new results
        const logEntry = {
            timestamp: new Date().toISOString(),
            results
        };
        
        log.unshift(logEntry); // Add to beginning
        
        // Keep only last 30 runs
        if (log.length > 30) {
            log = log.slice(0, 30);
        }
        
        // Save updated log
        await fs.writeFile(LOG_FILE, JSON.stringify(log, null, 2));
        console.log(`📄 Results saved to ${LOG_FILE}`);
        
    } catch (error) {
        console.error('❌ Failed to save results:', error);
    }
}

/**
 * Run all scrapers with error handling and reporting
 */
async function runAllScrapers() {
    console.log('🚀 Starting automated MCP server discovery...\n');
    
    const startTime = Date.now();
    const results = {
        startTime: new Date().toISOString(),
        scrapers: {},
        summary: {
            totalNewServers: 0,
            totalSuccessfulRegistrations: 0,
            scrapersFailed: 0,
            scrapersSucceeded: 0
        }
    };
    
    const scrapers = [
        {
            name: 'mcp.so feed',
            func: scrapeMcpSoFeed,
            key: 'mcpSoFeed'
        },
        {
            name: 'GitHub repositories',
            func: scrapeGitHubRepos,
            key: 'githubRepos'
        },
        {
            name: 'mcpservers.org',
            func: scrapeMcpServersOrg,
            key: 'mcpServersOrg'
        },
        {
            name: 'glama.ai',
            func: scrapeGlamaAi,
            key: 'glamaAi'
        }
    ];
    
    for (const scraper of scrapers) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔍 Running ${scraper.name} scraper...`);
        console.log(`${'='.repeat(60)}`);
        
        try {
            const scraperStart = Date.now();
            const scraperResults = await scraper.func();
            const scraperDuration = Date.now() - scraperStart;
            
            results.scrapers[scraper.key] = {
                success: true,
                duration: scraperDuration,
                ...scraperResults
            };
            
            results.summary.totalNewServers += scraperResults.newServers || scraperResults.newEntries || 0;
            results.summary.totalSuccessfulRegistrations += scraperResults.successfulRegistrations || 0;
            results.summary.scrapersSucceeded++;
            
            console.log(`✅ ${scraper.name} completed successfully in ${Math.round(scraperDuration / 1000)}s`);
            
        } catch (error) {
            console.error(`❌ ${scraper.name} failed:`, error.message);
            
            results.scrapers[scraper.key] = {
                success: false,
                error: error.message,
                duration: Date.now() - scraperStart
            };
            
            results.summary.scrapersFailed++;
        }
        
        // Wait between scrapers to be respectful to APIs
        if (scraper !== scrapers[scrapers.length - 1]) {
            console.log('\n⏳ Waiting 5 seconds before next scraper...');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    // Calculate total duration
    const totalDuration = Date.now() - startTime;
    results.endTime = new Date().toISOString();
    results.totalDuration = totalDuration;
    
    // Print summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('📊 SCRAPING SUMMARY');
    console.log(`${'='.repeat(60)}`);
    console.log(`⏱️  Total duration: ${Math.round(totalDuration / 1000)}s`);
    console.log(`✅ Scrapers succeeded: ${results.summary.scrapersSucceeded}`);
    console.log(`❌ Scrapers failed: ${results.summary.scrapersFailed}`);
    console.log(`🆕 Total new servers found: ${results.summary.totalNewServers}`);
    console.log(`📦 Total successful registrations: ${results.summary.totalSuccessfulRegistrations}`);
    
    console.log('\n📋 Individual scraper results:');
    for (const [key, scraperResult] of Object.entries(results.scrapers)) {
        const status = scraperResult.success ? '✅' : '❌';
        const duration = Math.round(scraperResult.duration / 1000);
        console.log(`   ${status} ${key}: ${duration}s`);
        
        if (scraperResult.success) {
            const newServers = scraperResult.newServers || scraperResult.newEntries || 0;
            const registered = scraperResult.successfulRegistrations || 0;
            console.log(`      ${newServers} new, ${registered} registered`);
        } else {
            console.log(`      Error: ${scraperResult.error}`);
        }
    }
    
    // Save results
    await saveResults(results);
    
    console.log('\n🎉 Automated MCP server discovery completed!');
    
    return results;
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    runAllScrapers()
        .then((results) => {
            const exitCode = results.summary.scrapersFailed > 0 ? 1 : 0;
            process.exit(exitCode);
        })
        .catch((error) => {
            console.error('\n💥 Fatal error during scraping:', error);
            process.exit(1);
        });
}

export { runAllScrapers };