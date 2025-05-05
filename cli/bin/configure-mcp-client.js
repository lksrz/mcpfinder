#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { fileURLToPath } from 'url';

// Resolve __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATHS_FILE = path.join(__dirname, '../../mcpfinder-www/public/mcp_config_paths.json');
const MCPFINDER_SERVER_ID = 'mcpfinder';
const MCPFINDER_SERVER_CONFIG = {
    command: "npx",
    args: [
        "-y",
        "@mcpfinder/server"
    ]
};

function getPlatform() {
    switch (os.platform()) {
        case 'win32': return 'windows';
        case 'darwin': return 'macos';
        case 'linux': return 'linux';
        default:
            console.warn(`Unsupported platform: ${os.platform()}. Attempting to use linux paths.`);
            return 'linux';
    }
}

function createPromptInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

function askQuestion(rl, query) {
    return new Promise(resolve => rl.question(query, resolve));
}

async function loadConfigPaths() {
    try {
        const data = await fs.readFile(CONFIG_PATHS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error(`Error loading config paths from ${CONFIG_PATHS_FILE}:`, err);
        process.exit(1);
    }
}

async function selectClient(rl, clients) {
    console.log("\nPlease select your MCP client:");
    clients.forEach((client, index) => {
        console.log(`${index + 1}. ${client.tool}`);
    });
    console.log(`${clients.length + 1}. Other (specify path manually)`);

    let choiceIndex = -1;
    while (choiceIndex < 0 || choiceIndex > clients.length) {
        const choice = await askQuestion(rl, `Enter number (1-${clients.length + 1}): `);
        const parsedChoice = parseInt(choice, 10);
        if (!isNaN(parsedChoice) && parsedChoice >= 1 && parsedChoice <= clients.length + 1) {
            choiceIndex = parsedChoice - 1;
        } else {
            console.log("Invalid choice. Please enter a number from the list.");
        }
    }

    if (choiceIndex === clients.length) {
        return null; // User chose 'Other'
    }
    return clients[choiceIndex];
}

function resolvePath(filePath) {
    if (!filePath) return null;

    let resolved = filePath;
    // Resolve home directory
    if (resolved.startsWith('~')) {
        resolved = path.join(os.homedir(), resolved.slice(1));
    }

    // Resolve environment variables (e.g., %USERPROFILE% on Windows)
    resolved = resolved.replace(/%([^%]+)%/g, (_, envVar) => {
        return process.env[envVar] || '' // Replace with env var value or empty string if not found
    });

    return path.normalize(resolved);
}

async function askForManualPath(rl) {
    let filePath = '';
    while (!filePath) {
        filePath = await askQuestion(rl, '\nPlease enter the absolute path to the MCP configuration JSON file: ');
        if (!filePath) {
            console.log("Path cannot be empty.");
        }
    }
    return resolvePath(filePath);
}

async function findConfigPath(rl, selectedClient, platform) {
    if (!selectedClient) {
        console.log("Client not specified, asking for manual path.");
        return await askForManualPath(rl);
    }

    const location = selectedClient.locations.find(loc => loc.operating_systems.includes(platform));

    if (location && location.path) {
        const resolved = resolvePath(location.path);
        console.log(`Found default path for ${selectedClient.tool} on ${platform}: ${resolved}`);
        // Verify if the file exists, ask for manual if not?
        // For now, we'll assume the path is correct if found.
        // We will handle file not found during read/write.
        return resolved;
    } else {
        console.log(`Could not find a default configuration path for ${selectedClient.tool} on ${platform}.`);
        return await askForManualPath(rl);
    }
}

async function updateConfigFile(filePath, clientTool) {
    let config = {};
    let configKey = 'mcpServers'; // Default key

    try {
        const rawData = await fs.readFile(filePath, 'utf8');
        // Handle potentially empty or whitespace-only files
        if (rawData.trim()) {
            try {
                config = JSON.parse(rawData);
            } catch (parseError) {
                console.error(`Error parsing JSON from ${filePath}: ${parseError.message}`);
                console.log("The file seems to contain invalid JSON. Please check it manually.");
                // Optionally, offer to overwrite or backup?
                // For now, we exit to avoid corrupting the file.
                process.exit(1);
            }
        } else {
            console.log(`Configuration file ${filePath} is empty or contains only whitespace. Initializing fresh config.`);
            config = {}; // Start with an empty object if the file was empty/whitespace
        }
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.log(`Configuration file ${filePath} not found. Creating a new one.`);
            config = {}; // Initialize empty config if file doesn't exist
        } else {
            console.error(`Error reading configuration file ${filePath}:`, err);
            throw err; // Re-throw other errors
        }
    }

    // Determine the correct key (mcpServers or servers)
    // VS Code uses 'servers' in settings.json
    // Check if 'servers' exists and 'mcpServers' doesn't, or if client is VS Code
    const isVSCode = clientTool && clientTool.toLowerCase().includes('vs code');
    if ((config.hasOwnProperty('servers') && !config.hasOwnProperty('mcpServers')) || isVSCode) {
        configKey = 'servers';
        console.log(`Using configuration key: '${configKey}'`);
    }
     else {
        console.log(`Using configuration key: '${configKey}'`);
    }

    // Ensure the target key exists
    if (!config[configKey]) {
        config[configKey] = {};
    }

    // Add or update the mcpfinder entry
    config[configKey][MCPFINDER_SERVER_ID] = MCPFINDER_SERVER_CONFIG;
    console.log(`Added/Updated '${MCPFINDER_SERVER_ID}' entry under '${configKey}'.`);

    try {
        // Ensure the directory exists before writing
        const dirPath = path.dirname(filePath);
        await fs.mkdir(dirPath, { recursive: true });

        // Write the updated configuration back
        await fs.writeFile(filePath, JSON.stringify(config, null, 2)); // Pretty print JSON
        console.log(`Successfully updated configuration file: ${filePath}`);
    } catch (err) {
        console.error(`Error writing configuration file ${filePath}:`, err);
        throw err;
    }
}

async function main() {
    const configPathsData = await loadConfigPaths();
    const platform = getPlatform();
    const rl = createPromptInterface();

    try {
        const selectedClient = await selectClient(rl, configPathsData);
        console.log(`Selected client: ${selectedClient ? selectedClient.tool : 'Other'}`);
        console.log(`Detected platform: ${platform}`);

        const configFilePath = await findConfigPath(rl, selectedClient, platform);

        if (!configFilePath) {
            console.error("Could not determine configuration file path. Exiting.");
            return; // Exit early if no path could be determined
        }

        console.log(`Using configuration file: ${configFilePath}`);

        await updateConfigFile(configFilePath, selectedClient ? selectedClient.tool : null);

    } finally {
        rl.close();
    }
}

main().catch(err => {
    console.error('An error occurred:', err);
    process.exit(1);
}); 