const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function getKVValue(key) {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    const command = `npx wrangler kv key get "${key}" --namespace-id ${namespaceId}`;
    
    try {
        const { stdout } = await execAsync(command);
        return stdout.trim();
    } catch (error) {
        console.error(`Error fetching value for key ${key}:`, error.message);
        return null;
    }
}

async function deleteKVKey(key) {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    const command = `npx wrangler kv key delete "${key}" --namespace-id ${namespaceId}`;
    
    try {
        await execAsync(command);
        return true;
    } catch (error) {
        console.error(`Error deleting key ${key}:`, error.message);
        return false;
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

async function safeDuplicateCleanup() {
    console.log('🧹 Safe duplicate cleanup process...\n');
    
    // Duplicates identified from analysis
    const duplicates = [
        {
            url: '@aashari/mcp-server-atlassian-confluence',
            keepId: '203d47ff-7e7f-4ecc-97fd-788e42856ffb',
            deleteId: '0801000b-7810-4eef-8f96-97659cd8e6ef'
        },
        {
            url: '@modelcontextprotocol/server-github',
            keepId: '33f915ac-3791-4bef-a48a-f96f58bce3e2',
            deleteId: '173b7d0a-8998-4973-8b2e-d27fd1466ace'
        },
        {
            url: 'mcp-local-file-reader',
            keepId: '37c2b866-a2aa-4a50-9c07-10e54b6f43b4',
            deleteId: '1bc65e09-3200-4879-b334-6fbe1cdf203f'
        }
    ];
    
    for (const dup of duplicates) {
        console.log(`\nProcessing: ${dup.url}`);
        console.log(`  Keep: ${dup.keepId}`);
        console.log(`  Delete: ${dup.deleteId}`);
        
        // Check current urlidx
        const urlidxKey = `urlidx:${dup.url}`;
        const currentId = await getKVValue(urlidxKey);
        
        console.log(`  Current urlidx points to: ${currentId}`);
        
        // Update urlidx if needed
        if (currentId !== dup.keepId) {
            console.log(`  ⚠️  Updating urlidx to point to keeper: ${dup.keepId}`);
            const updated = await updateKVValue(urlidxKey, dup.keepId);
            if (updated) {
                console.log('  ✅ urlidx updated');
            } else {
                console.log('  ❌ Failed to update urlidx');
                continue; // Don't delete if we can't update the index
            }
        } else {
            console.log('  ✅ urlidx already points to keeper');
        }
        
        // Delete the duplicate tool
        const toolKey = `tool:${dup.deleteId}`;
        console.log(`  Deleting duplicate tool: ${toolKey}`);
        
        const deleted = await deleteKVKey(toolKey);
        if (deleted) {
            console.log('  ✅ Duplicate tool deleted');
        } else {
            console.log('  ❌ Failed to delete duplicate tool');
        }
    }
    
    console.log('\n✅ Cleanup process complete!');
}

// Run the cleanup
safeDuplicateCleanup().catch(console.error);