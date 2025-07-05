const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');
const fetch = require('node-fetch');

// Known package mappings for servers with only "-y" in args
const PACKAGE_MAPPINGS = {
    'hyperbrowser': 'hyperbrowser-mcp',
    'ticketmaster': '@delorenj/mcp-server-ticketmaster',
    'ghost-mcp': '@fanyangmeng/ghost-mcp',
    'ClickUp': '@taazkareem/clickup-mcp-server',
    'lara-translate': '@translated/lara-mcp',
    'vectorize': '@vectorize-io/vectorize-mcp-server',
    'astra-db-mcp': '@datastax/astra-db-mcp',
    'twitter-mcp': '@enescinar/twitter-mcp',
    'paddle': '@paddle/paddle-mcp',
    'google-search': '@adenot/mcp-google-search',
    'iterm-mcp': 'iterm-mcp',
    'momento': '@gomomento/mcp-momento',
    'agentrpc': 'agentrpc',
    'memory': '@modelcontextprotocol/server-memory',
    'firecrawl-mcp': 'firecrawl-mcp',
    'gotoHuman': '@gotohuman/mcp-server',
    'mongodb-env': '@bao2012/mongodb-mcp-server',
    'xero': '@mcp/xero-server',
    'deepseek-thinker': 'deepseek-thinker-mcp',
    'youtube': '@modelcontextprotocol/server-youtube',
    'dart': 'dart-mcp',
    'github': '@modelcontextprotocol/server-github',
    'heroku': 'heroku-mcp',
    'bigquery': '@shaneholloman/mcp-server-bigquery',
    'MongoDB': '@bao2012/mongodb-mcp-server',
    'search1api': 'search1api-mcp',
    'rember': 'rember-mcp',
    'audiense-insights': 'audiense-insights-mcp',
    'traveler': 'traveler-mcp',
    'mobile-mcp': 'mobile-mcp',
    'searxng': 'searxng-mcp',
    'integration-app-hubspot': 'integration-app-hubspot-mcp',
    'playwright': '@modelcontextprotocol/server-playwright',
    'productboard': 'productboard-mcp',
    'telegram': 'telegram-mcp',
    'deepseek': 'deepseek-mcp',
    'evm-mcp-server': 'evm-mcp-server',
    'evm-mcp-http': 'evm-mcp-http',
    'contentful': 'contentful-mcp',
    'todoist': '@modelcontextprotocol/server-todoist',
    'obsidian': 'obsidian-mcp',
    'keycloak': 'keycloak-mcp',
    'pinecone': 'pinecone-mcp',
    'elasticsearch-mcp-server': 'elasticsearch-mcp-server',
    'kibela': 'kibela-mcp',
    'browserstack': 'browserstack-mcp',
    'Assistant over supergateway': 'supergateway-mcp',
    'notionApi': '@modelcontextprotocol/server-notion',
    'octagon-mcp-server': 'octagon-mcp-server',
    'free-usdc-transfer': 'free-usdc-transfer-mcp',
    'llamacloud': 'llamacloud-mcp',
    'Prisma': '@modelcontextprotocol/server-prisma',
    'MCP Neovim Server': 'neovim-mcp',
    'nationalparks': 'nationalparks-mcp',
    '@21st-dev/magic': '@21st-dev/magic',
    'hdw': 'hdw-mcp',
    'gitee': 'gitee-mcp',
    'Neon': '@neondatabase/mcp-server-neon',
    'linear': '@modelcontextprotocol/server-linear',
    'raygun': 'raygun-mcp',
    'GraphQL Schema': 'graphql-schema-mcp',
    'windows-cli': 'windows-cli-mcp',
    'agentql': 'agentql-mcp',
    'ns-server': 'ns-server-mcp',
    'multicluster-mcp-server': 'multicluster-mcp-server',
    'supermachineExampleNpx': 'supermachine-example-mcp',
    'whois': '@bharathvaj/whois-mcp',
    'OpenAPI Schema': 'mcp-openapi-schema',
    'brave-search': '@modelcontextprotocol/server-brave-search',
    'mcp-router': 'mcpr-cli',
    'rijksmuseum-server': 'mcp-server-rijksmuseum',
    'tavily-mcp': 'tavily-mcp',
    'xero-mcp': '@mcp/xero-server',
    'openrpc': 'openrpc-mcp',
    'jetbrains': 'jetbrains-mcp',
    'graphlit-mcp-server': 'graphlit-mcp-server',
    'mcp_server_mysql': '@coldbrew/mysql-mcp',
    'Framelink Figma MCP': 'framelink-figma-mcp',
    'slack': '@modelcontextprotocol/server-slack',
    'mcp-compass': 'mcp-compass',
    'pushover': 'pushover-mcp',
    'ticktick': 'ticktick-mcp',
    'airbnb': 'airbnb-mcp',
    'nasa-mcp': 'nasa-mcp',
    'codacy': 'codacy-mcp'
};

