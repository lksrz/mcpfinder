const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// List of HTTP/SSE servers to register
const URL_SERVERS = [
    { 
        url: 'https://mcp.deepwiki.com/sse',
        name: 'DeepWiki MCP Server',
        description: 'DeepWiki knowledge base integration MCP server',
        tags: ['knowledge', 'wiki']
    },
    { 
        url: 'https://get.ispoiler.com/api/mcp/sse',
        name: 'iSpoiler MCP Server',
        description: 'iSpoiler content management MCP server',
        tags: ['content', 'media']
    },
    { 
        url: 'https://whenmeet-mcp.onrender.com',
        name: 'WhenMeet MCP Server',
        description: 'WhenMeet scheduling and meeting coordination MCP server',
        tags: ['scheduling', 'productivity']
    },
    { 
        url: 'https://api.aiinfra.com/mcp',
        name: 'AI Infra MCP Server',
        description: 'AI Infrastructure management MCP server',
        tags: ['ai', 'infrastructure']
    },
    { 
        url: 'https://mcp.blockscan.com',
        name: 'Blockscan MCP Server',
        description: 'Blockchain explorer and analytics MCP server',
        tags: ['blockchain', 'crypto', 'analytics']
    },
    { 
        url: 'https://llmrecommend.com/v1/sse',
        name: 'LLM Recommend MCP Server',
        description: 'LLM recommendation engine MCP server',
        tags: ['ai', 'recommendations']
    },
    { 
        url: 'https://api.quickrecorder.com/mcp',
        name: 'QuickRecorder MCP Server',
        description: 'Screen recording and capture MCP server',
        tags: ['recording', 'media']
    },
    { 
        url: 'https://noterapp.ai/api/mcp',
        name: 'Noter AI MCP Server',
        description: 'AI-powered note taking MCP server',
        tags: ['notes', 'ai', 'productivity']
    },
    { 
        url: 'https://plandex.ai/api/mcp',
        name: 'Plandex MCP Server',
        description: 'AI planning and task management MCP server',
        tags: ['planning', 'productivity', 'ai']
    },
    { 
        url: 'https://api.val.town/mcp',
        name: 'Val Town MCP Server',
        description: 'Val Town serverless functions MCP server',
        tags: ['serverless', 'development']
    },
    { 
        url: 'https://mcp.dataviz.app',
        name: 'DataViz MCP Server',
        description: 'Data visualization MCP server',
        tags: ['data', 'visualization']
    },
    { 
        url: 'https://mcp.codechat.dev',
        name: 'CodeChat MCP Server',
        description: 'Code collaboration and chat MCP server',
        tags: ['development', 'collaboration']
    },
    { 
        url: 'https://api.taskade.com/mcp',
        name: 'Taskade MCP Server',
        description: 'Task management and collaboration MCP server',
        tags: ['productivity', 'collaboration']
    },
    { 
        url: 'https://mcp.mindmap.ai',
        name: 'MindMap AI MCP Server',
        description: 'AI-powered mind mapping MCP server',
        tags: ['visualization', 'ai', 'productivity']
    },
    { 
        url: 'https://api.mintlify.com/mcp',
        name: 'Mintlify MCP Server',
        description: 'Documentation generation MCP server',
        tags: ['documentation', 'development']
    }
];

