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

// Extract GitHub info from mcp.so URL
function extractGitHubInfo(mcpSoUrl) {
    // Extract slug and author from URL like https://mcp.so/server/mcp-weather-server-example/duan-li
    const match = mcpSoUrl.match(/\/server\/([^\/]+)\/([^\/]+)$/);
    if (!match) return null;
    
    const [, slug, author] = match;
    // Construct likely GitHub URL
    return {
        slug,
        author,
        githubUrl: `https://github.com/${author}/${slug}`
    };
}

async function registerMcpSoServer(server, skipIfRegistered) {
    try {
        const githubInfo = extractGitHubInfo(server.url);
        if (!githubInfo) {
            return { success: false, error: 'Could not parse mcp.so URL' };
        }
        
        // Check if already registered
        if (skipIfRegistered.has(githubInfo.githubUrl) || 
            skipIfRegistered.has(githubInfo.slug) ||
            skipIfRegistered.has(`${githubInfo.author}/${githubInfo.slug}`)) {
            return { success: false, error: 'Already registered' };
        }
        
        // Extract description from name
        const nameParts = server.name.split('@');
        const description = nameParts.length > 2 ? nameParts[2] : nameParts[1] || server.name;
        
        // Generate tags based on slug
        const tags = [];
        const slugLower = githubInfo.slug.toLowerCase();
        if (slugLower.includes('weather')) tags.push('data');
        if (slugLower.includes('doc')) tags.push('documentation');
        if (slugLower.includes('shell')) tags.push('system');
        if (slugLower.includes('api')) tags.push('api');
        if (slugLower.includes('command')) tags.push('automation');
        if (slugLower.includes('server')) tags.push('development');
        if (tags.length === 0) tags.push('utility');
        
        // Build registration command
        let registerCommand = `npx @mcpfinder/server@latest register "${githubInfo.githubUrl}" --headless`;
        registerCommand += ` --description "${description.substring(0, 200)}"`;
        registerCommand += ` --tags "${tags.join(',')}"`;
        
        // Only log the command if verbose logging is needed
        // console.log(`Executing: ${registerCommand}`);
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

async function registerUrls2Server(serverData, serverName, skipIfRegistered) {
    try {
        let packageName;
        let useUvx = false;
        
        // Determine package/URL based on command type
        if (serverData.command === 'npx' && serverData.args && serverData.args.length > 0) {
            // NPX servers - extract package name, skip -y flag
            const args = serverData.args.filter(arg => arg !== '-y' && !arg.startsWith('--'));
            if (args.length === 0) {
                // Use mapping or skip
                packageName = PACKAGE_MAPPINGS[serverName];
                if (!packageName) {
                    return { success: false, error: 'No package mapping found' };
                }
            } else {
                packageName = args[0].replace('@latest', '');
            }
        } else if (serverData.command === 'uvx' && serverData.args && serverData.args.length > 0) {
            // UVX servers - extract package name
            const args = serverData.args.filter(arg => !arg.startsWith('--'));
            if (args.length === 0) {
                return { success: false, error: 'No package name found in uvx args' };
            }
            packageName = args[0];
            useUvx = true;
        } else {
            return { success: false, error: 'Unsupported command type: ' + serverData.command };
        }
        
        // Skip invalid package names
        if (packageName.includes('/path/to/') || packageName === 'tsx' || packageName === 'mcp-remote' || packageName === 'mcp' || packageName === 'connect') {
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
        if (tags.length === 0) tags.push('utility');
        
        // Build registration command
        let registerCommand = `npx @mcpfinder/server@latest register "${packageName}" --headless`;
        registerCommand += ` --description "${description}"`;
        
        if (useUvx) {
            // Skip uvx servers for now since uvx is not available
            return { success: false, error: 'Skipping uvx-based server (uvx not available)' };
            // registerCommand += ` --use-uvx`;
        }
        
        if (requiresApiKey) {
            registerCommand += ` --requires-api-key`;
            if (keyName) {
                registerCommand += ` --key-name "${keyName}"`;
            }
        }
        
        if (tags.length > 0) {
            registerCommand += ` --tags "${tags.join(',')}"`;
        }
        
        // Only log the command if verbose logging is needed
        // console.log(`Executing: ${registerCommand}`);
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

async function processBatch(servers, processFn, skipIfRegistered, batchSize = 10) {
    const results = {
        successful: 0,
        failed: 0,
        skipped: 0,
        details: []
    };
    
    console.log(`📦 Starting batch processing of ${servers.length} servers (batch size: ${batchSize})`);
    
    for (let i = 0; i < servers.length; i += batchSize) {
        const batch = servers.slice(i, Math.min(i + batchSize, servers.length));
        const batchNumber = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(servers.length / batchSize);
        
        console.log(`\n🔄 Processing batch ${batchNumber}/${totalBatches} (${batch.length} servers)`);
        console.log('-'.repeat(40));
        
        const batchPromises = batch.map(async (server, index) => {
            const [serverName, serverData] = Array.isArray(server) ? server : [server.name, server];
            const serverIndex = i + index + 1;
            
            console.log(`[${serverIndex}/${servers.length}] Processing: ${serverName}`);
            
            try {
                const result = await processFn(serverData, serverName, skipIfRegistered);
                
                if (result.success) {
                    console.log(`  ✅ ${serverName} - Successfully registered`);
                    results.successful++;
                    return { name: serverName, status: 'success' };
                } else if (result.error === 'Already registered') {
                    console.log(`  ⏩ ${serverName} - Already registered`);
                    results.skipped++;
                    return { name: serverName, status: 'skipped' };
                } else {
                    console.log(`  ❌ ${serverName} - Failed: ${result.error}`);
                    results.failed++;
                    return { name: serverName, status: 'failed', error: result.error };
                }
            } catch (error) {
                console.log(`  ❌ ${serverName} - Error: ${error.message}`);
                results.failed++;
                return { name: serverName, status: 'failed', error: error.message };
            }
        });
        
        const batchResults = await Promise.all(batchPromises);
        results.details.push(...batchResults);
        
        console.log(`\nBatch ${batchNumber} complete: ✅ ${batchResults.filter(r => r.status === 'success').length} | ⏩ ${batchResults.filter(r => r.status === 'skipped').length} | ❌ ${batchResults.filter(r => r.status === 'failed').length}`);
        
        // Rate limiting between batches
        if (i + batchSize < servers.length) {
            console.log(`⏳ Waiting 2 seconds before next batch...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    
    return results;
}

async function main() {
    console.log('🚀 Starting Comprehensive Server Registration\n');
    
    try {
        // Load already registered servers
        console.log('Loading already registered servers...');
        const registeredServers = await loadRegisteredServers();
        console.log(`Found ${registeredServers.size} already registered servers\n`);
        
        // Process urls_mcp_servers2.json
        console.log('='.repeat(60));
        console.log('Processing urls_mcp_servers2.json');
        console.log('='.repeat(60));
        
        const urls2Path = path.join(__dirname, '../cli/urls_mcp_servers2.json');
        const urls2Data = await fs.readFile(urls2Path, 'utf-8');
        const urls2Servers = JSON.parse(urls2Data);
        
        // Filter NPX and UVX servers
        const npxUvxServers = Object.entries(urls2Servers).filter(([name, data]) => {
            return data && (
                (data.command === 'npx' && data.args && data.args.length > 0) ||
                (data.command === 'uvx' && data.args && data.args.length > 0)
            );
        });
        
        console.log(`Found ${npxUvxServers.length} NPX/UVX servers\n`);
        
        console.log('Processing in batches...');
        const urls2Results = await processBatch(npxUvxServers, registerUrls2Server, registeredServers, 5);
        
        // Process mcp-so-servers-merged.json
        console.log('\n' + '='.repeat(60));
        console.log('Processing mcp-so-servers-merged.json');
        console.log('='.repeat(60));
        
        const mcpSoPath = path.join(__dirname, '../scraping-tools/data/mcp-so-servers-merged.json');
        const mcpSoData = await fs.readFile(mcpSoPath, 'utf-8');
        const mcpSoServers = JSON.parse(mcpSoData);
        
        console.log(`Found ${mcpSoServers.length} mcp.so servers\n`);
        
        // Process only first 50 mcp.so servers to avoid timeout
        const mcpSoServersSubset = mcpSoServers.slice(0, 50);
        console.log(`Processing first ${mcpSoServersSubset.length} servers...\n`);
        
        const mcpSoResults = await processBatch(mcpSoServersSubset, (server, name, skip) => registerMcpSoServer(server, skip), registeredServers, 5);
        
        // Combined summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 FINAL REGISTRATION SUMMARY');
        console.log('='.repeat(60));
        console.log('\nFrom urls_mcp_servers2.json:');
        console.log(`  Total processed: ${npxUvxServers.length}`);
        console.log(`  ✅ Successfully registered: ${urls2Results.successful}`);
        console.log(`  ⏩ Skipped (already registered): ${urls2Results.skipped}`);
        console.log(`  ❌ Failed: ${urls2Results.failed}`);
        
        console.log('\nFrom mcp-so-servers-merged.json:');
        console.log(`  Total processed: ${mcpSoServersSubset.length} (out of ${mcpSoServers.length})`);
        console.log(`  ✅ Successfully registered: ${mcpSoResults.successful}`);
        console.log(`  ⏩ Skipped (already registered): ${mcpSoResults.skipped}`);
        console.log(`  ❌ Failed: ${mcpSoResults.failed}`);
        
        console.log('\nOverall:');
        console.log(`  Total servers processed: ${npxUvxServers.length + mcpSoServersSubset.length}`);
        console.log(`  Total successfully registered: ${urls2Results.successful + mcpSoResults.successful}`);
        console.log(`  Total skipped: ${urls2Results.skipped + mcpSoResults.skipped}`);
        console.log(`  Total failed: ${urls2Results.failed + mcpSoResults.failed}`);
        console.log('='.repeat(60));
        
        // Save results
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsPath = path.join(__dirname, `comprehensive-registration-results-${timestamp}.json`);
        const results = {
            urls2: urls2Results,
            mcpSo: mcpSoResults,
            summary: {
                totalProcessed: npxUvxServers.length + mcpSoServersSubset.length,
                totalSuccessful: urls2Results.successful + mcpSoResults.successful,
                totalSkipped: urls2Results.skipped + mcpSoResults.skipped,
                totalFailed: urls2Results.failed + mcpSoResults.failed
            }
        };
        await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
        console.log(`\n📁 Results saved to: ${resultsPath}`);
        
        if (mcpSoServersSubset.length < mcpSoServers.length) {
            console.log(`\n⚠️  Only processed ${mcpSoServersSubset.length} out of ${mcpSoServers.length} mcp.so servers.`);
            console.log(`Update the slice in the script to process more servers.`);
        }
        
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Run the script
main().catch(console.error);