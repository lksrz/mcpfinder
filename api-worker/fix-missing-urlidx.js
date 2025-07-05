const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function getAllKeys(prefix) {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    const command = `npx wrangler kv key list --namespace-id ${namespaceId} --prefix "${prefix}" --remote`;
    
    try {
        const { stdout } = await execAsync(command);
        return JSON.parse(stdout);
    } catch (error) {
        console.error(`Error fetching keys with prefix ${prefix}:`, error.message);
        return [];
    }
}

async function getKVValue(key) {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    const command = `npx wrangler kv get "${key}" --namespace-id ${namespaceId}`;
    
    try {
        const { stdout } = await execAsync(command);
        return JSON.parse(stdout);
    } catch (error) {
        console.error(`Error fetching value for key ${key}:`, error.message);
        return null;
    }
}

async function putKVValue(key, value) {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    const command = `npx wrangler kv put "${key}" "${value}" --namespace-id ${namespaceId}`;
    
    try {
        await execAsync(command);
        return true;
    } catch (error) {
        console.error(`Error putting value for key ${key}:`, error.message);
        return false;
    }
}

async function fixMissingUrlIndex() {
    console.log('🔍 Analyzing URL index consistency...\n');
    
    // Get all tool keys
    console.log('Fetching all tool records...');
    const toolKeys = await getAllKeys('tool:');
    console.log(`Found ${toolKeys.length} tool records\n`);
    
    // Get all urlidx keys
    console.log('Fetching all URL index records...');
    const urlIdxKeys = await getAllKeys('urlidx:');
    console.log(`Found ${urlIdxKeys.length} URL index records\n`);
    
    // Create a map of existing URL indexes
    const existingUrlIndexes = new Map();
    for (const key of urlIdxKeys) {
        const url = key.name.replace('urlidx:', '');
        existingUrlIndexes.set(url, true);
    }
    
    // Find tools without URL index
    console.log('Checking each tool for missing URL index...\n');
    const missingIndexes = [];
    let processed = 0;
    
    for (const toolKey of toolKeys) {
        processed++;
        if (processed % 50 === 0) {
            console.log(`Progress: ${processed}/${toolKeys.length} tools checked...`);
        }
        
        // Get the tool data
        const toolData = await getKVValue(toolKey.name);
        if (!toolData || !toolData.url) {
            console.log(`⚠️  Tool ${toolKey.name} has no URL, skipping`);
            continue;
        }
        
        // Check if URL index exists
        if (!existingUrlIndexes.has(toolData.url)) {
            const toolId = toolKey.name.replace('tool:', '');
            missingIndexes.push({
                toolId,
                toolName: toolData.name,
                url: toolData.url
            });
        }
        
        // Small delay to avoid rate limiting
        if (processed % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    console.log(`\n📊 Analysis complete:`);
    console.log(`   Total tools: ${toolKeys.length}`);
    console.log(`   Existing URL indexes: ${urlIdxKeys.length}`);
    console.log(`   Missing URL indexes: ${missingIndexes.length}\n`);
    
    if (missingIndexes.length === 0) {
        console.log('✅ All tools have corresponding URL indexes!');
        return;
    }
    
    // Show missing indexes
    console.log('Missing URL indexes:');
    missingIndexes.slice(0, 10).forEach(({ toolId, toolName, url }) => {
        console.log(`   - ${toolName} (${toolId})`);
        console.log(`     URL: ${url}`);
    });
    if (missingIndexes.length > 10) {
        console.log(`   ... and ${missingIndexes.length - 10} more\n`);
    }
    
    // Ask for confirmation
    console.log('\n🔧 Ready to create missing URL indexes.');
    console.log('This will create ' + missingIndexes.length + ' new urlidx: entries.');
    console.log('\nCreating missing indexes...\n');
    
    // Create missing indexes
    let created = 0;
    let failed = 0;
    
    for (const { toolId, toolName, url } of missingIndexes) {
        const urlIdxKey = `urlidx:${url}`;
        const success = await putKVValue(urlIdxKey, toolId);
        
        if (success) {
            created++;
            console.log(`✅ Created index for: ${toolName}`);
        } else {
            failed++;
            console.log(`❌ Failed to create index for: ${toolName}`);
        }
        
        // Rate limiting
        if ((created + failed) % 5 === 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('🎉 URL Index Fix Complete!');
    console.log('='.repeat(50));
    console.log(`✅ Created: ${created} indexes`);
    console.log(`❌ Failed: ${failed} indexes`);
    console.log('='.repeat(50));
}

// Run the fix
fixMissingUrlIndex().catch(console.error);