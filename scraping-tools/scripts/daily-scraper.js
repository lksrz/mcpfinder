#!/usr/bin/env node

import { runAllScrapers } from './scrapers/run-all-scrapers.js';
import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const SCHEDULE = process.env.SCRAPER_SCHEDULE || '0 6 * * *'; // Daily at 6 AM UTC
const LOG_FILE = path.join(__dirname, '../../data/daily-scraper.log');

/**
 * Log message to file and console
 */
async function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    
    console.log(logMessage);
    
    try {
        const logDir = path.dirname(LOG_FILE);
        await fs.mkdir(logDir, { recursive: true });
        await fs.appendFile(LOG_FILE, logMessage + '\n');
    } catch (error) {
        console.error('Failed to write to log file:', error);
    }
}

/**
 * Run daily scraping task
 */
async function runDailyScraping() {
    await log('🚀 Starting daily MCP server scraping...');
    
    try {
        const results = await runAllScrapers();
        
        await log(`✅ Daily scraping completed successfully`);
        await log(`   New servers found: ${results.summary.totalNewServers}`);
        await log(`   Successful registrations: ${results.summary.totalSuccessfulRegistrations}`);
        await log(`   Duration: ${Math.round(results.totalDuration / 1000)}s`);
        
        // Send notification if configured
        if (process.env.WEBHOOK_URL) {
            await sendNotification(results);
        }
        
    } catch (error) {
        await log(`❌ Daily scraping failed: ${error.message}`);
        throw error;
    }
}

/**
 * Send notification webhook (optional)
 */
async function sendNotification(results) {
    try {
        const { default: fetch } = await import('node-fetch');
        
        const payload = {
            text: `🤖 MCPfinder Daily Scraping Report`,
            attachments: [
                {
                    color: results.summary.scrapersFailed > 0 ? 'warning' : 'good',
                    fields: [
                        {
                            title: 'New Servers Found',
                            value: results.summary.totalNewServers,
                            short: true
                        },
                        {
                            title: 'Successful Registrations',
                            value: results.summary.totalSuccessfulRegistrations,
                            short: true
                        },
                        {
                            title: 'Scrapers Succeeded',
                            value: results.summary.scrapersSucceeded,
                            short: true
                        },
                        {
                            title: 'Scrapers Failed',
                            value: results.summary.scrapersFailed,
                            short: true
                        }
                    ]
                }
            ]
        };
        
        const response = await fetch(process.env.WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (response.ok) {
            await log('📣 Notification sent successfully');
        } else {
            await log(`⚠️  Failed to send notification: ${response.status}`);
        }
        
    } catch (error) {
        await log(`⚠️  Failed to send notification: ${error.message}`);
    }
}

/**
 * Start the daily scraping scheduler
 */
export async function startDailyScheduler() {
    await log(`📅 Daily scraper scheduler starting with schedule: ${SCHEDULE}`);
    
    // Validate cron schedule
    if (!cron.validate(SCHEDULE)) {
        throw new Error(`Invalid cron schedule: ${SCHEDULE}`);
    }
    
    // Schedule the task
    const task = cron.schedule(SCHEDULE, async () => {
        try {
            await runDailyScraping();
        } catch (error) {
            await log(`💥 Scheduled scraping failed: ${error.message}`);
        }
    }, {
        scheduled: false, // Don't start immediately
        timezone: "UTC"
    });
    
    // Start the scheduler
    task.start();
    await log('✅ Daily scraper scheduler is running');
    
    // Run immediately if requested
    if (process.env.RUN_IMMEDIATELY === 'true') {
        await log('🏃 Running scraping immediately as requested...');
        setTimeout(() => runDailyScraping(), 1000);
    }
    
    // Keep the process alive
    process.on('SIGINT', async () => {
        await log('🛑 Stopping daily scraper scheduler...');
        task.stop();
        process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
        await log('🛑 Stopping daily scraper scheduler...');
        task.stop();
        process.exit(0);
    });
    
    return task;
}

/**
 * Run scraping once (for CLI usage)
 */
export async function runOnce() {
    await log('🔄 Running one-time scraping...');
    await runDailyScraping();
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    
    if (args.includes('--once') || args.includes('-o')) {
        // Run once and exit
        runOnce()
            .then(() => {
                console.log('✅ One-time scraping completed');
                process.exit(0);
            })
            .catch((error) => {
                console.error('❌ One-time scraping failed:', error);
                process.exit(1);
            });
    } else {
        // Start scheduler
        startDailyScheduler()
            .then(() => {
                console.log('📅 Daily scheduler is running. Press Ctrl+C to stop.');
            })
            .catch((error) => {
                console.error('❌ Failed to start daily scheduler:', error);
                process.exit(1);
            });
    }
}