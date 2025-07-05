const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function countKeysWithPagination(prefix) {
    const namespaceId = '59bfeb2ef6ab471a9a3461f113704891';
    let allKeys = [];
    let cursor = undefined;
    let hasMore = true;
    
    console.log(`\nCounting ${prefix} keys with pagination...`);
    
    while (hasMore) {
        try {
            // Build command - wrangler doesn't support cursor in CLI
            // So we get all at once (up to 1000 limit)
            const command = `npx wrangler kv key list --namespace-id ${namespaceId} --prefix "${prefix}" --remote`;
            
            const { stdout } = await execAsync(command);
            const keys = JSON.parse(stdout);
            
            if (Array.isArray(keys)) {
                console.log(`  Fetched ${keys.length} keys`);
                allKeys = keys;
                hasMore = false; // Can't paginate with CLI
                
                // If we got exactly 1000, there might be more
                if (keys.length === 1000) {
                    console.log(`  ⚠️  Hit 1000 key limit - there may be more keys`);
                }
            } else {
                hasMore = false;
            }
            
        } catch (error) {
            console.error(`  Error fetching ${prefix}:`, error.message);
            hasMore = false;
        }
    }
    
    return allKeys;
}

async function checkAllCounts() {
    console.log('🔍 Checking KV counts with remote flag...\n');
    console.log('Namespace ID: 59bfeb2ef6ab471a9a3461f113704891');
    console.log('=' .repeat(60));
    
    const prefixes = ['tool:', 'urlidx:', 'event:', 'recent:'];
    const results = {};
    
    for (const prefix of prefixes) {
        const keys = await countKeysWithPagination(prefix);
        results[prefix] = keys.length;
        
        // For urlidx, let's also check a few specific ones we created
        if (prefix === 'urlidx:' && keys.length > 0) {
            console.log('\n  Checking some specific URL indexes we created:');
            const checkUrls = [
                'grok2-image-mcp-server',
                '@aashari/mcp-server-atlassian-confluence',
                'test-calculator',
                'json2video-mcp',
                '@f4ww4z/mcp-mysql-server'
            ];
            
            for (const url of checkUrls) {
                const found = keys.some(k => k.name === `urlidx:${url}`);
                console.log(`    urlidx:${url} - ${found ? '✅ Found' : '❌ Not found'}`);
            }
        }
    }
    
    // Also get total count
    console.log('\nGetting total key count (all prefixes)...');
    const allKeys = await countKeysWithPagination('');
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 FINAL KV COUNTS (via --remote):');
    console.log('='.repeat(60));
    
    Object.entries(results).forEach(([prefix, count]) => {
        console.log(`${prefix.padEnd(10)} ${count} records`);
    });
    
    console.log(`\nTOTAL:     ${allKeys.length} records`);
    console.log('='.repeat(60));
    
    // Check for consistency
    const expectedUrlidx = results['tool:'];
    if (results['urlidx:'] !== expectedUrlidx) {
        console.log(`\n⚠️  Warning: URL index count (${results['urlidx:']}) doesn't match tool count (${results['tool:']})`);
        console.log(`   Missing indexes: ${expectedUrlidx - results['urlidx:']}`);
    } else {
        console.log('\n✅ URL index count matches tool count!');
    }
}

// Run the check
checkAllCounts().catch(console.error);