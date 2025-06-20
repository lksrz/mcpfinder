#!/usr/bin/env node

/**
 * Merge and Analyze MCP.so JSON Files
 * 
 * This script:
 * - Merges multiple JSON files
 * - Removes duplicates
 * - Analyzes the data
 * - Outputs merged file ready for bulk analyzer
 * 
 * Usage:
 * node scripts/merge-mcp-so-files.js
 * node scripts/merge-mcp-so-files.js path/to/files/*.json
 */

import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';

class McpSoMerger {
    constructor() {
        this.allServers = [];
        this.duplicates = [];
        this.stats = {
            totalFiles: 0,
            totalServers: 0,
            duplicateCount: 0,
            uniqueServers: 0
        };
    }

    async findJsonFiles(pattern = null) {
        if (pattern) {
            // Use provided pattern
            return glob(pattern);
        }
        
        // Look for common mcp-so file patterns
        const patterns = [
            'mcp-so-servers*.json',
            'data/mcp-so-servers*.json',
            'downloads/mcp-so-servers*.json',
            '*/mcp-so-servers*.json'
        ];
        
        let files = [];
        for (const pattern of patterns) {
            try {
                const found = await glob(pattern);
                files.push(...found);
            } catch (e) {
                // Ignore pattern errors
            }
        }
        
        // Remove duplicates and sort
        files = [...new Set(files)].sort();
        
        return files;
    }

    async loadFile(filepath) {
        try {
            const content = await fs.readFile(filepath, 'utf-8');
            const data = JSON.parse(content);
            
            // Handle different file formats
            if (Array.isArray(data)) {
                return data;
            } else if (data.servers && Array.isArray(data.servers)) {
                return data.servers;
            } else {
                console.warn(`⚠️  Unknown format in ${filepath}, skipping`);
                return [];
            }
        } catch (error) {
            console.error(`❌ Failed to load ${filepath}:`, error.message);
            return [];
        }
    }

    deduplicateServers(servers) {
        const seen = new Map();
        const unique = [];
        const duplicates = [];
        
        servers.forEach((server, index) => {
            // Create a unique key for deduplication
            const key = this.createServerKey(server);
            
            if (seen.has(key)) {
                duplicates.push({
                    original: seen.get(key),
                    duplicate: { ...server, _originalIndex: index }
                });
            } else {
                seen.set(key, { ...server, _originalIndex: index });
                unique.push(server);
            }
        });
        
        return { unique, duplicates };
    }

    createServerKey(server) {
        // Try multiple approaches for deduplication
        if (server.url) {
            return server.url.toLowerCase().trim();
        }
        if (server.name && server.author) {
            return `${server.name.toLowerCase().trim()}-${server.author.toLowerCase().trim()}`;
        }
        if (server.name) {
            return server.name.toLowerCase().trim();
        }
        // Fallback to JSON string (not ideal but better than nothing)
        return JSON.stringify(server);
    }

    analyzeServers(servers) {
        const analysis = {
            total: servers.length,
            withInstallCommand: 0,
            npmPackages: 0,
            uvxPackages: 0,
            httpEndpoints: 0,
            githubRepos: 0,
            authors: new Set(),
            tags: new Map(),
            missingData: {
                noName: 0,
                noDescription: 0,
                noAuthor: 0
            }
        };

        servers.forEach(server => {
            // Count install commands
            if (server.installCommand) {
                analysis.withInstallCommand++;
                
                const cmd = server.installCommand.toLowerCase();
                if (cmd.includes('npx') || cmd.includes('npm install')) {
                    analysis.npmPackages++;
                } else if (cmd.includes('uvx')) {
                    analysis.uvxPackages++;
                }
            }

            // Count HTTP endpoints
            if (server.url && (server.url.includes('http://') || server.url.includes('https://'))) {
                if (!server.url.includes('mcp.so') && !server.url.includes('github.com')) {
                    analysis.httpEndpoints++;
                }
            }

            // Count GitHub repos
            if (server.url && server.url.includes('github.com')) {
                analysis.githubRepos++;
            }

            // Count authors
            if (server.author) {
                analysis.authors.add(server.author.toLowerCase());
            } else if (server.authorFromUrl) {
                analysis.authors.add(server.authorFromUrl.toLowerCase());
            }

            // Count tags
            if (server.tags && Array.isArray(server.tags)) {
                server.tags.forEach(tag => {
                    const normalizedTag = tag.toLowerCase().trim();
                    analysis.tags.set(normalizedTag, (analysis.tags.get(normalizedTag) || 0) + 1);
                });
            }

            // Count missing data
            if (!server.name || server.name.trim() === '') {
                analysis.missingData.noName++;
            }
            if (!server.description || server.description.trim() === '') {
                analysis.missingData.noDescription++;
            }
            if (!server.author && !server.authorFromUrl) {
                analysis.missingData.noAuthor++;
            }
        });

        // Convert authors set to count
        analysis.uniqueAuthors = analysis.authors.size;
        delete analysis.authors;

        // Convert tags map to sorted array
        analysis.topTags = Array.from(analysis.tags.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([tag, count]) => ({ tag, count }));
        delete analysis.tags;

        return analysis;
    }