// Additional package mappings from the args
const ARGS_PACKAGE_MAPPINGS = {
    'ghost-mcp': '@fanyangmeng/ghost-mcp',
    'ClickUp': '@taazkareem/clickup-mcp-server',
    'lara-translate': '@translated/lara-mcp',
    'vectorize': '@vectorize-io/vectorize-mcp-server',
    'astra-db-mcp': '@datastax/astra-db-mcp',
    'twitter-mcp': '@enescinar/twitter-mcp',
    'paddle': '@paddle/paddle-mcp',
    'google-search': '@adenot/mcp-google-search',
    'momento': '@gomomento/mcp-momento',
    'agentrpc': 'agentrpc',
    'memory': '@modelcontextprotocol/server-memory',
    'firecrawl-mcp': '@firebaseapp/mcp-server-firecrawl',
    'gotoHuman': '@gotohuman/mcp-server',
    'mongodb-env': '@bao2012/mongodb-mcp-server',
    'xero': '@xeroapi/xero-mcp',
    'youtube': '@modelcontextprotocol/server-youtube',
    'dart': '@codemate-oj/dart-mcp',
    'github': '@modelcontextprotocol/server-github',
    'heroku': '@heroku/heroku-mcp-server',
    'bigquery': '@shaneholloman/mcp-server-bigquery',
    'MongoDB': '@bao2012/mongodb-mcp-server',
    'search1api': '@search1api/mcp-server',
    'rember': '@remberai/rember-mcp-server', 
    'audiense-insights': '@audiense/mcp-server',
    'traveler': '@nomad-tools/traveler-mcp',
    'mobile-mcp': '@mcp/server-mobile',
    'searxng': '@searxng/mcp-server',
    'playwright': '@modelcontextprotocol/server-playwright',
    'productboard': '@productboard/mcp-server',
    'telegram': '@gramio/mcp-telegram-server',
    'deepseek': '@deepseek-ai/mcp-server',
    'evm-mcp-server': '@blockchain-mcp/evm-server',
    'evm-mcp-http': '@blockchain-mcp/evm-http',
    'contentful': '@contentful/mcp-server',
    'todoist': '@modelcontextprotocol/server-todoist',
    'obsidian': '@obsidian/mcp-server',
    'keycloak': '@keycloak/mcp-server',
    'pinecone': '@pinecone-io/mcp-server',
    'elasticsearch-mcp-server': '@elastic/mcp-server',
    'kibela': '@kibela/mcp-server',
    'browserstack': '@browserstack/mcp-server',
    'notionApi': '@modelcontextprotocol/server-notion',
    'octagon-mcp-server': '@octagon/mcp-server',
    'free-usdc-transfer': '@crypto-mcp/usdc-transfer',
    'llamacloud': '@llamaindex/mcp-server',
    'Prisma': '@modelcontextprotocol/server-prisma',
    'MCP Neovim Server': '@neovim/mcp-server',
    'nationalparks': '@nps/mcp-server',
    'hdw': '@hdw/mcp-server',
    'gitee': '@gitee/mcp-server',
    'Neon': '@neondatabase/mcp-server-neon',
    'linear': '@modelcontextprotocol/server-linear',
    'raygun': '@raygun/mcp-server',
    'GraphQL Schema': '@graphql/mcp-schema-server',
    'windows-cli': '@windows/mcp-cli-server',
    'agentql': '@agentql/mcp-server',
    'ns-server': '@namespace/mcp-server',
    'whois': '@bharathvaj/whois-mcp',
    'OpenAPI Schema': 'mcp-openapi-schema',
    'brave-search': '@brave/mcp-search-server',
    'mcp-router': 'mcpr-cli',
    'rijksmuseum-server': 'mcp-server-rijksmuseum',
    'tavily-mcp': '@tavily/mcp-server',
    'xero-mcp': '@xeroapi/xero-mcp',
    'openrpc': '@open-rpc/mcp-server',
    'jetbrains': '@jetbrains/mcp-server',
    'graphlit-mcp-server': '@graphlit/mcp-server',
    'mcp_server_mysql': '@coldbrew/mysql-mcp',
    'Framelink Figma MCP': '@framelink/figma-mcp',
    'slack': '@modelcontextprotocol/server-slack',
    'mcp-compass': 'mcp-compass',
    'pushover': '@pushover/mcp-server',
    'ticktick': '@ticktick/mcp-server',
    'airbnb': '@airbnb/mcp-server',
    'nasa-mcp': '@nasa/mcp-server',
    'codacy': '@codacy/mcp-server'
};

