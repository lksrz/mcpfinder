import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_FILE = path.join(__dirname, '../../data/scraper-results.log');

/**
 * Log a scraper result to the common log file
 * @param {string} packageOrUrl - The package name or URL
 * @param {string} result - The result (registered, updated, failed, skipped)
 * @param {string} source - The source scraper (e.g., glama-ai, mcp-so)
 */
export async function logScraperResult(packageOrUrl, result, source) {
    try {
        // Ensure log directory exists
        const logDir = path.dirname(LOG_FILE);
        await fs.mkdir(logDir, { recursive: true });
        
        // Create log entry
        const timestamp = new Date().toISOString();
        const logEntry = `${timestamp} | ${packageOrUrl} | ${result} | ${source}\n`;
        
        // Append to log file
        await fs.appendFile(LOG_FILE, logEntry);
    } catch (error) {
        console.error('Failed to write to log:', error.message);
    }
}

/**
 * Read recent log entries
 * @param {number} limit - Number of recent entries to return
 */
export async function readRecentLogs(limit = 100) {
    try {
        const content = await fs.readFile(LOG_FILE, 'utf-8');
        const lines = content.trim().split('\n');
        return lines.slice(-limit);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}