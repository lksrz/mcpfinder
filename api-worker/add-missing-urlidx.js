const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
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

async function getAllUrlIdxKeys() {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    const command = `npx wrangler kv key list --namespace-id ${namespaceId} --prefix "urlidx:" --remote`;
    
    try {
        const { stdout } = await execAsync(command);
        return JSON.parse(stdout);
    } catch (error) {
        console.error('Error fetching urlidx keys:', error.message);
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
        console.error(`Error fetching ${key}:`, error.message);
        return null;
    }
}

async function putKVValue(key, value) {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    const command = `npx wrangler kv key put "${key}" "${value}" --namespace-id ${namespaceId} --remote`;
    
    try {
        await execAsync(command);
        return true;
    } catch (error) {
        console.error(`Error putting ${key}:`, error.message);
        return false;
    }
}

async function addMissingUrlIndexes() {
    console.log('🔍 Finding and adding missing URL indexes...\n');
    
    // Get current counts
    console.log('Fetching current KV state...');
    const toolKeys = await getAllToolKeys();
    const urlIdxKeys = await getAllUrlIdxKeys();
    
    console.log(`Current state:`);
    console.log(`  Tools: ${toolKeys.length}`);
    console.log(`  URL indexes: ${urlIdxKeys.length}`);
    console.log(`  Missing indexes: ${toolKeys.length - urlIdxKeys.length}\n`);
    
    // Create a set of existing URL indexes for quick lookup
    const existingUrls = new Set();
    urlIdxKeys.forEach(key => {
        const url = key.name.replace('urlidx:', '');
        existingUrls.add(url);
    });
    
    // Load the final unique tools data for quick access
    console.log('Loading tool data...');
    const toolsData = await fs.readFile('final-unique-tools.json', 'utf-8');
    const allTools = JSON.parse(toolsData);
    
    // Create a map for quick lookup
    const toolsMap = new Map();
    allTools.forEach(tool => {
        toolsMap.set(tool._kvId, tool);
    });
    
    // Find tools without URL indexes
    console.log('Analyzing tools for missing URL indexes...\n');
    const missingIndexes = [];
    let processed = 0;
    
    for (const toolKey of toolKeys) {
        processed++;
        if (processed % 50 === 0) {
            console.log(`Progress: ${processed}/${toolKeys.length} tools checked...`);
        }
        
        const toolId = toolKey.name.replace('tool:', '');
        const toolData = toolsMap.get(toolId);
        
        if (!toolData) {
            // If not in our local data, fetch from KV
            console.log(`Fetching data for ${toolId} from KV...`);
            const kvData = await getKVValue(toolKey.name);
            if (kvData && kvData.url && !existingUrls.has(kvData.url)) {
                missingIndexes.push({
                    toolId,
                    url: kvData.url,
                    name: kvData.name || 'Unknown'
                });
            }
        } else if (toolData.url && !existingUrls.has(toolData.url)) {
            missingIndexes.push({
                toolId,
                url: toolData.url,
                name: toolData.name
            });
        }
    }
    
    console.log(`\n📊 Analysis complete:`);
    console.log(`  Tools without URL index: ${missingIndexes.length}`);
    
    if (missingIndexes.length === 0) {
        console.log('\n✅ All tools have URL indexes! Nothing to do.');
        return;
    }
    
    // Show what we'll create
    console.log('\n📝 URL indexes to create:');
    missingIndexes.forEach((item, idx) => {
        if (idx < 10) {
            console.log(`  ${item.url} -> ${item.toolId} (${item.name})`);
        }
    });
    if (missingIndexes.length > 10) {
        console.log(`  ... and ${missingIndexes.length - 10} more\n`);
    }
    
    // Create the missing indexes
    console.log('\n🔧 Creating missing URL indexes...\n');
    
    let created = 0;
    let failed = 0;
    
    for (const item of missingIndexes) {
        const urlidxKey = `urlidx:${item.url}`;
        process.stdout.write(`Creating index for ${item.name}... `);
        
        const success = await putKVValue(urlidxKey, item.toolId);
        
        if (success) {
            created++;
            console.log('✅');
        } else {
            failed++;
            console.log('❌');
        }
        
        // Rate limiting
        if ((created + failed) % 5 === 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    // Final summary
    console.log('\n' + '='.repeat(60));
    console.log('🎉 URL INDEX CREATION COMPLETE!');
    console.log('='.repeat(60));
    console.log(`✅ Successfully created: ${created} indexes`);
    console.log(`❌ Failed to create: ${failed} indexes`);
    console.log(`📊 Final expected counts:`);
    console.log(`   Tools: ${toolKeys.length}`);
    console.log(`   URL indexes: ${urlIdxKeys.length + created}`);
    console.log('='.repeat(60));
    
    // Save the results
    const results = {
        timestamp: new Date().toISOString(),
        analysis: {
            toolsCount: toolKeys.length,
            existingIndexes: urlIdxKeys.length,
            missingIndexes: missingIndexes.length,
            created: created,
            failed: failed
        },
        missingIndexes: missingIndexes
    };
    
    await fs.writeFile('urlidx-creation-results.json', JSON.stringify(results, null, 2));
    console.log('\n📁 Results saved to urlidx-creation-results.json');
}

// Run the script
addMissingUrlIndexes().catch(console.error);