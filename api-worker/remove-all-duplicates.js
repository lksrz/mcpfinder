const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const execAsync = promisify(exec);

async function deleteKVKey(key) {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    const command = `npx wrangler kv key delete "${key}" --namespace-id ${namespaceId} --remote`;
    
    try {
        await execAsync(command);
        return true;
    } catch (error) {
        console.error(`Error deleting key ${key}:`, error.message);
        return false;
    }
}

async function getKVValue(key) {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    const command = `npx wrangler kv key get "${key}" --namespace-id ${namespaceId}`;
    
    try {
        const { stdout } = await execAsync(command);
        return stdout.trim();
    } catch (error) {
        return null;
    }
}

async function updateKVValue(key, value) {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    const command = `npx wrangler kv key put "${key}" "${value}" --namespace-id ${namespaceId}`;
    
    try {
        await execAsync(command);
        return true;
    } catch (error) {
        console.error(`Error updating key ${key}:`, error.message);
        return false;
    }
}

function calculateToolScore(tool) {
    let score = 0;
    
    // Base scores
    if (tool.name) score += 10;
    if (tool.description && tool.description.length > 20) score += 20;
    if (tool.url) score += 10;
    
    // Capabilities score
    if (tool.capabilities && Array.isArray(tool.capabilities)) {
        score += tool.capabilities.length * 5;
        tool.capabilities.forEach(cap => {
            if (cap.description && cap.description.length > 10) score += 2;
        });
    }
    
    // Tags score
    if (tool.tags && tool.tags.length > 0) {
        score += tool.tags.length * 3;
    }
    
    // Auth and installation bonus
    if (tool.auth) score += 10;
    if (tool.installation) score += 15;
    
    // Verification bonus/penalty
    if (!tool._unverified) score += 20; // Verified tools get bonus
    
    // Penalty for unanalyzed
    if (tool.tags && tool.tags.includes('unanalyzed')) score -= 10;
    
    // Recency bonus (if updated recently)
    if (tool._updatedAt) {
        const daysSinceUpdate = (Date.now() - new Date(tool._updatedAt).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceUpdate < 30) score += 10;
        if (daysSinceUpdate < 7) score += 5;
    }
    
    return score;
}