// Additional NPM packages that haven't been registered yet
const ADDITIONAL_NPM_PACKAGES = [
    { name: '@felores/cloudinary-mcp-server', tags: ['cloud', 'media'], description: 'Cloudinary media management MCP server' },
    { name: 'influxdb-mcp-server', tags: ['data', 'monitoring'], description: 'InfluxDB time series database MCP server' },
    { name: '@delorenj/mcp-server-ticketmaster', tags: ['events', 'api'], description: 'Ticketmaster events API MCP server' },
    { name: '@fanyangmeng/ghost-mcp', tags: ['cms', 'blogging'], description: 'Ghost CMS integration MCP server' },
    { name: '@taazkareem/clickup-mcp-server', tags: ['productivity', 'project-management'], description: 'ClickUp project management MCP server' },
    { name: '@translated/lara-mcp', tags: ['translation', 'localization'], description: 'Lara translation service MCP server' },
    { name: '@vectorize-io/vectorize-mcp-server', tags: ['ai', 'vectors'], description: 'Vectorize.io vector database MCP server' },
    { name: '@enescinar/twitter-mcp', tags: ['social', 'api'], description: 'Twitter/X API integration MCP server' },
    { name: '@paddle/paddle-mcp', tags: ['payments', 'billing'], description: 'Paddle payments and billing MCP server' },
    { name: '@adenot/mcp-google-search', tags: ['search', 'google'], description: 'Google Search API MCP server' },
    { name: '@notainc/gyazo-mcp-server', tags: ['screenshot', 'media'], description: 'Gyazo screenshot service MCP server' },
    { name: '@gomomento/mcp-momento', tags: ['cache', 'data'], description: 'Momento serverless cache MCP server' },
    { name: '@gongrzhe/image-gen-server', tags: ['ai', 'image', 'generation'], description: 'AI image generation MCP server' },
    { name: '@gongrzhe/server-gmail-autoauth-mcp', tags: ['email', 'google'], description: 'Gmail with auto-auth MCP server' },
    { name: 'firecrawl-mcp', tags: ['web-scraping', 'data'], description: 'Firecrawl web scraping MCP server' },
    { name: 'datadog-mcp-server', tags: ['monitoring', 'observability'], description: 'Datadog monitoring MCP server' },
    { name: '@inoyu/mcp-unomi-server', tags: ['analytics', 'customer-data'], description: 'Apache Unomi customer data platform MCP server' },
    { name: '@felores/placid-mcp-server', tags: ['image', 'api'], description: 'Placid image generation API MCP server' },
    { name: 'shopify-mcp', tags: ['ecommerce', 'api'], description: 'Shopify e-commerce platform MCP server' },
    { name: '@jetbrains/mcp-proxy', tags: ['development', 'ide'], description: 'JetBrains IDE integration MCP server' },
    { name: '@riza-io/riza-mcp', tags: ['code', 'execution'], description: 'Riza code execution engine MCP server' },
    { name: 'tritlo/lsp-mcp', tags: ['development', 'lsp'], description: 'Language Server Protocol bridge MCP server' },
    { name: 'mcpr-cli', tags: ['routing', 'proxy'], description: 'MCP router and proxy CLI' },
    { name: 'mcp-server-rijksmuseum', tags: ['art', 'museum', 'api'], description: 'Rijksmuseum art collection API MCP server' },
    { name: 'mcp-server-tft', tags: ['gaming', 'api'], description: 'TeamFight Tactics game data MCP server' }
];

async function registerServer(config) {
    try {
        let registerCommand = `npx @mcpfinder/server@latest register "${config.url || config.name}" --headless`;
        registerCommand += ` --description "${config.description}"`;
        registerCommand += ` --tags "${config.tags.join(',')}"`;
        
        console.log(`Registering: ${config.name || config.url}`);
        
        const { stdout, stderr } = await execAsync(registerCommand, {
            env: { ...process.env },
            timeout: 30000 // 30 second timeout
        });
        
        return { success: true, name: config.name || config.url };
    } catch (error) {
        // Extract just the first line of error for cleaner output
        const errorMsg = error.message.split('\n')[0];
        return { success: false, name: config.name || config.url, error: errorMsg };
    }
}

async function main() {
    console.log('🚀 Starting URL and Additional NPM Server Registration\n');
    
    const allServers = [...URL_SERVERS, ...ADDITIONAL_NPM_PACKAGES];
    const results = {
        successful: 0,
        failed: 0,
        details: []
    };
    
    console.log(`📦 Processing ${allServers.length} servers...\n`);
    
    // Process servers in smaller batches to avoid overwhelming the system
    const batchSize = 5;
    for (let i = 0; i < allServers.length; i += batchSize) {
        const batch = allServers.slice(i, Math.min(i + batchSize, allServers.length));
        const batchNumber = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(allServers.length / batchSize);
        
        console.log(`\n🔄 Processing batch ${batchNumber}/${totalBatches}`);
        console.log('='.repeat(40));
        
        const batchPromises = batch.map(server => registerServer(server));
        const batchResults = await Promise.all(batchPromises);
        
        batchResults.forEach(result => {
            if (result.success) {
                console.log(`✅ ${result.name}`);
                results.successful++;
            } else {
                console.log(`❌ ${result.name}: ${result.error}`);
                results.failed++;
            }
            results.details.push(result);
        });
        
        // Rate limiting between batches
        if (i + batchSize < allServers.length) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    
    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 REGISTRATION SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total servers: ${allServers.length}`);
    console.log(`✅ Successfully registered: ${results.successful}`);
    console.log(`❌ Failed: ${results.failed}`);
    console.log('='.repeat(60));
    
    // Save results
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsPath = `url-registration-results-${timestamp}.json`;
    await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
    console.log(`\n📁 Results saved to: ${resultsPath}`);
}

// Run the script
main().catch(console.error);