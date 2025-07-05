#!/usr/bin/env node

/**
 * Bulk register MCP servers from scraped data
 */

import fs from 'fs/promises';
import fetch from 'node-fetch';
import crypto from 'crypto';

const API_URL = process.env.MCPFINDER_API_URL || 'https://mcpfinder.dev';
const REGISTRY_SECRET = process.env.MCP_REGISTRY_SECRET;

/**
 * Generate HMAC signature for request
 */
function generateHmac(secret, body) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Register a single server
 */
async function registerServer(manifest) {
    const body = JSON.stringify(manifest);
    const headers = {
        'Content-Type': 'application/json'
    };
    
    if (REGISTRY_SECRET) {
        headers['Authorization'] = `HMAC ${generateHmac(REGISTRY_SECRET, body)}`;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/v1/register`, {
            method: 'POST',
            headers,
            body
        });
        
        const result = await response.json();
        
        if (response.ok) {
            return { success: true, id: result.id, operation: result.operation };
        } else {
            return { success: false, error: result.message || response.statusText };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Create manifest from scraped server data
 */
function createManifest(server) {
    // Base manifest structure
    const manifest = {
        name: server.name,
        description: server.description || `${server.name} MCP Server`,
        url: server.url || server.name,
        protocol_version: server.protocol_version || 'MCP/1.0',
        capabilities: server.capabilities || [{ name: 'capabilities_unknown', type: 'tool' }],
        tags: server.tags || []
    };
    
    // Add installation info if available
    if (server.command || server.installation) {
        manifest.installation = server.installation || {
            command: server.command,
            args: server.args || []
        };
    }
    
    // Add auth info if available
    if (server.auth) {
        manifest.auth = server.auth;
    }
    
    return manifest;
}

/**
 * Main bulk registration function
 */
async function bulkRegister() {
    console.log('🚀 Starting bulk registration of MCP servers...\n');
    
    if (!REGISTRY_SECRET) {
        console.warn('⚠️  Warning: MCP_REGISTRY_SECRET not set. Registrations will be unverified.\n');
    }
    
    // Load merged server data
    const dataFile = 'data/mcp-so-servers-merged.json';
    console.log(`📂 Loading servers from ${dataFile}...`);
    
    try {
        const data = await fs.readFile(dataFile, 'utf-8');
        const servers = JSON.parse(data);
        
        console.log(`📊 Found ${servers.length} servers to process\n`);
        
        // Filter servers that look viable
        const viableServers = servers.filter(server => {
            // Must have a name
            if (!server.name) return false;
            
            // Skip if it's just a GitHub URL without package info
            if (server.url?.startsWith('https://github.com/') && !server.command && !server.installation) {
                return false;
            }
            
            // Accept if it has installation info or looks like a package
            if (server.command || server.installation) return true;
            
            // Accept if URL looks like an npm package
            if (server.url && !server.url.startsWith('http')) return true;
            
            return false;
        });
        
        console.log(`✅ Found ${viableServers.length} viable servers\n`);
        
        // Registration stats
        const stats = {
            total: viableServers.length,
            created: 0,
            updated: 0,
            failed: 0,
            errors: []
        };
        
        // Process in batches to avoid overwhelming the API
        const BATCH_SIZE = 10;
        const DELAY_MS = 1000;
        
        for (let i = 0; i < viableServers.length; i += BATCH_SIZE) {
            const batch = viableServers.slice(i, i + BATCH_SIZE);
            console.log(`\n📦 Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(viableServers.length/BATCH_SIZE)}...`);
            
            const promises = batch.map(async (server) => {
                const manifest = createManifest(server);
                const result = await registerServer(manifest);
                
                if (result.success) {
                    if (result.operation === 'created') {
                        stats.created++;
                        console.log(`  ✅ Created: ${server.name}`);
                    } else {
                        stats.updated++;
                        console.log(`  🔄 Updated: ${server.name}`);
                    }
                } else {
                    stats.failed++;
                    stats.errors.push({ server: server.name, error: result.error });
                    console.log(`  ❌ Failed: ${server.name} - ${result.error}`);
                }
                
                return result;
            });
            
            await Promise.all(promises);
            
            // Delay between batches
            if (i + BATCH_SIZE < viableServers.length) {
                await new Promise(resolve => setTimeout(resolve, DELAY_MS));
            }
        }
        
        // Save results
        const resultsFile = 'data/bulk-registration-results.json';
        await fs.writeFile(resultsFile, JSON.stringify({
            timestamp: new Date().toISOString(),
            stats,
            errors: stats.errors
        }, null, 2));
        
        // Print summary
        console.log('\n' + '='.repeat(50));
        console.log('📊 Registration Summary:');
        console.log('='.repeat(50));
        console.log(`Total processed: ${stats.total}`);
        console.log(`✅ Created: ${stats.created}`);
        console.log(`🔄 Updated: ${stats.updated}`);
        console.log(`❌ Failed: ${stats.failed}`);
        console.log('='.repeat(50));
        
        if (stats.errors.length > 0) {
            console.log('\n❌ Errors:');
            stats.errors.slice(0, 10).forEach(err => {
                console.log(`  - ${err.server}: ${err.error}`);
            });
            if (stats.errors.length > 10) {
                console.log(`  ... and ${stats.errors.length - 10} more errors`);
            }
        }
        
        console.log(`\n✅ Results saved to ${resultsFile}`);
        
    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    bulkRegister().catch(console.error);
}

export { bulkRegister, registerServer, createManifest };