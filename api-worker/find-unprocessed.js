const fs = require('fs').promises;
const path = require('path');

async function main() {
    const jsonPath = path.join(__dirname, '../cli/urls_mcp_servers_results.json');
    const data = await fs.readFile(jsonPath, 'utf-8');
    const servers = JSON.parse(data);
    
    const unprocessed = {
        npx: [],
        uvx: [],
        url: [],
        other: []
    };
    
    Object.entries(servers).forEach(([name, data]) => {
        if (typeof data !== 'object' || !data) return;
        
        // Check if processed
        const isProcessed = data.processed && data.processed > 0;
        if (isProcessed) return;
        
        // Categorize
        if (data.url) {
            unprocessed.url.push({ name, url: data.url });
        } else if (data.command === 'npx' && data.args) {
            unprocessed.npx.push({ name, args: data.args });
        } else if (data.command === 'uvx' && data.args) {
            unprocessed.uvx.push({ name, args: data.args });
        } else {
            unprocessed.other.push({ name, command: data.command });
        }
    });
    
    console.log('📊 Unprocessed Servers Summary:');
    console.log(`   NPX: ${unprocessed.npx.length}`);
    console.log(`   UVX: ${unprocessed.uvx.length}`);
    console.log(`   URL: ${unprocessed.url.length}`);
    console.log(`   Other: ${unprocessed.other.length}`);
    console.log('\n');
    
    if (unprocessed.npx.length > 0) {
        console.log('NPX Servers (first 10):');
        unprocessed.npx.slice(0, 10).forEach(s => {
            console.log(`   - ${s.name}: ${s.args.join(' ')}`);
        });
        if (unprocessed.npx.length > 10) {
            console.log(`   ... and ${unprocessed.npx.length - 10} more`);
        }
    }
    
    if (unprocessed.uvx.length > 0) {
        console.log('\nUVX Servers (first 10):');
        unprocessed.uvx.slice(0, 10).forEach(s => {
            console.log(`   - ${s.name}: ${s.args.join(' ')}`);
        });
        if (unprocessed.uvx.length > 10) {
            console.log(`   ... and ${unprocessed.uvx.length - 10} more`);
        }
    }
    
    if (unprocessed.url.length > 0) {
        console.log('\nURL Servers:');
        unprocessed.url.forEach(s => {
            console.log(`   - ${s.name}: ${s.url}`);
        });
    }
    
    // Save the results
    await fs.writeFile('unprocessed-servers.json', JSON.stringify(unprocessed, null, 2));
    console.log('\n📁 Full list saved to unprocessed-servers.json');
}

main().catch(console.error);