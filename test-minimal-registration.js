#!/usr/bin/env node

import fetch from 'node-fetch';

async function testMinimalRegistration() {
    console.log('Testing minimal registration flow...\n');
    
    // Test manifest for an "unanalyzed" server
    const manifest = {
        name: "test-auth-server",
        description: "Authentication required - capabilities unknown",
        url: "https://test-auth-server.example.com/api/mcp",
        protocol_version: "2024-11-05",
        capabilities: [{
            name: "capabilities_unknown",
            type: "tool",
            description: "Server capabilities cannot be determined without authentication"
        }],
        tags: ["unanalyzed", "auth-required", "test"],
        auth: {
            type: "oauth",
            instructions: "OAuth authentication required"
        }
    };
    
    console.log('1. Registering unanalyzed server (no auth)...');
    const response1 = await fetch('http://localhost:8787/api/v1/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest)
    });
    
    const result1 = await response1.json();
    console.log('Response:', result1);
    
    if (result1.success) {
        console.log('\n2. Searching for the registered server...');
        const searchResponse = await fetch('http://localhost:8787/api/v1/search?q=' + encodeURIComponent(manifest.url));
        const searchResult = await searchResponse.json();
        console.log('Search result:', JSON.stringify(searchResult, null, 2));
        
        // Now test updating it without auth (should allow full update for unanalyzed)
        console.log('\n3. Updating unanalyzed server with full details (no auth)...');
        const updatedManifest = {
            ...manifest,
            name: "Test Auth Server - Updated",
            description: "Now with full capabilities discovered!",
            capabilities: [
                { name: "authenticate", type: "tool", description: "Authenticate with OAuth" },
                { name: "get_user_data", type: "tool", description: "Get authenticated user data" }
            ],
            tags: ["oauth", "authentication", "user-data"]
        };
        
        const response2 = await fetch('http://localhost:8787/api/v1/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updatedManifest)
        });
        
        const result2 = await response2.json();
        console.log('Update response:', result2);
        
        console.log('\n4. Verifying the update...');
        const verifyResponse = await fetch('http://localhost:8787/api/v1/search?q=' + encodeURIComponent(manifest.url));
        const verifyResult = await verifyResponse.json();
        console.log('Updated server:', JSON.stringify(verifyResult, null, 2));
    }
}

testMinimalRegistration().catch(console.error);