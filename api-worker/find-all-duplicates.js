const { exec } = require('child_process');
const { promisify } = require('util');
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
    const command = `npx wrangler kv key get "${key}" --namespace-id ${namespaceId}`;
    
    try {
        const { stdout } = await execAsync(command);
        return JSON.parse(stdout);
    } catch (error) {
        return null;
    }
}

async function findAllDuplicates() {
    console.log('🔍 Finding ALL duplicate MCP server registrations...\n');
    
    // Get all tool keys
    console.log('Fetching all tool keys from KV...');
    const toolKeys = await getAllToolKeys();
    console.log(`Found ${toolKeys.length} total tools\n`);
    
    // Group by URL
    const urlGroups = new Map();
    const noUrlTools = [];
    let processed = 0;
    
    console.log('Fetching tool details and grouping by URL...');
    
    for (const key of toolKeys) {
        processed++;
        if (processed % 50 === 0) {
            console.log(`Progress: ${processed}/${toolKeys.length} tools processed...`);
        }
        
        const toolData = await getKVValue(key.name);
        if (!toolData) continue;
        
        if (!toolData.url) {
            noUrlTools.push({
                id: key.name.replace('tool:', ''),
                name: toolData.name || 'Unknown'
            });
            continue;
        }
        
        if (!urlGroups.has(toolData.url)) {
            urlGroups.set(toolData.url, []);
        }
        
        urlGroups.get(toolData.url).push({
            id: key.name.replace('tool:', ''),
            name: toolData.name,
            data: toolData
        });
        
        // Rate limiting
        if (processed % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    // Find duplicates
    const duplicates = [];
    for (const [url, tools] of urlGroups.entries()) {
        if (tools.length > 1) {
            duplicates.push({ url, tools });
        }
    }
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 DUPLICATE ANALYSIS SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total tools analyzed: ${toolKeys.length}`);
    console.log(`Tools without URL: ${noUrlTools.length}`);
    console.log(`Unique URLs: ${urlGroups.size}`);
    console.log(`URLs with duplicates: ${duplicates.length}`);
    console.log(`Total duplicate tools to remove: ${duplicates.reduce((sum, d) => sum + d.tools.length - 1, 0)}`);
    console.log('='.repeat(60));
    
    if (duplicates.length > 0) {
        console.log('\nDuplicate URLs found:');
        duplicates.forEach(({ url, tools }) => {
            console.log(`\n${url} (${tools.length} copies):`);
            tools.forEach(tool => {
                const verified = !tool.data._unverified;
                const caps = tool.data.capabilities?.length || 0;
                console.log(`  - ${tool.name} (${tool.id}) - Verified: ${verified}, Capabilities: ${caps}`);
            });
        });
    }
    
    if (noUrlTools.length > 0) {
        console.log(`\n\nTools without URLs: ${noUrlTools.length}`);
        console.log('(These cannot have duplicates as they have no URL to compare)');
        noUrlTools.slice(0, 5).forEach(tool => {
            console.log(`  - ${tool.name} (${tool.id})`);
        });
        if (noUrlTools.length > 5) {
            console.log(`  ... and ${noUrlTools.length - 5} more`);
        }
    }
    
    // Save results
    const fs = require('fs').promises;
    const results = {
        timestamp: new Date().toISOString(),
        summary: {
            totalTools: toolKeys.length,
            toolsWithoutUrl: noUrlTools.length,
            uniqueUrls: urlGroups.size,
            duplicateUrls: duplicates.length,
            duplicateToolsToRemove: duplicates.reduce((sum, d) => sum + d.tools.length - 1, 0)
        },
        duplicates,
        noUrlTools
    };
    
    await fs.writeFile('all-duplicates-analysis.json', JSON.stringify(results, null, 2));
    console.log('\n📁 Full analysis saved to all-duplicates-analysis.json');
}

// Run the analysis
findAllDuplicates().catch(console.error);