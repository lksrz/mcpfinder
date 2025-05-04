#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import fetch from 'node-fetch'; // Ensure node-fetch is installed or use native fetch in newer Node versions

// Define the base URL first
const API_BASE_URL = process.env.MCPFINDER_API_URL || 'http://localhost:8787';
const REGISTRY_SECRET = process.env.MCPFINDER_REGISTRY_SECRET;

async function registerManifest(filePath) {
    // Construct the full API endpoint URL
    const apiUrl = `${API_BASE_URL}/api/v1/register`;
    const secret = process.env.MCPFINDER_REGISTRY_SECRET; // Use local variable for consistency

    if (!secret) {
        console.error('Error: MCPFINDER_REGISTRY_SECRET environment variable is not set.');
        process.exit(1);
    }

    try {
        const absolutePath = path.resolve(filePath);
        console.log(`Registering manifest from ${absolutePath} to ${apiUrl}...`);

        const manifestContent = await fs.readFile(absolutePath, 'utf-8');

        // Validate JSON structure slightly before sending (basic check)
        let manifestJson;
        try {
            manifestJson = JSON.parse(manifestContent);
        } catch (parseError) {
            console.error(`Error: Failed to parse JSON manifest file: ${absolutePath}`);
            console.error(parseError.message);
            process.exit(1);
        }

        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(manifestContent);
        const signature = hmac.digest('hex');

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `HMAC ${signature}`,
            },
            body: manifestContent,
        });

        if (!response.ok) {
            // Read the error response body as text
            const errorBody = await response.text();
            console.error(`Error: Registration failed with status ${response.status}.`);
            console.error(`Server response: ${errorBody}`);
            // Throw an error to be caught by the outer catch block
            throw new Error(`HTTP error ${response.status}`);
        }

        // Only parse as JSON if the response was successful
        const result = await response.json();

        if (result.success) {
            console.log('Registration successful!');
            console.log('Tool ID:', result.id);
        } else {
            // Handle cases where the API returns a 2xx status but indicates failure
            console.error('Registration failed:', result.error || 'Unknown error from API');
        }

    } catch (error) {
        // Catch fetch errors (network issues) or other errors during registration
        if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
            // Specific handling for DNS/connection errors
            const apiUrl = process.env.MCPFINDER_API_URL || 'http://localhost:8787/api/v1/register'; // Reconstruct the URL attempted
            console.error(`Error: Could not connect to the MCP Finder API endpoint: ${apiUrl}`);
            console.error(`Reason: ${error.message}`);
            console.error('Please check the MCPFINDER_API_URL environment variable, ensure the server is running, and verify your network connection.');
        } else if (error.message.startsWith('HTTP error')) {
             // Handle errors explicitly thrown from !response.ok check
             // The detailed message (status, server response) was already printed in the try block
             console.error(`An error occurred during registration: ${error.message}`);
        } else {
            // Handle other errors (e.g., file reading, JSON parsing before fetch, unexpected issues)
            console.error(`An unexpected error occurred during registration: ${error.message}`);
            // console.error(error); // Uncomment for full stack trace if needed
        }
        process.exit(1);
    }
}

async function main() {
    const args = process.argv.slice(2); // Remove 'node' and script path

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        console.log('Usage: mcp-cli <command>');
        console.log('');
        console.log('Commands:');
        console.log('  register <path/to/mcp.json>   Register an MCP manifest with the MCP Finder registry.');
        console.log('');
        console.log('Environment Variables:');
        console.log('  MCPFINDER_API_URL          (Optional) Base URL of the MCP Finder API. Defaults to http://localhost:8787');
        console.log('  MCPFINDER_REGISTRY_SECRET  (Required) Secret key for authenticating registration requests.');
        process.exit(0);
    }

    const command = args[0];
    const commandArgs = args.slice(1);

    switch (command) {
        case 'register':
            if (commandArgs.length !== 1) {
                console.error('Error: register command requires exactly one argument: <path/to/mcp.json>');
                process.exit(1);
            }
            await registerManifest(commandArgs[0]);
            break;
        default:
            console.error(`Error: Unknown command '${command}'. Use --help for usage.`);
            process.exit(1);
    }
}

main().catch(err => {
    console.error("An unexpected error occurred:", err);
    process.exit(1);
});
