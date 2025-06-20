#!/usr/bin/env node

/**
 * Quick MCP.so Analyzer - Fast analysis of merged servers
 * Focuses on finding the most viable servers quickly
 */

import fs from 'fs/promises';
import fetch from 'node-fetch';

class QuickMcpAnalyzer {
    constructor() {
        this.viable = [];
        this.stats = {
            total: 0,
            processed: 0,
            npmPackages: 0,
            uvxPackages: 0,
            httpEndpoints: 0,
            githubRepos: 0,
            unknown: 0
        };
    }

    async analyzeFile(filePath) {
        console.log('🔍 Quick analysis of MCP.so servers...');
        
        const data = await fs.readFile(filePath, 'utf-8');
        const servers = JSON.parse(data);
        
        this.stats.total = servers.length;
        console.log(`📊 Analyzing ${servers.length} servers (quick mode)...`);

        // Quick categorization without HTTP requests
        for (const server of servers) {
            this.stats.processed++;
            
            const category = this.quickCategorize(server);
            
            if (category !== 'unknown') {
                this.viable.push({
                    ...server,
                    category,
                    viabilityCheck: 'quick-scan'
                });
                
                this.stats[category]++;
                
                if (this.stats.processed % 1000 === 0) {
                    console.log(`   Processed ${this.stats.processed}/${this.stats.total} servers...`);
                }
            } else {
                this.stats.unknown++;
            }
        }

        await this.saveResults();
        this.displayResults();
    }

    quickCategorize(server) {
        const name = server.name?.toLowerCase() || '';
        const url = server.url?.toLowerCase() || '';
        const author = server.author?.toLowerCase() || '';
        
        // Check for npm package patterns
        if (this.isNpmPackage(name, url, author)) {
            return 'npmPackages';
        }
        
        // Check for Python package patterns
        if (this.isPythonPackage(name, url, author)) {
            return 'uvxPackages';
        }
        
        // Check for HTTP endpoints (non-GitHub, non-mcp.so)
        if (this.isHttpEndpoint(url)) {
            return 'httpEndpoints';
        }
        
        // Check for GitHub repositories
        if (this.isGithubRepo(url)) {
            return 'githubRepos';
        }
        
        return 'unknown';
    }

    isNpmPackage(name, url, author) {
        // Common npm package patterns
        const npmPatterns = [
            /^@[\w-]+\/[\w-]+$/,  // @scope/package
            /^[\w-]+$/,           // simple-package-name
            /mcp.*server/,        // mcp-server-*
            /server.*mcp/         // *-server-mcp
        ];
        
        // Exclude obvious non-packages
        if (url.includes('github.com') || url.includes('mcp.so')) {
            return false;
        }
        
        return npmPatterns.some(pattern => pattern.test(name));
    }

    isPythonPackage(name, url, author) {
        // Python package indicators
        const pythonPatterns = [
            /python/i,
            /\.py$/,
            /_/,  // Python uses underscores
            /pip/i
        ];
        
        if (url.includes('github.com') || url.includes('mcp.so')) {
            return false;
        }
        
        return pythonPatterns.some(pattern => pattern.test(name));
    }

    isHttpEndpoint(url) {
        if (!url) return false;
        
        // Must be HTTP/HTTPS
        if (!url.startsWith('http')) return false;
        
        // Exclude known non-endpoints
        if (url.includes('github.com') || 
            url.includes('mcp.so/server/') ||
            url.includes('npmjs.com')) {
            return false;
        }
        
        // Look for API-like patterns
        const apiPatterns = [
            /api\./,
            /\.herokuapp\.com/,
            /\.vercel\.app/,
            /\.netlify\.app/,
            /\.railway\.app/,
            /localhost:\d+/,
            /:\d{4,5}$/  // Port numbers
        ];
        
        return apiPatterns.some(pattern => pattern.test(url));
    }

    isGithubRepo(url) {
        return url?.includes('github.com') || false;
    }

    async saveResults() {
        // Save viable servers
        const viableFile = 'data/mcp-so-viable-quick.json';
        await fs.writeFile(viableFile, JSON.stringify(this.viable, null, 2));
        
        // Save analysis report
        const reportFile = 'data/mcp-so-quick-analysis.json';
        const report = {
            timestamp: new Date().toISOString(),
            stats: this.stats,
            viableCount: this.viable.length,
            methodology: 'quick-pattern-matching',
            categories: {
                npmPackages: this.viable.filter(s => s.category === 'npmPackages').length,
                uvxPackages: this.viable.filter(s => s.category === 'uvxPackages').length,
                httpEndpoints: this.viable.filter(s => s.category === 'httpEndpoints').length,
                githubRepos: this.viable.filter(s => s.category === 'githubRepos').length
            }
        };
        
        await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
        
        console.log(`\n💾 Results saved:`);
        console.log(`   Viable servers: ${viableFile}`);
        console.log(`   Analysis report: ${reportFile}`);
    }

    displayResults() {
        console.log('\n' + '='.repeat(60));
        console.log('⚡ Quick MCP.so Analysis Results');
        console.log('='.repeat(60));
        
        console.log(`\n📊 Overall Statistics:`);
        console.log(`   Total servers analyzed: ${this.stats.total.toLocaleString()}`);
        console.log(`   Viable servers found: ${this.viable.length.toLocaleString()}`);
        console.log(`   Viability rate: ${(this.viable.length/this.stats.total*100).toFixed(2)}%`);
        
        console.log(`\n🚀 Viable Server Breakdown:`);
        console.log(`   NPM packages: ${this.stats.npmPackages.toLocaleString()}`);
        console.log(`   Python packages (uvx): ${this.stats.uvxPackages.toLocaleString()}`);
        console.log(`   HTTP endpoints: ${this.stats.httpEndpoints.toLocaleString()}`);
        console.log(`   GitHub repos: ${this.stats.githubRepos.toLocaleString()}`);
        
        console.log(`\n🎯 Next Steps:`);
        console.log(`   1. Review results: data/mcp-so-viable-quick.json`);
        console.log(`   2. Deep analyze top candidates: node src/scrapers/mcp-so-bulk-analyzer.js analyze data/mcp-so-viable-quick.json`);
        console.log(`   3. Register viable servers: node src/scrapers/mcp-so-bulk-analyzer.js register data/mcp-so-viable-quick.json`);
    }
}

async function main() {
    const filePath = process.argv[2] || 'data/mcp-so-servers-merged.json';
    
    console.log('⚡ Quick MCP.so Server Analyzer');
    console.log('================================');
    console.log(`Input file: ${filePath}`);
    
    const analyzer = new QuickMcpAnalyzer();
    
    try {
        await analyzer.analyzeFile(filePath);
    } catch (error) {
        console.error('❌ Analysis failed:', error);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export { QuickMcpAnalyzer };