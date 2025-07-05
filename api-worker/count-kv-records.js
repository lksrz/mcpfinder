const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function countKVRecords() {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    let cursor = null;
    let totalCount = 0;
    let hasMore = true;
    
    console.log('Counting records in production KV namespace...');
    
    while (hasMore) {
        try {
            const cursorParam = cursor ? `--cursor ${cursor}` : '';
            const command = `npx wrangler kv key list --namespace-id ${namespaceId} --prefix "tool:" ${cursorParam}`;
            
            const { stdout } = await execAsync(command);
            const result = JSON.parse(stdout);
            
            if (Array.isArray(result)) {
                // Simple array response
                totalCount += result.length;
                hasMore = false;
            } else if (result.result && Array.isArray(result.result)) {
                // Paginated response
                totalCount += result.result.length;
                cursor = result.result_info?.cursor;
                hasMore = !!cursor && result.result.length > 0;
            } else if (result.keys && Array.isArray(result.keys)) {
                // Alternative format
                totalCount += result.keys.length;
                cursor = result.cursor;
                hasMore = !!cursor && result.keys.length > 0;
            } else {
                console.error('Unexpected response format:', result);
                hasMore = false;
            }
            
            console.log(`Fetched batch: ${result.result?.length || result.keys?.length || result.length || 0} records, Total so far: ${totalCount}`);
            
        } catch (error) {
            console.error('Error fetching records:', error.message);
            hasMore = false;
        }
    }
    
    console.log(`\nTotal tool records in production: ${totalCount}`);
    
    // Also count other prefixes
    const prefixes = ['urlidx:', 'event:', 'recent:'];
    
    for (const prefix of prefixes) {
        try {
            const { stdout } = await execAsync(`npx wrangler kv key list --namespace-id ${namespaceId} --prefix "${prefix}"`);
            const result = JSON.parse(stdout);
            const count = Array.isArray(result) ? result.length : (result.result?.length || result.keys?.length || 0);
            console.log(`Records with prefix "${prefix}": ${count}`);
        } catch (error) {
            console.error(`Error counting ${prefix}:`, error.message);
        }
    }
}

countKVRecords().catch(console.error);