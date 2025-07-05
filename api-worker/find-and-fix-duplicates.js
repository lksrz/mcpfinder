const fetch = require('node-fetch');
const crypto = require('crypto');

const API_URL = 'https://mcpfinder.dev';
const REGISTRY_SECRET = process.env.MCP_REGISTRY_SECRET;

// Generate HMAC signature for authenticated requests
function generateHmac(secret, body) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function getAllTools() {
    console.log('📥 Fetching all tools from API...');
    const allTools = [];
    let page = 0;
    const pageSize = 100;
    
    // Fetch tools in batches
    while (true) {
        try {
            // Note: API doesn't support pagination, so we get what we can
            const response = await fetch(`${API_URL}/api/v1/search?limit=${pageSize}`);
            const tools = await response.json();
            
            if (tools.length === 0) break;
            
            allTools.push(...tools);
            
            // If we got less than pageSize, we've reached the end
            if (tools.length < pageSize) break;
            
            // API doesn't support offset, so we only get first batch
            console.log(`Fetched ${allTools.length} tools (API limit reached)`);
            break;
        } catch (error) {
            console.error('Error fetching tools:', error);
            break;
        }
    }
    
    return allTools;
}

async function getToolDetails(toolId) {
    try {
        const response = await fetch(`${API_URL}/api/v1/tools/${toolId}`);
        if (!response.ok) {
            console.error(`Failed to fetch tool ${toolId}: ${response.statusText}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error(`Error fetching tool ${toolId}:`, error);
        return null;
    }
}

async function deleteToolViaKV(toolId) {
    // This would need direct KV access or an admin API endpoint
    // For now, we'll just log what should be deleted
    console.log(`Would delete tool: ${toolId}`);
    return true;
}

function calculateToolScore(tool) {
    let score = 0;
    
    // Score based on completeness of data
    if (tool.name) score += 10;
    if (tool.description && tool.description.length > 20) score += 20;
    if (tool.url) score += 10;
    if (tool.capabilities && Array.isArray(tool.capabilities)) {
        score += tool.capabilities.length * 5;
        // Extra points for detailed capability descriptions
        tool.capabilities.forEach(cap => {
            if (cap.description && cap.description.length > 10) score += 2;
        });
    }
    if (tool.tags && tool.tags.length > 0) score += tool.tags.length * 3;
    if (tool.auth) score += 10;
    if (tool.installation) score += 15;
    
    // Penalty for unverified
    if (tool._unverified) score -= 20;
    
    // Penalty for unanalyzed tag
    if (tool.tags && tool.tags.includes('unanalyzed')) score -= 10;
    
    return score;
}

async function findAndFixDuplicates() {
    console.log('🔍 Finding and analyzing duplicate MCP server registrations...\n');
    
    // First, get all tools
    const allTools = await getAllTools();
    console.log(`\nTotal tools found: ${allTools.length}\n`);
    
    // Group by URL
    const urlGroups = new Map();
    
    for (const tool of allTools) {
        if (!tool.url) continue;
        
        if (!urlGroups.has(tool.url)) {
            urlGroups.set(tool.url, []);
        }
        urlGroups.get(tool.url).push(tool);
    }
    
    // Find duplicates
    const duplicates = [];
    for (const [url, tools] of urlGroups.entries()) {
        if (tools.length > 1) {
            duplicates.push({ url, tools });
        }
    }
    
    console.log(`Found ${duplicates.length} URLs with duplicate registrations\n`);
    
    // Analyze each duplicate group
    const deletionPlan = [];
    
    for (const { url, tools } of duplicates) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`URL: ${url}`);
        console.log(`Duplicates: ${tools.length}`);
        console.log('='.repeat(60));
        
        // Fetch full details for each duplicate
        const toolsWithDetails = [];
        
        for (const tool of tools) {
            const details = await getToolDetails(tool.id);
            if (details) {
                const score = calculateToolScore(details);
                toolsWithDetails.push({
                    ...tool,
                    details,
                    score,
                    registeredAt: details._registeredAt ? new Date(details._registeredAt) : null,
                    updatedAt: details._updatedAt ? new Date(details._updatedAt) : null
                });
            }
        }
        
        // Sort by score (highest first), then by date (newest first)
        toolsWithDetails.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (a.updatedAt && b.updatedAt) return b.updatedAt - a.updatedAt;
            if (a.registeredAt && b.registeredAt) return b.registeredAt - a.registeredAt;
            return 0;
        });
        
        // Display analysis
        for (let i = 0; i < toolsWithDetails.length; i++) {
            const t = toolsWithDetails[i];
            const keep = i === 0; // Keep the first one (best score/newest)
            
            console.log(`\n${keep ? '✅ KEEP' : '❌ DELETE'}: ${t.details.name} (ID: ${t.id})`);
            console.log(`   Score: ${t.score}`);
            console.log(`   Registered: ${t.registeredAt || 'Unknown'}`);
            console.log(`   Updated: ${t.updatedAt || 'Unknown'}`);
            console.log(`   Verified: ${!t.details._unverified}`);
            console.log(`   Capabilities: ${t.details.capabilities?.length || 0}`);
            console.log(`   Tags: ${t.details.tags?.join(', ') || 'None'}`);
            
            if (!keep) {
                deletionPlan.push({
                    id: t.id,
                    name: t.details.name,
                    url: t.url,
                    reason: `Duplicate of ${toolsWithDetails[0].id} with lower score (${t.score} vs ${toolsWithDetails[0].score})`
                });
            }
        }
    }
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 DELETION SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total duplicates to delete: ${deletionPlan.length}`);
    console.log(`URLs that will be deduplicated: ${duplicates.length}`);
    
    if (deletionPlan.length > 0) {
        console.log('\nTools to delete:');
        deletionPlan.forEach((tool, idx) => {
            console.log(`${idx + 1}. ${tool.name} (${tool.id})`);
            console.log(`   URL: ${tool.url}`);
            console.log(`   Reason: ${tool.reason}`);
        });
        
        // Save deletion plan
        const fs = require('fs').promises;
        const planFile = 'deletion-plan.json';
        await fs.writeFile(planFile, JSON.stringify({
            timestamp: new Date().toISOString(),
            duplicatesFound: duplicates.length,
            toolsToDelete: deletionPlan
        }, null, 2));
        
        console.log(`\n📁 Deletion plan saved to ${planFile}`);
        console.log('\nTo execute deletions, we need to implement direct KV access or an admin API endpoint.');
        
        // Generate wrangler commands for deletion
        console.log('\n📝 Wrangler commands to delete duplicates:\n');
        deletionPlan.forEach(tool => {
            console.log(`npx wrangler kv delete "tool:${tool.id}" --namespace-id 59bfeb2ef6ab471a9a3461f113704891`);
            console.log(`npx wrangler kv delete "urlidx:${tool.url}" --namespace-id 59bfeb2ef6ab471a9a3461f113704891`);
        });
    }
}

// Run the analysis
findAndFixDuplicates().catch(console.error);