async function removeAllDuplicates() {
    console.log('🧹 Removing ALL duplicate MCP servers...\n');
    
    // Load the analysis report
    const analysisData = await fs.readFile('tools-analysis-report.json', 'utf-8');
    const analysis = JSON.parse(analysisData);
    
    // Load full tool data
    const toolsData = await fs.readFile('all-tools-data.json', 'utf-8');
    const allTools = JSON.parse(toolsData);
    
    // Create a map for quick lookup
    const toolsMap = new Map();
    allTools.forEach(tool => {
        toolsMap.set(tool._kvId, tool);
    });
    
    console.log(`Found ${analysis.duplicates.length} URLs with duplicates`);
    console.log(`Total duplicate tools to remove: ${analysis.summary.totalDuplicateTools}\n`);
    
    const deletionPlan = [];
    const keepPlan = [];
    
    // Process each duplicate group
    for (const dupGroup of analysis.duplicates) {
        console.log(`\nProcessing: ${dupGroup.url} (${dupGroup.count} copies)`);
        
        // Get full tool data and calculate scores
        const toolsWithScores = dupGroup.tools.map(tool => {
            const fullData = toolsMap.get(tool.id);
            return {
                id: tool.id,
                name: tool.name,
                score: calculateToolScore(fullData),
                verified: tool.verified,
                capabilities: tool.capabilities,
                registeredAt: tool.registeredAt ? new Date(tool.registeredAt) : null,
                updatedAt: tool.updatedAt ? new Date(tool.updatedAt) : null,
                fullData
            };
        });
        
        // Sort by score (highest first), then by date (newest first)
        toolsWithScores.sort((a, b) => {
            // First by score
            if (b.score !== a.score) return b.score - a.score;
            
            // Then by update date (newer is better)
            if (a.updatedAt && b.updatedAt) {
                return b.updatedAt.getTime() - a.updatedAt.getTime();
            }
            
            // Then by registration date (newer is better)
            if (a.registeredAt && b.registeredAt) {
                return b.registeredAt.getTime() - a.registeredAt.getTime();
            }
            
            // Finally by verified status
            if (a.verified !== b.verified) return a.verified ? -1 : 1;
            
            return 0;
        });
        
        // Keep the best one (first in sorted list)
        const keeper = toolsWithScores[0];
        keepPlan.push({
            id: keeper.id,
            name: keeper.name,
            url: dupGroup.url,
            score: keeper.score
        });
        
        console.log(`  ✅ KEEP: ${keeper.name} (${keeper.id})`);
        console.log(`     Score: ${keeper.score}, Verified: ${keeper.verified}, Updated: ${keeper.updatedAt || 'Never'}`);
        
        // Delete the rest
        for (let i = 1; i < toolsWithScores.length; i++) {
            const tool = toolsWithScores[i];
            deletionPlan.push({
                id: tool.id,
                name: tool.name,
                url: dupGroup.url,
                score: tool.score,
                reason: `Duplicate of ${keeper.id} (score: ${tool.score} vs ${keeper.score})`
            });
            
            console.log(`  ❌ DELETE: ${tool.name} (${tool.id})`);
            console.log(`     Score: ${tool.score}, Verified: ${tool.verified}, Updated: ${tool.updatedAt || 'Never'}`);
        }
    }
    
    // Save deletion plan
    const planData = {
        timestamp: new Date().toISOString(),
        summary: {
            duplicateUrls: analysis.duplicates.length,
            toolsToDelete: deletionPlan.length,
            toolsToKeep: keepPlan.length,
            finalUniqueTools: analysis.summary.totalTools - deletionPlan.length
        },
        deletions: deletionPlan,
        kept: keepPlan
    };
    
    await fs.writeFile('duplicate-removal-plan.json', JSON.stringify(planData, null, 2));
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 DELETION PLAN SUMMARY');
    console.log('='.repeat(60));
    console.log(`Duplicate URLs found: ${analysis.duplicates.length}`);
    console.log(`Tools to delete: ${deletionPlan.length}`);
    console.log(`Tools to keep: ${keepPlan.length}`);
    console.log(`Final unique tools: ${planData.summary.finalUniqueTools}`);
    console.log('='.repeat(60));
    
    // Ask for confirmation
    console.log('\n⚠️  Ready to delete duplicates from production KV');
    console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');
    
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Execute deletions
    console.log('🗑️  Starting deletion process...\n');
    
    let deleted = 0;
    let failed = 0;
    
    // First, ensure all kept tools have urlidx entries
    console.log('📝 Ensuring URL indexes for kept tools...\n');
    for (const keep of keepPlan) {
        const urlidxKey = `urlidx:${keep.url}`;
        const currentId = await getKVValue(urlidxKey);
        
        if (currentId !== keep.id) {
            console.log(`Updating urlidx for ${keep.url} to point to ${keep.id}`);
            await updateKVValue(urlidxKey, keep.id);
        }
    }
    
    // Delete duplicate tools
    console.log('\n🗑️  Deleting duplicate tools...\n');
    
    for (const tool of deletionPlan) {
        process.stdout.write(`Deleting ${tool.name} (${tool.id})... `);
        
        const success = await deleteKVKey(`tool:${tool.id}`);
        
        if (success) {
            deleted++;
            console.log('✅');
        } else {
            failed++;
            console.log('❌');
        }
        
        // Rate limiting
        if ((deleted + failed) % 5 === 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    // Final summary
    console.log('\n' + '='.repeat(60));
    console.log('🎉 DUPLICATE REMOVAL COMPLETE!');
    console.log('='.repeat(60));
    console.log(`✅ Successfully deleted: ${deleted} tools`);
    console.log(`❌ Failed to delete: ${failed} tools`);
    console.log(`📊 Final unique tools: ${analysis.summary.totalTools - deleted}`);
    console.log('='.repeat(60));
    
    // Generate final unique tools list
    console.log('\n📄 Generating final unique tools list...');
    
    const finalTools = [];
    const deletedIds = new Set(deletionPlan.map(d => d.id));
    
    for (const tool of allTools) {
        if (!deletedIds.has(tool._kvId)) {
            finalTools.push(tool);
        }
    }
    
    // Sort by name
    finalTools.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    await fs.writeFile('final-unique-tools.json', JSON.stringify(finalTools, null, 2));
    
    console.log(`\n✅ Saved ${finalTools.length} unique tools to final-unique-tools.json`);
    
    // Save deletion commands as backup
    const deletionCommands = deletionPlan.map(tool => 
        `npx wrangler kv key delete "tool:${tool.id}" --namespace-id 59bfeb2ef6ab471a9a3461f113704891 --remote`
    );
    
    await fs.writeFile('deletion-commands-backup.sh', 
        '#!/bin/bash\n\n# Backup deletion commands\n\n' + deletionCommands.join('\n') + '\n'
    );
    
    console.log('📁 Backup deletion commands saved to deletion-commands-backup.sh');
}

// Run the removal
removeAllDuplicates().catch(console.error);