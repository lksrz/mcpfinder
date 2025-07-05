const fs = require('fs').promises;
const path = require('path');

async function analyzeServers() {
    console.log('📊 Analyzing MCP Servers in urls_mcp_servers_results.json\n');
    
    try {
        const jsonPath = path.join(__dirname, '../cli/urls_mcp_servers_results.json');
        const data = await fs.readFile(jsonPath, 'utf-8');
        const servers = JSON.parse(data);
        
        const analysis = {
            total: Object.keys(servers).length,
            withUrl: [],
            withNpx: [],
            withUvx: [],
            alreadyProcessed: [],
            other: []
        };
        
        // Analyze each server
        for (const [name, data] of Object.entries(servers)) {
            if (typeof data !== 'object' || !data) {
                analysis.other.push(name);
                continue;
            }
            
            // Check if already processed
            if (data.processed && data.processed > 0) {
                analysis.alreadyProcessed.push({
                    name,
                    processedCount: data.processed,
                    hasIntrospection: !!data.introspectionResults
                });
            }
            
            // Categorize by type
            if (data.url) {
                analysis.withUrl.push({
                    name,
                    url: data.url,
                    processed: data.processed || 0
                });
            } else if (data.command === 'npx' && data.args && data.args.length > 0) {
                analysis.withNpx.push({
                    name,
                    package: data.args[0],
                    processed: data.processed || 0
                });
            } else if (data.command === 'uvx' && data.args && data.args.length > 0) {
                analysis.withUvx.push({
                    name,
                    package: data.args[0],
                    processed: data.processed || 0
                });
            } else {
                analysis.other.push(name);
            }
        }
        
        // Print analysis
        console.log('='.repeat(60));
        console.log('ANALYSIS RESULTS');
        console.log('='.repeat(60));
        console.log(`\nTotal servers in file: ${analysis.total}`);
        console.log(`\n📦 NPX Servers: ${analysis.withNpx.length}`);
        if (analysis.withNpx.length > 0) {
            console.log('  First 10:');
            analysis.withNpx.slice(0, 10).forEach(s => {
                console.log(`    - ${s.name}: ${s.package} ${s.processed > 0 ? '(already processed)' : ''}`);
            });
            if (analysis.withNpx.length > 10) {
                console.log(`    ... and ${analysis.withNpx.length - 10} more`);
            }
        }
        
        console.log(`\n🐍 UVX Servers: ${analysis.withUvx.length}`);
        if (analysis.withUvx.length > 0) {
            console.log('  All:');
            analysis.withUvx.forEach(s => {
                console.log(`    - ${s.name}: ${s.package} ${s.processed > 0 ? '(already processed)' : ''}`);
            });
        }
        
        console.log(`\n🌐 URL Servers: ${analysis.withUrl.length}`);
        if (analysis.withUrl.length > 0) {
            console.log('  First 10:');
            analysis.withUrl.slice(0, 10).forEach(s => {
                console.log(`    - ${s.name}: ${s.url} ${s.processed > 0 ? '(already processed)' : ''}`);
            });
            if (analysis.withUrl.length > 10) {
                console.log(`    ... and ${analysis.withUrl.length - 10} more`);
            }
        }
        
        console.log(`\n✅ Already Processed: ${analysis.alreadyProcessed.length}`);
        console.log(`❓ Other/Unknown: ${analysis.other.length}`);
        
        // Calculate what would be registered
        const toRegister = [
            ...analysis.withNpx.filter(s => s.processed === 0),
            ...analysis.withUvx.filter(s => s.processed === 0),
            ...analysis.withUrl.filter(s => s.processed === 0)
        ];
        
        console.log('\n' + '='.repeat(60));
        console.log('REGISTRATION PLAN');
        console.log('='.repeat(60));
        console.log(`\nServers to register: ${toRegister.length}`);
        console.log(`  - NPX: ${analysis.withNpx.filter(s => s.processed === 0).length}`);
        console.log(`  - UVX: ${analysis.withUvx.filter(s => s.processed === 0).length}`);
        console.log(`  - URL: ${analysis.withUrl.filter(s => s.processed === 0).length}`);
        
        // Save detailed analysis
        const analysisPath = path.join(__dirname, 'urls-json-analysis.json');
        await fs.writeFile(analysisPath, JSON.stringify(analysis, null, 2));
        console.log(`\n📁 Detailed analysis saved to: ${analysisPath}`);
        
    } catch (error) {
        console.error('Error:', error);
    }
}

// Run analysis
analyzeServers().catch(console.error);