// Load already registered servers
async function loadRegisteredServers() {
    try {
        const response = await fetch('https://mcpfinder.dev/api/v1/search?limit=1000');
        const servers = await response.json();
        const registered = new Set();
        servers.forEach(server => {
            if (server.url) {
                registered.add(server.url);
                // Also add without @ prefix for comparison
                if (server.url.startsWith('@')) {
                    registered.add(server.url.substring(server.url.indexOf('/') + 1));
                }
            }
        });
        return registered;
    } catch (error) {
        console.error('Failed to load registered servers:', error);
        return new Set();
    }
}

async function registerServer(serverData, serverName, skipIfRegistered) {
    let packageName;
    
    try {
        
        // Extract package name from args
        if (serverData.args && serverData.args.length > 0) {
            // First check for explicit package names in args
            const cleanArgs = serverData.args.filter(arg => arg !== '-y' && !arg.startsWith('--') && !arg.startsWith('/') && arg !== 'mcp' && arg !== 'connect');
            
            if (cleanArgs.length > 0 && cleanArgs[0] !== '-y') {
                packageName = cleanArgs[0].replace('@latest', '');
            } else {
                // Try args mappings first, then general mappings
                packageName = ARGS_PACKAGE_MAPPINGS[serverName] || PACKAGE_MAPPINGS[serverName];
                if (!packageName) {
                    // Generate from server name as last resort
                    packageName = serverName.toLowerCase().replace(/[\s_]/g, '-');
                    if (!packageName.includes('-mcp')) {
                        packageName += '-mcp';
                    }
                }
            }
        } else {
            return { success: false, error: 'No args found' };
        }
        
        // Skip invalid package names
        if (!packageName || packageName.includes('/path/to/') || packageName === 'tsx' || 
            packageName === 'mcp-remote' || packageName === 'mcp' || packageName === 'connect' ||
            packageName.includes('.js') || packageName.length < 3) {
            return { success: false, error: 'Invalid package name' };
        }
        
        // Check if already registered
        if (skipIfRegistered.has(packageName)) {
            return { success: false, error: 'Already registered' };
        }
        
        let description = `${serverName} MCP server`;
        let tags = [];
        
        // Skip if it requires API key (for this aggressive registration)
        if (serverData.env && Object.keys(serverData.env).some(key => 
            key.includes('API_KEY') || key.includes('TOKEN') || key.includes('SECRET'))) {
            // Still try to register with metadata
        }
        
        // Add default tags based on server name
        const nameLower = serverName.toLowerCase();
        if (nameLower.includes('cloud')) tags.push('cloud');
        if (nameLower.includes('file') || nameLower.includes('fs')) tags.push('filesystem');
        if (nameLower.includes('data') || nameLower.includes('db') || nameLower.includes('database')) tags.push('data');
        if (nameLower.includes('ai') || nameLower.includes('llm')) tags.push('ai');
        if (nameLower.includes('search')) tags.push('search');
        if (nameLower.includes('browser') || nameLower.includes('playwright')) tags.push('automation');
        if (nameLower.includes('git')) tags.push('development');
        if (nameLower.includes('api')) tags.push('api');
        if (nameLower.includes('auth')) tags.push('authentication');
        if (nameLower.includes('mail') || nameLower.includes('email')) tags.push('communication');
        if (nameLower.includes('crypto') || nameLower.includes('blockchain')) tags.push('crypto');
        if (nameLower.includes('monitor')) tags.push('monitoring');
        if (nameLower.includes('test')) tags.push('testing');
        
        // Ensure we have at least one tag
        if (tags.length === 0) {
            tags.push('utility');
        }
        
        // Build registration command
        let registerCommand = `npx @mcpfinder/server@latest register "${packageName}" --headless`;
        registerCommand += ` --description "${description.substring(0, 200)}"`;
        registerCommand += ` --tags "${tags.join(',')}"`;
        
        const { stdout, stderr } = await execAsync(registerCommand, {
            cwd: __dirname,
            env: { ...process.env },
            timeout: 20000 // 20 second timeout
        });
        
        return { success: true, stdout, stderr };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function processBatch(servers, batchSize = 10) {
    const results = {
        successful: 0,
        failed: 0,
        skipped: 0,
        details: []
    };
    
    for (let i = 0; i < servers.length; i += batchSize) {
        const batch = servers.slice(i, Math.min(i + batchSize, servers.length));
        console.log(`\nProcessing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(servers.length/batchSize)} (${batch.length} servers)`);
        
        const batchPromises = batch.map(async ([serverName, serverData]) => {
            try {
                const result = await registerServer(serverData, serverName, registeredServers);
                if (result.success) {
                    console.log(`  ✅ ${serverName}`);
                    results.successful++;
                    return { name: serverName, status: 'success' };
                } else if (result.error === 'Already registered') {
                    console.log(`  ⏩ ${serverName} - already registered`);
                    results.skipped++;
                    return { name: serverName, status: 'skipped' };
                } else {
                    console.log(`  ❌ ${serverName}: ${result.error.split('\n')[0]}`);
                    results.failed++;
                    return { name: serverName, status: 'failed', error: result.error };
                }
            } catch (error) {
                console.log(`  ❌ ${serverName}: ${error.message}`);
                results.failed++;
                return { name: serverName, status: 'failed', error: error.message };
            }
        });
        
        const batchResults = await Promise.all(batchPromises);
        results.details.push(...batchResults);
        
        // Shorter delay between batches
        if (i + batchSize < servers.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    return results;
}

// Load registered servers globally
let registeredServers = new Set();

async function main() {
    console.log('🚀 Starting Aggressive Server Registration\n');
    
    try {
        // Load already registered servers
        console.log('Loading already registered servers...');
        registeredServers = await loadRegisteredServers();
        console.log(`Found ${registeredServers.size} already registered servers\n`);
        
        // Read the JSON file
        const jsonPath = path.join(__dirname, '../cli/urls_mcp_servers2.json');
        const data = await fs.readFile(jsonPath, 'utf-8');
        const servers = JSON.parse(data);
        
        // Filter only NPX servers (skip uvx for now)
        const npxServers = Object.entries(servers).filter(([name, data]) => {
            return data && data.command === 'npx' && data.args && data.args.length > 0;
        });
        
        console.log(`Found ${npxServers.length} NPX servers to process\n`);
        
        // Process all NPX servers
        const results = await processBatch(npxServers, 15); // Process 15 at a time
        
        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 REGISTRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total servers processed: ${npxServers.length}`);
        console.log(`✅ Successfully registered: ${results.successful}`);
        console.log(`⏩ Already registered: ${results.skipped}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log('='.repeat(60));
        
        // Save results
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsPath = path.join(__dirname, `aggressive-registration-results-${timestamp}.json`);
        await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
        console.log(`\n📁 Results saved to: ${resultsPath}`);
        
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Run the script
main().catch(console.error);