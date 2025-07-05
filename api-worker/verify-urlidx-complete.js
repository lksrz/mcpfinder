const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const execAsync = promisify(exec);

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

async function verifyUrlIndexes() {
    console.log('🔍 Verifying URL indexes for all tools...\n');
    
    // Load the final tools data
    const toolsData = await fs.readFile('final-unique-tools.json', 'utf-8');
    const allTools = JSON.parse(toolsData);
    
    console.log(`Total unique tools: ${allTools.length}`);
    console.log('Checking each tool has a corresponding urlidx...\n');
    
    let checked = 0;
    let hasIndex = 0;
    let missingIndex = 0;
    const missing = [];
    
    for (const tool of allTools) {
        checked++;
        
        if (checked % 50 === 0) {
            console.log(`Progress: ${checked}/${allTools.length} tools checked...`);
        }
        
        if (!tool.url) {
            console.log(`⚠️  Tool ${tool.name} (${tool._kvId}) has no URL`);
            continue;
        }
        
        const urlidxKey = `urlidx:${tool.url}`;
        const indexValue = await getKVValue(urlidxKey);
        
        if (indexValue && indexValue !== 'Value not found') {
            hasIndex++;
            
            // Verify it points to the correct tool
            if (indexValue !== tool._kvId) {
                console.log(`⚠️  Index mismatch for ${tool.url}:`);
                console.log(`    Expected: ${tool._kvId}`);
                console.log(`    Found: ${indexValue}`);
            }
        } else {
            missingIndex++;
            missing.push({
                toolId: tool._kvId,
                name: tool.name,
                url: tool.url
            });
        }
        
        // Rate limiting
        if (checked % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 VERIFICATION COMPLETE');
    console.log('='.repeat(60));
    console.log(`Total tools checked: ${checked}`);
    console.log(`✅ Tools with URL index: ${hasIndex}`);
    console.log(`❌ Tools missing URL index: ${missingIndex}`);
    console.log('='.repeat(60));
    
    if (missing.length > 0) {
        console.log('\nTools still missing URL indexes:');
        missing.forEach(item => {
            console.log(`  - ${item.name} (${item.toolId})`);
            console.log(`    URL: ${item.url}`);
        });
        
        // Save missing ones
        await fs.writeFile('still-missing-urlidx.json', JSON.stringify(missing, null, 2));
        console.log('\n📁 Missing indexes saved to still-missing-urlidx.json');
    } else {
        console.log('\n✅ All tools have URL indexes!');
    }
}

// Run verification
verifyUrlIndexes().catch(console.error);