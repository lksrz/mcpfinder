const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function countByPrefix() {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    const prefixes = ['tool:', 'event:', 'recent:', 'urlidx:'];
    
    console.log('Counting records by prefix in production KV namespace...\n');
    
    for (const prefix of prefixes) {
        let cursor = null;
        let totalCount = 0;
        let hasMore = true;
        
        while (hasMore) {
            try {
                // Build command with cursor if available
                let command = `npx wrangler kv key list --namespace-id ${namespaceId} --prefix "${prefix}" --remote`;
                
                const { stdout } = await execAsync(command);
                const keys = JSON.parse(stdout);
                
                // Handle the response - it's just an array of key objects
                if (Array.isArray(keys)) {
                    totalCount += keys.length;
                    
                    // Check if we got exactly 1000 results (the default limit)
                    // If so, there might be more
                    if (keys.length === 1000) {
                        // Try to get more by using the last key as cursor
                        // But wrangler doesn't support cursor, so we can't paginate
                        hasMore = false;
                        console.log(`  ⚠️  Reached limit of 1000 for prefix "${prefix}", there may be more`);
                    } else {
                        hasMore = false;
                    }
                } else {
                    hasMore = false;
                }
                
            } catch (error) {
                console.error(`Error fetching ${prefix}:`, error.message);
                hasMore = false;
            }
        }
        
        console.log(`${prefix.padEnd(10)} ${totalCount} records`);
    }
    
    console.log('\nNote: wrangler kv list has a limit of 1000 keys per request');
    console.log('Use the Cloudflare dashboard for exact counts over 1000');
}

countByPrefix().catch(console.error);