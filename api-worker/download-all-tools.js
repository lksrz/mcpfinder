const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const execAsync = promisify(exec);

async function getAllToolKeys() {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    const command = `npx wrangler kv key list --namespace-id ${namespaceId} --prefix "tool:" --remote`;
    
    try {
        const { stdout } = await execAsync(command);
        return JSON.parse(stdout);
    } catch (error) {
        console.error('Error fetching tool keys:', error.message);
        return [];
    }
}

async function getKVValue(key) {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    const command = `npx wrangler kv key get "${key}" --namespace-id ${namespaceId} --remote`;
    
    try {
        const { stdout } = await execAsync(command);
        return JSON.parse(stdout);
    } catch (error) {
        console.error(`Error fetching ${key}:`, error.message);
        return null;
    }
}

async function downloadAllTools() {
    console.log('📥 Downloading all tools from production KV...\n');
    
    // Create output directory
    const outputDir = 'downloaded-tools';
    await fs.mkdir(outputDir, { recursive: true });
    
    // Get all tool keys
    console.log('Fetching tool keys...');
    const toolKeys = await getAllToolKeys();
    console.log(`Found ${toolKeys.length} tools to download\n`);
    
    // Download tools in batches
    const BATCH_SIZE = 10;
    const allTools = [];
    const failedDownloads = [];
    
    for (let i = 0; i < toolKeys.length; i += BATCH_SIZE) {
        const batch = toolKeys.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(toolKeys.length / BATCH_SIZE);
        
        console.log(`\nProcessing batch ${batchNum}/${totalBatches} (${i + 1}-${Math.min(i + BATCH_SIZE, toolKeys.length)} of ${toolKeys.length})...`);
        
        // Process batch in parallel
        const batchPromises = batch.map(async (key) => {
            const toolId = key.name.replace('tool:', '');
            const toolData = await getKVValue(key.name);
            
            if (toolData) {
                // Add the ID to the data
                toolData._kvId = toolId;
                allTools.push(toolData);
                
                // Save individual file
                const fileName = `${toolId}.json`;
                await fs.writeFile(
                    path.join(outputDir, fileName),
                    JSON.stringify(toolData, null, 2)
                );
                
                console.log(`  ✅ ${toolData.name || 'Unknown'} (${toolId})`);
                return { success: true, toolId, name: toolData.name };
            } else {
                failedDownloads.push(toolId);
                console.log(`  ❌ Failed to download ${toolId}`);
                return { success: false, toolId };
            }
        });
        
        await Promise.all(batchPromises);
        
        // Rate limiting between batches
        if (i + BATCH_SIZE < toolKeys.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    // Save consolidated file
    console.log('\n💾 Saving consolidated data...');
    
    // Sort tools by name for easier browsing
    allTools.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    await fs.writeFile(
        'all-tools-data.json',
        JSON.stringify(allTools, null, 2)
    );
    
    // Analyze the data
    console.log('\n📊 Analyzing downloaded data...\n');
    
    // Group by URL
    const urlGroups = new Map();
    const noUrlTools = [];
    
    for (const tool of allTools) {
        if (!tool.url) {
            noUrlTools.push(tool);
        } else {
            if (!urlGroups.has(tool.url)) {
                urlGroups.set(tool.url, []);
            }
            urlGroups.get(tool.url).push(tool);
        }
    }
    
    // Find duplicates
    const duplicates = [];
    for (const [url, tools] of urlGroups.entries()) {
        if (tools.length > 1) {
            duplicates.push({ url, tools });
        }
    }
    
    // Create analysis report
    const analysis = {
        timestamp: new Date().toISOString(),
        summary: {
            totalTools: allTools.length,
            failedDownloads: failedDownloads.length,
            toolsWithoutUrl: noUrlTools.length,
            uniqueUrls: urlGroups.size,
            duplicateUrls: duplicates.length,
            totalDuplicateTools: duplicates.reduce((sum, d) => sum + d.tools.length - 1, 0)
        },
        duplicates: duplicates.map(d => ({
            url: d.url,
            count: d.tools.length,
            tools: d.tools.map(t => ({
                id: t._kvId,
                name: t.name,
                verified: !t._unverified,
                capabilities: t.capabilities?.length || 0,
                tags: t.tags || [],
                registeredAt: t._registeredAt,
                updatedAt: t._updatedAt
            }))
        })),
        toolsWithoutUrl: noUrlTools.map(t => ({
            id: t._kvId,
            name: t.name,
            verified: !t._unverified
        })),
        failedDownloads
    };
    
    await fs.writeFile(
        'tools-analysis-report.json',
        JSON.stringify(analysis, null, 2)
    );
    
    // Print summary
    console.log('='.repeat(60));
    console.log('📊 DOWNLOAD COMPLETE - ANALYSIS SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Successfully downloaded: ${allTools.length} tools`);
    console.log(`❌ Failed downloads: ${failedDownloads.length}`);
    console.log(`📁 Individual files saved in: ./${outputDir}/`);
    console.log(`📄 Consolidated data: ./all-tools-data.json`);
    console.log(`📊 Analysis report: ./tools-analysis-report.json`);
    console.log('\n--- Data Analysis ---');
    console.log(`🔗 Unique URLs: ${urlGroups.size}`);
    console.log(`🔄 Duplicate URLs: ${duplicates.length}`);
    console.log(`📋 Total duplicate tools to remove: ${analysis.summary.totalDuplicateTools}`);
    console.log(`❓ Tools without URL: ${noUrlTools.length}`);
    console.log('='.repeat(60));
    
    if (duplicates.length > 0) {
        console.log('\n🔄 Top duplicate URLs:');
        duplicates
            .sort((a, b) => b.tools.length - a.tools.length)
            .slice(0, 10)
            .forEach(({ url, tools }) => {
                console.log(`  ${url}: ${tools.length} copies`);
            });
        
        if (duplicates.length > 10) {
            console.log(`  ... and ${duplicates.length - 10} more duplicate URLs`);
        }
    }
    
    if (noUrlTools.length > 0) {
        console.log(`\n❓ Sample tools without URLs:`);
        noUrlTools.slice(0, 5).forEach(tool => {
            console.log(`  - ${tool.name || 'Unknown'} (${tool._kvId})`);
        });
        if (noUrlTools.length > 5) {
            console.log(`  ... and ${noUrlTools.length - 5} more`);
        }
    }
}

// Run the download
downloadAllTools().catch(console.error);