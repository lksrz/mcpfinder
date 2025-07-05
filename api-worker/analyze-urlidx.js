const fetch = require('node-fetch');

async function analyzeUrlIndex() {
    console.log('🔍 Analyzing URL index consistency via API...\n');
    
    try {
        // Fetch all tools via search API with high limit
        const response = await fetch('https://mcpfinder.dev/api/v1/search?limit=100');
        let tools = await response.json();
        
        console.log(`Fetched first batch: ${tools.length} tools`);
        
        // Keep fetching if we got 100 (the limit)
        let allTools = [...tools];
        let offset = 100;
        
        while (tools.length === 100) {
            // Note: The API might not support offset, so this is just first 100
            // In production, you'd need pagination support
            break;
        }
        
        console.log(`\nTotal tools fetched via API: ${allTools.length}`);
        
        // Group by URL to find duplicates
        const urlMap = new Map();
        const noUrlTools = [];
        
        for (const tool of allTools) {
            if (!tool.url) {
                noUrlTools.push(tool);
            } else {
                if (!urlMap.has(tool.url)) {
                    urlMap.set(tool.url, []);
                }
                urlMap.get(tool.url).push(tool);
            }
        }
        
        // Find duplicate URLs
        const duplicateUrls = [];
        for (const [url, tools] of urlMap.entries()) {
            if (tools.length > 1) {
                duplicateUrls.push({ url, tools });
            }
        }
        
        console.log('\n📊 Analysis Results:');
        console.log(`   Total tools: ${allTools.length}`);
        console.log(`   Tools without URL: ${noUrlTools.length}`);
        console.log(`   Unique URLs: ${urlMap.size}`);
        console.log(`   Duplicate URLs: ${duplicateUrls.length}`);
        
        if (noUrlTools.length > 0) {
            console.log('\n⚠️  Tools without URLs:');
            noUrlTools.slice(0, 5).forEach(tool => {
                console.log(`   - ${tool.name} (ID: ${tool.id})`);
            });
            if (noUrlTools.length > 5) {
                console.log(`   ... and ${noUrlTools.length - 5} more`);
            }
        }
        
        if (duplicateUrls.length > 0) {
            console.log('\n⚠️  Duplicate URLs found:');
            duplicateUrls.slice(0, 5).forEach(({ url, tools }) => {
                console.log(`   URL: ${url}`);
                tools.forEach(tool => {
                    console.log(`     - ${tool.name} (ID: ${tool.id})`);
                });
            });
            if (duplicateUrls.length > 5) {
                console.log(`   ... and ${duplicateUrls.length - 5} more duplicate URLs`);
            }
        }
        
        // Now let's check a few individual tools to understand the structure
        console.log('\n🔍 Checking individual tool details...');
        
        for (const tool of allTools.slice(0, 3)) {
            const detailResponse = await fetch(`https://mcpfinder.dev/api/v1/tools/${tool.id}`);
            const details = await detailResponse.json();
            
            console.log(`\nTool: ${details.name}`);
            console.log(`  ID: ${tool.id}`);
            console.log(`  URL: ${details.url || 'NO URL'}`);
            console.log(`  Tags: ${(details.tags || []).join(', ')}`);
            
            if (details._unverified) {
                console.log(`  ⚠️  Unverified registration`);
            }
        }
        
    } catch (error) {
        console.error('Error analyzing tools:', error);
    }
}

analyzeUrlIndex().catch(console.error);