    async merge(filePattern = null) {
        console.log('🔍 Finding mcp-so JSON files...');
        
        const files = await this.findJsonFiles(filePattern);
        
        if (files.length === 0) {
            console.error('❌ No mcp-so JSON files found!');
            console.log('💡 Make sure your files are named like:');
            console.log('   - mcp-so-servers*.json');
            console.log('   - data/mcp-so-servers*.json');
            console.log('💡 Or specify a pattern: node scripts/merge-mcp-so-files.js "downloads/*.json"');
            return null;
        }

        console.log(`📁 Found ${files.length} files:`);
        files.forEach(file => console.log(`   - ${file}`));
        
        this.stats.totalFiles = files.length;

        // Load all files
        console.log('\n📖 Loading files...');
        for (const file of files) {
            const servers = await this.loadFile(file);
            console.log(`   ${path.basename(file)}: ${servers.length} servers`);
            this.allServers.push(...servers);
        }

        this.stats.totalServers = this.allServers.length;
        console.log(`\n📊 Total servers loaded: ${this.stats.totalServers}`);

        // Deduplicate
        console.log('\n🔄 Removing duplicates...');
        const { unique, duplicates } = this.deduplicateServers(this.allServers);
        
        this.allServers = unique;
        this.duplicates = duplicates;
        this.stats.duplicateCount = duplicates.length;
        this.stats.uniqueServers = unique.length;

        console.log(`   Duplicates removed: ${this.stats.duplicateCount}`);
        console.log(`   Unique servers: ${this.stats.uniqueServers}`);

        // Analyze
        console.log('\n📈 Analyzing servers...');
        const analysis = this.analyzeServers(this.allServers);

        // Save merged file
        const outputFile = 'data/mcp-so-servers-merged.json';
        await fs.mkdir('data', { recursive: true });
        await fs.writeFile(outputFile, JSON.stringify(this.allServers, null, 2));
        
        console.log(`\n💾 Merged file saved: ${outputFile}`);

        // Display results
        this.displayResults(analysis);

        return {
            servers: this.allServers,
            stats: this.stats,
            analysis,
            outputFile
        };
    }

    displayResults(analysis) {
        console.log('\n' + '='.repeat(60));
        console.log('📊 MCP.so Data Analysis Results');
        console.log('='.repeat(60));
        
        console.log(`\n📈 Overall Statistics:`);
        console.log(`   Total unique servers: ${analysis.total.toLocaleString()}`);
        console.log(`   Unique authors: ${analysis.uniqueAuthors.toLocaleString()}`);
        
        console.log(`\n🚀 Installation Methods:`);
        console.log(`   With install commands: ${analysis.withInstallCommand} (${(analysis.withInstallCommand/analysis.total*100).toFixed(1)}%)`);
        console.log(`   NPM packages (npx): ${analysis.npmPackages}`);
        console.log(`   Python packages (uvx): ${analysis.uvxPackages}`);
        console.log(`   HTTP endpoints: ${analysis.httpEndpoints}`);
        console.log(`   GitHub repositories: ${analysis.githubRepos}`);
        
        console.log(`\n🏷️  Top Tags:`);
        analysis.topTags.slice(0, 10).forEach(({ tag, count }) => {
            console.log(`   ${tag}: ${count}`);
        });
        
        console.log(`\n⚠️  Data Quality:`);
        console.log(`   Missing name: ${analysis.missingData.noName}`);
        console.log(`   Missing description: ${analysis.missingData.noDescription}`);
        console.log(`   Missing author: ${analysis.missingData.noAuthor}`);
        
        console.log(`\n📋 Next Steps:`);
        console.log(`   1. Analyze viable servers:`);
        console.log(`      node src/scrapers/mcp-so-bulk-analyzer.js analyze data/mcp-so-servers-merged.json`);
        console.log(`   2. Register viable servers:`);
        console.log(`      node src/scrapers/mcp-so-bulk-analyzer.js register data/mcp-so-viable-servers.json`);
    }
}

async function main() {
    const pattern = process.argv[2];
    
    console.log('='.repeat(60));
    console.log('🔄 MCP.so JSON File Merger & Analyzer');
    console.log('='.repeat(60));
    
    const merger = new McpSoMerger();
    
    try {
        const result = await merger.merge(pattern);
        if (result) {
            console.log(`\n✅ Successfully merged ${result.stats.totalFiles} files!`);
            console.log(`   Unique servers: ${result.stats.uniqueServers}`);
            console.log(`   Output file: ${result.outputFile}`);
        }
    } catch (error) {
        console.error('\n❌ Merge failed:', error);
        process.exit(1);
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export { McpSoMerger };