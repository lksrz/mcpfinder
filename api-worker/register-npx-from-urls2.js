const fs = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');

// Known package mappings for servers with only "-y" in args
const PACKAGE_MAPPINGS = {
    'hyperbrowser': 'hyperbrowser-mcp',
    'ticketmaster': '@delorenj/mcp-server-ticketmaster',
    'ghost-mcp': 'ghost-mcp',
    'ClickUp': 'clickup-mcp',
    'lara-translate': 'lara-translate-mcp',
    'vectorize': 'vectorize-mcp',
    'astra-db-mcp': 'astra-db-mcp',
    'twitter-mcp': 'twitter-mcp',
    'paddle': 'paddle-mcp',
    'google-search': 'google-search-mcp',
    'iterm-mcp': 'iterm-mcp',
    'momento': 'momento-mcp',
    'agentrpc': 'agentrpc-mcp',
    'memory': 'memory-mcp',
    'firecrawl-mcp': 'firecrawl-mcp',
    'gotoHuman': '@gotohuman/mcp-server',
    'mongodb-env': 'mongodb-mcp',
    'xero': 'xero-mcp',
    'deepseek-thinker': 'deepseek-thinker-mcp',
    'youtube': 'youtube-mcp',
    'dart': 'dart-mcp',
    'github': '@modelcontextprotocol/server-github',
    'heroku': 'heroku-mcp',
    'bigquery': 'bigquery-mcp',
    'MongoDB': 'mongodb-mcp',
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
    'todoist': 'todoist-mcp',
    'obsidian': 'obsidian-mcp',
    'keycloak': 'keycloak-mcp',
    'pinecone': 'pinecone-mcp',
    'elasticsearch-mcp-server': 'elasticsearch-mcp-server',
    'kibela': 'kibela-mcp',
    'browserstack': 'browserstack-mcp',
    'Assistant over supergateway': 'supergateway-mcp',
    'notionApi': 'notion-mcp',
    'octagon-mcp-server': 'octagon-mcp-server',
    'free-usdc-transfer': 'free-usdc-transfer-mcp',
    'llamacloud': 'llamacloud-mcp',
    'Prisma': 'prisma-mcp',
    'MCP Neovim Server': 'neovim-mcp',
    'nationalparks': 'nationalparks-mcp',
    '@21st-dev/magic': '@21st-dev/magic',
    'hdw': 'hdw-mcp',
    'gitee': 'gitee-mcp',
    'Neon': 'neon-mcp',
    'linear': 'linear-mcp',
    'raygun': 'raygun-mcp',
    'GraphQL Schema': 'graphql-schema-mcp',
    'windows-cli': 'windows-cli-mcp',
    'agentql': 'agentql-mcp',
    'ns-server': 'ns-server-mcp',
    'multicluster-mcp-server': 'multicluster-mcp-server',
    'supermachineExampleNpx': 'supermachine-example-mcp',
    'whois': 'whois-mcp',
    'OpenAPI Schema': 'openapi-schema-mcp',
    'brave-search': 'brave-search-mcp',
    'mcp-router': 'mcp-router',
    'rijksmuseum-server': 'rijksmuseum-mcp',
    'tavily-mcp': 'tavily-mcp',
    'xero-mcp': 'xero-mcp',
    'openrpc': 'openrpc-mcp',
    'jetbrains': 'jetbrains-mcp',
    'graphlit-mcp-server': 'graphlit-mcp-server',
    'mcp_server_mysql': 'mysql-mcp',
    'Framelink Figma MCP': 'framelink-figma-mcp',
    'slack': '@modelcontextprotocol/server-slack',
    'mcp-compass': 'mcp-compass',
    'pushover': 'pushover-mcp',
    'ticktick': 'ticktick-mcp',
    'airbnb': 'airbnb-mcp',
    'nasa-mcp': 'nasa-mcp',
    'codacy': 'codacy-mcp'
};

async function registerServer(serverData, serverName) {
    try {
        let packageName;
        
        // Extract package name from args
        if (serverData.args && serverData.args.length > 0) {
            const args = serverData.args.filter(arg => arg !== '-y');
            if (args.length === 0) {
                // Use mapping or generate from server name
                packageName = PACKAGE_MAPPINGS[serverName] || serverName.toLowerCase().replace(/[\s_]/g, '-') + '-mcp';
            } else {
                packageName = args[0].replace('@latest', '');
            }
        } else {
            return { success: false, error: 'No args found' };
        }
        
        // Skip invalid package names
        if (packageName.includes('/path/to/') || packageName === 'tsx' || packageName === 'mcp-remote') {
            return { success: false, error: 'Invalid package name' };
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
        if (serverName.toLowerCase().includes('cloud')) tags.push('cloud');
        if (serverName.toLowerCase().includes('file') || serverName.toLowerCase().includes('fs')) tags.push('filesystem');
        if (serverName.toLowerCase().includes('data') || serverName.toLowerCase().includes('db')) tags.push('data');
        if (serverName.toLowerCase().includes('ai') || serverName.toLowerCase().includes('llm')) tags.push('ai');
        if (serverName.toLowerCase().includes('search')) tags.push('search');
        if (serverName.toLowerCase().includes('browser')) tags.push('automation');
        
        // Build registration command
        let registerCommand = `node ../mcpfinder-server/index.js register "${packageName}" --headless`;
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
            timeout: 30000 // 30 second timeout
        });
        
        return { success: true, stdout, stderr };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function main() {
    console.log('🚀 Starting NPX-based MCP Server Registration from urls_mcp_servers2.json\n');
    
    try {
        // Read the JSON file
        const jsonPath = path.join(__dirname, '../cli/urls_mcp_servers2.json');
        const data = await fs.readFile(jsonPath, 'utf-8');
        const servers = JSON.parse(data);
        
        // Filter only NPX servers
        const npxServers = Object.entries(servers).filter(([name, data]) => {
            return data && data.command === 'npx' && data.args && data.args.length > 0;
        });
        
        console.log(`Found ${npxServers.length} NPX-based servers\n`);
        
        // Limit to first 20 servers to avoid timeout
        const serversToProcess = npxServers.slice(0, 20);
        console.log(`Processing first ${serversToProcess.length} servers...\n`);
        
        const results = {
            total: serversToProcess.length,
            successful: 0,
            failed: 0,
            details: []
        };
        
        // Process each server
        for (const [serverName, serverData] of serversToProcess) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`Processing: ${serverName}`);
            console.log(`Args: ${serverData.args.join(' ')}`);
            console.log(`${'='.repeat(60)}`);
            
            const result = await registerServer(serverData, serverName);
            
            if (result.success) {
                console.log(`✅ Successfully registered ${serverName}`);
                results.successful++;
                results.details.push({
                    name: serverName,
                    status: 'success'
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
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 REGISTRATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Total servers attempted: ${results.total}`);
        console.log(`✅ Successfully registered: ${results.successful}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log('='.repeat(60));
        
        if (results.failed > 0) {
            console.log('\nFailed registrations:');
            results.details.filter(d => d.status === 'failed').forEach(d => {
                console.log(`  - ${d.name}: ${d.error}`);
            });
        }
        
        // Save results
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsPath = path.join(__dirname, `npx-urls2-registration-results-${timestamp}.json`);
        await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
        console.log(`\n📁 Results saved to: ${resultsPath}`);
        
        console.log(`\n⚠️  Processed ${serversToProcess.length} out of ${npxServers.length} NPX servers.`);
        console.log(`Run again with updated slice to process more servers.`);
        
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Run the script
main().catch(console.error);