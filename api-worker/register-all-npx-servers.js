const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');

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
    'bigquery': '@google/bigquery-mcp',
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
    'whois': 'whois-mcp',
    'OpenAPI Schema': 'openapi-schema-mcp',
    'brave-search': '@modelcontextprotocol/server-brave-search',
    'mcp-router': 'mcp-router',
    'rijksmuseum-server': 'rijksmuseum-mcp',
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

// Load already registered servers to skip them
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
    try {
        let packageName;
        
        // Extract package name from args
        if (serverData.args && serverData.args.length > 0) {
            const args = serverData.args.filter(arg => arg !== '-y' && !arg.startsWith('--'));
            if (args.length === 0) {
                // Use mapping or generate from server name
                packageName = PACKAGE_MAPPINGS[serverName];
                if (!packageName) {
                    console.log(`No mapping found for ${serverName}, skipping...`);
                    return { success: false, error: 'No package mapping found' };
                }
            } else {
                packageName = args[0].replace('@latest', '');
            }
        } else {
            return { success: false, error: 'No args found' };
        }
        
        // Skip invalid package names
        if (packageName.includes('/path/to/') || packageName === 'tsx' || packageName === 'mcp-remote' || packageName === 'mcp') {
            return { success: false, error: 'Invalid package name' };
        }
        
        // Check if already registered
        if (skipIfRegistered.has(packageName)) {
            return { success: false, error: 'Already registered' };
        }
        
        let description = `${serverName} MCP server`;
        let tags = [];
        let requiresApiKey = false;
        let keyName = '';
        
        // Check for environment variables (API keys)
        if (serverData.env) {
            const apiKeyVars = Object.keys(serverData.env).filter(key => 
                key.includes('API_KEY') || key.includes('TOKEN') || key.includes('SECRET')
            );
            if (apiKeyVars.length > 0) {
                requiresApiKey = true;
                keyName = apiKeyVars[0];
            }
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
        
        // Ensure we have at least one tag
        if (tags.length === 0) {
            tags.push('utility');
        }
        
        // Build registration command using the updated mcpfinder-server
        let registerCommand = `npx @mcpfinder/server@latest register "${packageName}" --headless`;
        registerCommand += ` --description "${description}"`;
        
        if (requiresApiKey) {
            registerCommand += ` --requires-api-key`;
            if (keyName) {
                registerCommand += ` --key-name "${keyName}"`;
            }
        }
        
        if (tags.length > 0) {
            registerCommand += ` --tags "${tags.join(',')}"`;
        }
        
        console.log(`Executing: ${registerCommand}`);
        const { stdout, stderr } = await execAsync(registerCommand, {
            cwd: __dirname,
            env: { ...process.env },
            timeout: 45000 // 45 second timeout
        });
        
        return { success: true, stdout, stderr };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function main() {
    console.log('🚀 Starting Comprehensive NPX Server Registration\n');
    
    try {
        // Load already registered servers
        console.log('Loading already registered servers...');
        const registeredServers = await loadRegisteredServers();
        console.log(`Found ${registeredServers.size} already registered servers\n`);
        
        // Read the JSON file
        const jsonPath = path.join(__dirname, '../cli/urls_mcp_servers2.json');
        const data = await fs.readFile(jsonPath, 'utf-8');
        const servers = JSON.parse(data);
        
        // Filter only NPX servers
        const npxServers = Object.entries(servers).filter(([name, data]) => {
            return data && data.command === 'npx' && data.args && data.args.length > 0;
        });
        
        console.log(`Found ${npxServers.length} NPX-based servers in total\n`);
        
        const results = {
            total: npxServers.length,
            successful: 0,
            failed: 0,
            skipped: 0,
            details: []
        };
        
        // Process each server
        let processedCount = 0;
        for (const [serverName, serverData] of npxServers) {
            processedCount++;
            console.log(`\n${'='.repeat(60)}`);
            console.log(`[${processedCount}/${npxServers.length}] Processing: ${serverName}`);
            console.log(`Args: ${serverData.args.join(' ')}`);
            console.log(`${'='.repeat(60)}`);
            
            const result = await registerServer(serverData, serverName, registeredServers);
            
            if (result.success) {
                console.log(`✅ Successfully registered ${serverName}`);
                results.successful++;
                results.details.push({
                    name: serverName,
                    status: 'success'
                });
            } else if (result.error === 'Already registered') {
                console.log(`⏩ Skipped ${serverName} - already registered`);
                results.skipped++;
                results.details.push({
                    name: serverName,
                    status: 'skipped',
                    error: result.error
                });
            } else {
                console.log(`❌ Failed to register ${serverName}`);
                console.log(`Error: ${result.error}`);
                results.failed++;
                results.details.push({
                    name: serverName,
                    status: 'failed',
                    error: result.error
                });
            }
            
            // Rate limiting - shorter delay for skipped items
            const delay = result.error === 'Already registered' ? 500 : 2000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 REGISTRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total servers processed: ${results.total}`);
        console.log(`✅ Successfully registered: ${results.successful}`);
        console.log(`⏩ Skipped (already registered): ${results.skipped}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log('='.repeat(60));
        
        if (results.failed > 0) {
            console.log('\nFailed registrations:');
            const failedDetails = results.details.filter(d => d.status === 'failed');
            const failureCounts = {};
            failedDetails.forEach(d => {
                const errorType = d.error.includes('Connection closed') ? 'Connection closed' :
                                d.error.includes('Invalid package') ? 'Invalid package' :
                                d.error.includes('No package mapping') ? 'No package mapping' :
                                'Other error';
                failureCounts[errorType] = (failureCounts[errorType] || 0) + 1;
            });
            
            Object.entries(failureCounts).forEach(([error, count]) => {
                console.log(`  - ${error}: ${count} servers`);
            });
        }
        
        // Save results
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsPath = path.join(__dirname, `all-npx-registration-results-${timestamp}.json`);
        await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
        console.log(`\n📁 Results saved to: ${resultsPath}`);
        
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Run the script
main().catch(console.error);