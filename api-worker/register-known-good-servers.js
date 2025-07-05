const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fetch = require('node-fetch');

// List of servers that are known to work
const KNOWN_GOOD_SERVERS = [
    { name: 'hyperbrowser-mcp', tags: ['automation'], description: 'Browser automation MCP server' },
    { name: 'edgeone-pages-mcp', tags: ['cloud'], description: 'EdgeOne Pages MCP server' },
    { name: '@datastax/astra-db-mcp', tags: ['data'], description: 'DataStax Astra DB MCP server', requiresApiKey: true, keyName: 'ASTRA_DB_APPLICATION_TOKEN' },
    { name: 'iterm-mcp', tags: ['terminal'], description: 'iTerm2 integration MCP server' },
    { name: '@apify/mcp-server-rag-web-browser', tags: ['automation', 'search'], description: 'RAG web browser MCP server', requiresApiKey: true, keyName: 'APIFY_TOKEN' },
    { name: 'mcp-server-siri-shortcuts', tags: ['automation', 'macos'], description: 'Siri Shortcuts MCP server' },
    { name: '@bharathvaj/whois-mcp', tags: ['utility'], description: 'WHOIS lookup MCP server' },
    { name: '@mektigboy/server-hyperliquid', tags: ['trading', 'crypto'], description: 'Hyperliquid trading MCP server' },
    { name: '@neondatabase/mcp-server-neon', tags: ['data', 'database'], description: 'Neon database MCP server', requiresApiKey: true, keyName: 'NEON_API_KEY' },
    { name: 'shopify-mcp', tags: ['ecommerce'], description: 'Shopify store management MCP server', requiresApiKey: true, keyName: 'SHOPIFY_ACCESS_TOKEN' },
    { name: '@gongrzhe/image-gen-server', tags: ['ai', 'image'], description: 'Image generation MCP server' },
    { name: 'datadog-mcp-server', tags: ['monitoring'], description: 'Datadog monitoring MCP server', requiresApiKey: true, keyName: 'DD_API_KEY' },
    { name: '@peakmojo/applescript-mcp', tags: ['macos', 'automation'], description: 'AppleScript execution MCP server' },
    { name: '@inoyu/mcp-unomi-server', tags: ['analytics'], description: 'Apache Unomi MCP server' },
    { name: '@felores/placid-mcp-server', tags: ['image', 'api'], description: 'Placid image generation MCP server', requiresApiKey: true, keyName: 'PLACID_API_TOKEN' },
    { name: 'mcp-remote', tags: ['proxy', 'utility'], description: 'MCP remote proxy server' },
    { name: '@shinzolabs/coinmarketcap-mcp', tags: ['crypto', 'data'], description: 'CoinMarketCap data MCP server', requiresApiKey: true, keyName: 'CMC_API_KEY' },
    { name: 'mcp-server-tft', tags: ['gaming'], description: 'TeamFight Tactics MCP server' },
    { name: '@anaisbetts/mcp-installer', tags: ['utility'], description: 'MCP installer helper' },
    { name: '@tritlo/lsp-mcp', tags: ['development'], description: 'Language Server Protocol MCP bridge' },
    { name: '@riza-io/riza-mcp', tags: ['code', 'execution'], description: 'Riza code execution MCP server' },
    { name: '@alanse/mcp-neo4j-server', tags: ['data', 'graph'], description: 'Neo4j graph database MCP server', requiresApiKey: true, keyName: 'NEO4J_URI' },
    { name: 'kubernetes-mcp-server', tags: ['cloud', 'kubernetes'], description: 'Kubernetes management MCP server' },
    { name: '@pyroprompts/any-chat-completions-mcp', tags: ['ai', 'chat'], description: 'Universal chat completions MCP server' },
    { name: '@bankless/onchain-mcp', tags: ['crypto', 'blockchain'], description: 'On-chain data MCP server' },
    { name: '@notainc/gyazo-mcp-server', tags: ['screenshot', 'image'], description: 'Gyazo screenshot MCP server', requiresApiKey: true, keyName: 'GYAZO_ACCESS_TOKEN' },
    { name: '@gongrzhe/server-gmail-autoauth-mcp', tags: ['email', 'google'], description: 'Gmail with auto-auth MCP server' },
    { name: 'multicluster-mcp-server', tags: ['cloud', 'kubernetes'], description: 'Multi-cluster Kubernetes MCP server' },
    { name: '@modelcontextprotocol/server-filesystem', tags: ['filesystem'], description: 'Filesystem operations MCP server' },
    { name: '@modelcontextprotocol/server-github', tags: ['git', 'development'], description: 'GitHub integration MCP server', requiresApiKey: true, keyName: 'GITHUB_TOKEN' },
    { name: '@modelcontextprotocol/server-slack', tags: ['communication'], description: 'Slack integration MCP server', requiresApiKey: true, keyName: 'SLACK_TOKEN' },
    { name: '@modelcontextprotocol/server-youtube', tags: ['video', 'media'], description: 'YouTube integration MCP server', requiresApiKey: true, keyName: 'YOUTUBE_API_KEY' },
    { name: '@modelcontextprotocol/server-playwright', tags: ['automation', 'browser'], description: 'Playwright browser automation MCP server' },
    { name: '@modelcontextprotocol/server-todoist', tags: ['productivity'], description: 'Todoist task management MCP server', requiresApiKey: true, keyName: 'TODOIST_API_TOKEN' },
    { name: '@modelcontextprotocol/server-notion', tags: ['productivity', 'notes'], description: 'Notion integration MCP server', requiresApiKey: true, keyName: 'NOTION_API_KEY' },
    { name: '@modelcontextprotocol/server-linear', tags: ['productivity', 'development'], description: 'Linear issue tracking MCP server', requiresApiKey: true, keyName: 'LINEAR_API_KEY' },
    { name: '@modelcontextprotocol/server-brave-search', tags: ['search'], description: 'Brave Search MCP server', requiresApiKey: true, keyName: 'BRAVE_API_KEY' },
    { name: '@modelcontextprotocol/server-memory', tags: ['utility'], description: 'Memory storage MCP server' },
    { name: '@modelcontextprotocol/server-prisma', tags: ['database', 'development'], description: 'Prisma database MCP server' }
];

