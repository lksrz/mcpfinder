#!/usr/bin/env node

import { readRecentLogs } from './scraper-log.js';
import chalk from 'chalk';

async function viewLog() {
    console.log(chalk.bold('\n📊 Scraper Results Log\n'));
    console.log(chalk.gray('Timestamp                        | Package/URL                                    | Result     | Source'));
    console.log(chalk.gray('-'.repeat(120)));
    
    try {
        const logs = await readRecentLogs(100);
        
        for (const log of logs) {
            const [timestamp, packageOrUrl, result, source] = log.split(' | ');
            
            let resultColor;
            switch(result?.trim()) {
                case 'registered':
                    resultColor = chalk.green;
                    break;
                case 'updated':
                    resultColor = chalk.blue;
                    break;
                case 'failed':
                    resultColor = chalk.red;
                    break;
                case 'skipped':
                    resultColor = chalk.yellow;
                    break;
                case 'skipped-github':
                    resultColor = chalk.gray;
                    break;
                default:
                    resultColor = chalk.white;
            }
            
            console.log(
                `${chalk.dim(timestamp?.substring(0, 23) || '')} | ` +
                `${(packageOrUrl || '').padEnd(45)} | ` +
                `${resultColor((result || '').padEnd(10))} | ` +
                `${chalk.cyan(source || '')}`
            );
        }
        
        // Show summary
        const registered = logs.filter(l => l.includes('| registered |')).length;
        const updated = logs.filter(l => l.includes('| updated |')).length;
        const failed = logs.filter(l => l.includes('| failed |')).length;
        const skipped = logs.filter(l => l.includes('| skipped |') && !l.includes('| skipped-github |')).length;
        const githubSkipped = logs.filter(l => l.includes('| skipped-github |')).length;
        
        console.log(chalk.gray('\n' + '-'.repeat(120)));
        console.log(chalk.bold('\nSummary:'));
        console.log(`  ${chalk.green('Registered:')} ${registered}`);
        console.log(`  ${chalk.blue('Updated:')} ${updated}`);
        console.log(`  ${chalk.red('Failed:')} ${failed}`);
        console.log(`  ${chalk.yellow('Skipped:')} ${skipped}`);
        console.log(`  ${chalk.gray('GitHub Repos:')} ${githubSkipped}`);
        console.log(`  ${chalk.white('Total:')} ${logs.length}`);
        
    } catch (error) {
        console.error(chalk.red('Error reading log:', error.message));
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    viewLog();
}