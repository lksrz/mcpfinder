#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import fetch from 'node-fetch'; // Ensure node-fetch is installed or use native fetch in newer Node versions

// Define the base URL and secret with defaults from env vars
const DEFAULT_API_URL = process.env.MCPFINDER_API_URL || 'http://localhost:8787';
const DEFAULT_SECRET = process.env.MCPFINDER_REGISTRY_SECRET; // Can be undefined

// Function remains largely the same, but now accepts apiUrl and secret as parameters
async function registerManifest(filePath, apiUrl, secret) {
    // Construct the full API endpoint URL
    const fullApiUrl = `${apiUrl}/api/v1/register`; // Construct the full API endpoint URL

    if (!secret) {
        console.error('Error: Registry secret is not provided. Set MCPFINDER_REGISTRY_SECRET environment variable or use the --secret option.');
        process.exit(1);
    }

    try {
        const absolutePath = path.resolve(filePath);
        console.log(`Registering manifest from ${absolutePath} to ${fullApiUrl}...`); // Use fullApiUrl

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

        const response = await fetch(fullApiUrl, { // Use fullApiUrl
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
            // Consider exiting with error code if API indicates failure
            // process.exit(1);
        }

    } catch (error) {
        // Catch fetch errors (network issues) or other errors during registration
         if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
            // Specific handling for DNS/connection errors
            console.error(`Error: Could not connect to the MCP Finder API endpoint: ${fullApiUrl}`); // Use fullApiUrl
            console.error(`Reason: ${error.message}`);
            console.error('Please check the API URL (via --api-url or MCPFINDER_API_URL), ensure the server is running, and verify your network connection.');
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
    // Use yargs for argument parsing
    const argv = await yargs(hideBin(process.argv))
        .option('api-url', {
            alias: 'u',
            type: 'string',
            description: 'Base URL of the MCP Finder API',
            default: DEFAULT_API_URL,
            // No 'required' as it defaults from ENV
        })
        .option('secret', {
            alias: 's',
            type: 'string',
            description: 'Secret key for authenticating registration requests',
            default: DEFAULT_SECRET, // Default comes from ENV
            // No 'required' here, checked within registerManifest
        })
        .command('register <file>', 'Register an MCP manifest with the MCP Finder registry', (yargs) => {
            yargs.positional('file', {
                describe: 'Path to the mcp.json manifest file',
                type: 'string',
                demandOption: 'Path to the manifest file is required for register command.', // Make file path required for register
            });
        }, async (argv) => { // Handler function for the register command
             // Pass the resolved api-url and secret to the function
            // yargs automatically handles defaults and overrides from options
            await registerManifest(argv.file, argv.apiUrl, argv.secret);
        })
        .demandCommand(1, 'You must provide a command.') // Ensure a command (like 'register') is given
        .strict() // Throw error on unknown options/commands
        .help()
        .alias('help', 'h')
        .epilog(`Environment Variables:\n  MCPFINDER_API_URL          Overrides default API URL (${DEFAULT_API_URL}) if --api-url is not set.\n  MCPFINDER_REGISTRY_SECRET  Provides the secret key if --secret is not set. (Required either way)`)
        .fail((msg, err, yargs) => { // Custom failure handler
            if (msg) console.error(`Error: ${msg}`);
            if (err) console.error(err); // Log the actual error object if available
            console.error('' + yargs.help()); // Show help message on failure
            process.exit(1);
        })
        .parse(); // Execute parsing and command handling

    // No need for the switch/case or if block here anymore,
    // command handling is done within .command() definition
}

main().catch(err => {
    // Catch unexpected errors not handled by yargs or registerManifest
    console.error("A critical unexpected error occurred:", err.message || err);
    // console.error(err); // Uncomment for full stack trace
    process.exit(1);
});