// Load already registered servers
async function loadRegisteredServers() {
    try {
        const response = await fetch('https://mcpfinder.dev/api/v1/search?limit=1000');
        const servers = await response.json();
        const registered = new Set();
        servers.forEach(server => {
            if (server.url) {
                registered.add(server.url);
            }
        });
        return registered;
    } catch (error) {
        console.error('Failed to load registered servers:', error);
        return new Set();
    }
}

async function registerServer(server, skipIfRegistered) {
    try {
        // Check if already registered
        if (skipIfRegistered.has(server.name)) {
            return { success: false, error: 'Already registered' };
        }
        
        // Build registration command
        let registerCommand = `npx @mcpfinder/server@latest register "${server.name}" --headless`;
        registerCommand += ` --description "${server.description}"`;
        registerCommand += ` --tags "${server.tags.join(',')}"`;
        
        if (server.requiresApiKey) {
            registerCommand += ` --requires-api-key`;
            if (server.keyName) {
                registerCommand += ` --key-name "${server.keyName}"`;
            }
        }
        
        const { stdout, stderr } = await execAsync(registerCommand, {
            env: { ...process.env },
            timeout: 30000 // 30 second timeout
        });
        
        return { success: true, stdout, stderr };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function main() {
    console.log('🚀 Starting Registration of Known Good Servers\n');
    
    try {
        // Load already registered servers
        console.log('Loading already registered servers...');
        const registeredServers = await loadRegisteredServers();
        console.log(`Found ${registeredServers.size} already registered servers\n`);
        
        const results = {
            successful: 0,
            failed: 0,
            skipped: 0,
            details: []
        };
        
        console.log(`Processing ${KNOWN_GOOD_SERVERS.length} known good servers...\n`);
        
        for (let i = 0; i < KNOWN_GOOD_SERVERS.length; i++) {
            const server = KNOWN_GOOD_SERVERS[i];
            console.log(`[${i + 1}/${KNOWN_GOOD_SERVERS.length}] Processing: ${server.name}`);
            
            const result = await registerServer(server, registeredServers);
            
            if (result.success) {
                console.log(`  ✅ Successfully registered`);
                results.successful++;
                results.details.push({ name: server.name, status: 'success' });
            } else if (result.error === 'Already registered') {
                console.log(`  ⏩ Already registered`);
                results.skipped++;
                results.details.push({ name: server.name, status: 'skipped' });
            } else {
                console.log(`  ❌ Failed: ${result.error}`);
                results.failed++;
                results.details.push({ name: server.name, status: 'failed', error: result.error });
            }
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 REGISTRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total servers: ${KNOWN_GOOD_SERVERS.length}`);
        console.log(`✅ Successfully registered: ${results.successful}`);
        console.log(`⏩ Already registered: ${results.skipped}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log('='.repeat(60));
        
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Run the script
main().catch(console.error);