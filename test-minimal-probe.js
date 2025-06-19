#!/usr/bin/env node

async function probeServer(url) {
    console.log(`\nProbing ${url} for minimal information...\n`);
    
    // 1. Try OPTIONS request
    try {
        console.log('1. OPTIONS request:');
        const optionsResponse = await fetch(url, { 
            method: 'OPTIONS',
            headers: {
                'Origin': 'https://mcpfinder.dev'
            }
        });
        console.log(`   Status: ${optionsResponse.status}`);
        console.log('   Headers:');
        for (const [key, value] of optionsResponse.headers.entries()) {
            if (key.toLowerCase().includes('mcp') || 
                key.toLowerCase().includes('allow') ||
                key.toLowerCase().includes('auth') ||
                key.toLowerCase().includes('www-authenticate')) {
                console.log(`     ${key}: ${value}`);
            }
        }
    } catch (e) {
        console.log('   Failed:', e.message);
    }
    
    // 2. Try GET request (might return HTML with info)
    try {
        console.log('\n2. GET request:');
        const getResponse = await fetch(url, { 
            method: 'GET',
            headers: {
                'Accept': 'text/html,application/json'
            }
        });
        console.log(`   Status: ${getResponse.status}`);
        console.log(`   Content-Type: ${getResponse.headers.get('content-type')}`);
        
        if (getResponse.status === 200) {
            const text = await getResponse.text();
            // Look for MCP-related content
            if (text.includes('MCP') || text.includes('Model Context Protocol')) {
                console.log('   Contains MCP-related content!');
                // Extract title if HTML
                const titleMatch = text.match(/<title>(.*?)<\/title>/);
                if (titleMatch) {
                    console.log(`   Title: ${titleMatch[1]}`);
                }
            }
        }
    } catch (e) {
        console.log('   Failed:', e.message);
    }
    
    // 3. Try POST with empty initialize (analyze error)
    try {
        console.log('\n3. POST initialize (analyze error):');
        const initResponse = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2024-11-05' }
            })
        });
        
        console.log(`   Status: ${initResponse.status}`);
        
        if (initResponse.status === 401) {
            const error = await initResponse.json();
            console.log('   Auth error details:');
            if (error.error?.data) {
                console.log(`     ${JSON.stringify(error.error.data, null, 2)}`);
            }
            
            // Check WWW-Authenticate header
            const authHeader = initResponse.headers.get('www-authenticate');
            if (authHeader) {
                console.log(`   WWW-Authenticate: ${authHeader}`);
            }
        }
    } catch (e) {
        console.log('   Failed:', e.message);
    }
    
    // 4. Try well-known endpoints
    const wellKnownPaths = [
        '/.well-known/mcp-manifest',
        '/mcp-info',
        '/api/mcp-info',
        '/../.well-known/mcp-manifest' // In case /api/mcp is the endpoint
    ];
    
    console.log('\n4. Well-known endpoints:');
    for (const path of wellKnownPaths) {
        try {
            const baseUrl = new URL(url);
            const checkUrl = new URL(path, baseUrl.origin + baseUrl.pathname.replace(/\/[^\/]*$/, ''));
            const response = await fetch(checkUrl);
            if (response.status === 200) {
                console.log(`   ✓ Found: ${checkUrl.pathname}`);
                const data = await response.json().catch(() => null);
                if (data) {
                    console.log(`     ${JSON.stringify(data, null, 2)}`);
                }
            }
        } catch (e) {
            // Ignore
        }
    }
}

// Test with various servers
async function main() {
    await probeServer('https://whenmeet.me/api/mcp');
    await probeServer('https://mcpfinder.dev/mcp');
}

main().catch(console.error);