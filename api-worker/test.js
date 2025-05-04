#!/usr/bin/env node

const fetch = require('node-fetch');
const { hmac } = require('@noble/hashes/hmac');
const { sha256 } = require('@noble/hashes/sha256');
const { bytesToHex } = require('@noble/hashes/utils');

// --- Configuration ---
const DEFAULT_BASE_URL = 'http://localhost:8787';
const API_SECRET = process.env.MCP_REGISTRY_SECRET;
const BASE_URL = process.argv[2] || DEFAULT_BASE_URL; // Get base URL from CLI arg or default

// --- Helper Functions ---
function calculateHmac(secret, body) {
    if (!secret || typeof body !== 'string') return null;
    try {
        const encoder = new TextEncoder();
        return bytesToHex(hmac(sha256, encoder.encode(secret), encoder.encode(body)));
    } catch (e) {
        console.error("Error calculating HMAC:", e);
        return null;
    }
}

async function request(method, path, body = null) {
    const url = `${BASE_URL}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    let bodyString = null;

    if (body) {
        bodyString = JSON.stringify(body);
    }

    // Add HMAC for registration
    if (path === '/api/v1/register' && bodyString) {
        const signature = calculateHmac(API_SECRET, bodyString);
        if (!signature) {
            throw new Error('Failed to calculate HMAC signature. Is MCP_REGISTRY_SECRET set?');
        }
        headers['Authorization'] = `HMAC ${signature}`;
    }

    console.log(`> ${method} ${url}${bodyString ? `\n  Body: ${bodyString.substring(0, 100)}${bodyString.length > 100 ? '...' : ''}`: ''}`);

    const options = {
        method: method,
        headers: headers,
        body: bodyString,
    };

    try {
        const response = await fetch(url, options);
        const responseBody = await response.text();
        let responseJson = null;
        try {
            responseJson = JSON.parse(responseBody);
        } catch (e) { /* Ignore parse error if body is not JSON */ }

        console.log(`< ${response.status} ${response.statusText}`);
        if (responseBody) {
            console.log(`  Response: ${responseBody.substring(0, 150)}${responseBody.length > 150 ? '...' : ''}`);
        }

        return { status: response.status, json: responseJson, text: responseBody };
    } catch (error) {
        console.error(`! Error during ${method} ${url}:`, error.message);
        throw error; // Re-throw to fail the test
    }
}

// --- Test Data ---
const tool1 = {
    name: "Test Tool Alpha",
    description: "The first tool for testing.",
    url: "http://localhost:1111/mcp",
    protocol_version: "MCP/1.0",
    capabilities: [ { name: "alphaTest", type: "tool" } ],
    tags: ["test", "alpha"]
};

const tool2 = {
    name: "Test Tool Beta",
    description: "The second tool, also for testing.",
    url: "http://localhost:2222/mcp",
    "protocol_version": "MCP/1.0",
    "capabilities": [ { name: "betaTest", type: "tool" } ],
    "tags": ["test", "beta"]
};

// --- Test Runner ---
async function runTests() {
    console.log(`--- Starting API Tests against ${BASE_URL} ---`);

    if (!API_SECRET) {
        console.error('! Error: MCP_REGISTRY_SECRET environment variable is not set.');
        process.exit(1);
    }

    let tool1Id = null;
    let tool2Id = null;

    try {
        // 1. Register Tool 1
        console.log('\n--- Test: POST /api/v1/register (Tool 1) ---');
        let response = await request('POST', '/api/v1/register', tool1);
        if (response.status !== 201 || !response.json?.id) {
            throw new Error('Failed to register tool 1');
        }
        tool1Id = response.json.id;
        console.log(`  OK: Registered Tool 1 with ID: ${tool1Id}`);

        // 2. Register Tool 2
        console.log('\n--- Test: POST /api/v1/register (Tool 2) ---');
        response = await request('POST', '/api/v1/register', tool2);
        if (response.status !== 201 || !response.json?.id) {
            throw new Error('Failed to register tool 2');
        }
        tool2Id = response.json.id;
        console.log(`  OK: Registered Tool 2 with ID: ${tool2Id}`);

        // 3. Get Tool 1 by ID
        console.log('\n--- Test: GET /api/v1/tools/:id (Tool 1) ---');
        response = await request('GET', `/api/v1/tools/${tool1Id}`);
        if (response.status !== 200 || response.json?.name !== tool1.name || response.json?._id !== tool1Id) {
             throw new Error(`Failed to get tool 1 by ID ${tool1Id}`);
        }
        console.log(`  OK: Successfully fetched Tool 1`);

        // 4. Search - All (expect 2 tools)
        console.log('\n--- Test: GET /api/v1/search (All) ---');
        response = await request('GET', '/api/v1/search');
        if (response.status !== 200 || !Array.isArray(response.json) || response.json.length < 2) {
             throw new Error(`Search all failed to return at least 2 tools. Found: ${response.json?.length}`);
        }
        console.log(`  OK: Search returned ${response.json.length} tools`);

        // 5. Search - Query 'alpha' (expect 1 tool)
        console.log("\n--- Test: GET /api/v1/search?q=alpha ---");
        response = await request('GET', '/api/v1/search?q=alpha');
        if (response.status !== 200 || !Array.isArray(response.json) || response.json.length !== 1 || response.json[0].name !== tool1.name) {
             throw new Error(`Search '?q=alpha' did not return exactly Tool 1. Found: ${JSON.stringify(response.json)}`);
        }
        console.log(`  OK: Search for 'alpha' returned Tool 1`);

        // 6. Search - Tag 'beta' (expect 1 tool)
        console.log("\n--- Test: GET /api/v1/search?tag=beta ---");
        response = await request('GET', '/api/v1/search?tag=beta');
        if (response.status !== 200 || !Array.isArray(response.json) || response.json.length !== 1 || response.json[0].name !== tool2.name) {
             throw new Error(`Search '?tag=beta' did not return exactly Tool 2. Found: ${JSON.stringify(response.json)}`);
        }
        console.log(`  OK: Search for tag 'beta' returned Tool 2`);

        // 7. Search - Tag 'test' (expect 2 tools)
        console.log("\n--- Test: GET /api/v1/search?tag=test ---");
        response = await request('GET', '/api/v1/search?tag=test');
         if (response.status !== 200 || !Array.isArray(response.json) || response.json.length < 2) {
             throw new Error(`Search '?tag=test' did not return at least 2 tools. Found: ${response.json?.length}`);
        }
        console.log(`  OK: Search for tag 'test' returned ${response.json.length} tools`);

        // 8. Search - Limit 1 (expect 1 tool)
        console.log("\n--- Test: GET /api/v1/search?limit=1 ---");
        response = await request('GET', '/api/v1/search?limit=1');
        if (response.status !== 200 || !Array.isArray(response.json) || response.json.length !== 1) {
             throw new Error(`Search '?limit=1' did not return exactly 1 tool. Found: ${response.json?.length}`);
        }
        console.log(`  OK: Search with limit=1 returned 1 tool`);

        // --- Add more tests here (e.g., error cases) ---

        console.log('\n--- All Tests Passed! ---');
        process.exit(0);

    } catch (error) {
        console.error('\n! --- Test Failed ---');
        console.error('Error:', error.message);
        if (error.response) { // If error includes response details
             console.error('Response Status:', error.response.status);
             console.error('Response Body:', error.response.text);
        }
        process.exit(1);
    }
}

runTests(); 