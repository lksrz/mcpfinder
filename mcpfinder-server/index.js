#!/usr/bin/env node
// import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'; // OLD IMPORT
import { Server } from '@modelcontextprotocol/sdk/server/index.js'; // NEW IMPORT (like working examples)
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'; // Re-add HTTP Transport
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'; // ADDED Stdio Transport
// import { InMemoryEventStore } from '@modelcontextprotocol/sdk/server/eventStore.js'; // REMOVED: Import Event Store
import express from 'express'; // Re-add express
import { z } from 'zod';
import os from 'os';
import path from 'path';
import fs from 'fs/promises'; // Using promises API
import fetch from 'node-fetch'; // Import node-fetch
import { randomUUID } from 'node:crypto'; // Re-add for HTTP session IDs
// import { randomUUID } from 'node:crypto'; // REMOVED - Not needed for stdio
import { 
  isInitializeRequest, // Re-add for HTTP
  ListToolsRequestSchema, 
  CallToolRequestSchema,
  // Tool, // REMOVED - Type definition, not a runtime export
} from '@modelcontextprotocol/sdk/types.js'; // Removed List/Call schemas
// import { zodToJsonSchema } from 'zod-to-json-schema'; // REMOVED: No longer needed

// --- Configuration ---
// Default values
const DEFAULT_PORT = 6181;
const DEFAULT_API_URL = 'https://mcpfinder.dev';

// --- Global state for server/transport (needed for shutdown) ---
let runningHttpServer = null;
// let activeTransports = {}; // REMOVED - Single transport used in HTTP mode
let httpTransportInstance = null; // Store the single HTTP transport instance
let serverInstance = null; // To hold the core Server instance

// --- Help Text ---
const helpText = `
MCP Finder Server

Manages local MCP configurations for clients like Cursor and Claude.
Communicates with the MCP Finder Registry API (https://mcpfinder.dev/api).

Usage: node index.js [options]

Options:
  --http            Run the server in HTTP mode.
                    NOTE: This mode may have compatibility issues with clients like
                    Cursor/Claude Desktop expecting Stdio. Primarily for direct
                    testing (e.g., with mcp-cli) or specific use cases.
                    Default is Stdio mode (recommended for Cursor/Claude).
  --port <number>   Port for HTTP mode (overrides MCP_PORT env var).
                    Default: ${DEFAULT_PORT}
  --api-url <url>   URL of the MCP Finder Registry API 
                    (overrides MCPFINDER_API_URL env var).
                    Default: ${DEFAULT_API_URL}
  --help            Display this help message.

Environment Variables:
  MCP_PORT           Port for HTTP mode (default: ${DEFAULT_PORT}).
  MCPFINDER_API_URL  URL of the MCP Finder Registry API (default: ${DEFAULT_API_URL}).
`;

// --- Argument Parsing ---
const args = process.argv.slice(2);
const runHttp = args.includes('--http');
const showHelp = args.includes('--help');

function getArgValue(argName) {
    const index = args.indexOf(argName);
    if (index !== -1 && index + 1 < args.length) {
        return args[index + 1];
    }
    return null;
}

const cliPort = getArgValue('--port');
const cliApiUrl = getArgValue('--api-url');

if (showHelp) {
  console.log(helpText);
  process.exit(0);
}

// --- Determine Final Configuration ---
const PORT = cliPort ? parseInt(cliPort, 10) : (process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : DEFAULT_PORT);
const MCPFINDER_API_URL = cliApiUrl || process.env.MCPFINDER_API_URL || DEFAULT_API_URL;

// Validate Port
if (isNaN(PORT) || PORT <= 0 || PORT > 65535) {
    console.error(`Invalid port number specified: ${cliPort || process.env.MCP_PORT}. Using default ${DEFAULT_PORT}.`);
    PORT = DEFAULT_PORT; // Fallback to default if parsing failed or value is invalid
}

console.error(`Using MCP Finder API URL: ${MCPFINDER_API_URL}`);
if (runHttp) {
    console.error(`Running in HTTP mode on port ${PORT}`);
} else {
    console.error("Running in Stdio mode");
}

// --- Tool Schemas (Zod for internal validation) ---
const SearchServersInput = z.object({
  query: z.string().optional().describe("Keywords to search for in tool name or description."),
  tag: z.string().optional().describe("Specific tag to filter by."),
});

const GetServerDetailsInput = z.object({
  id: z.string().min(1).describe("The unique ID of the MCP server."), // Use min(1) to ensure non-empty
});

// Allow any string for client type, or an absolute path
const ClientIdentifierSchema = z.union([
  z.object({
    client_type: z.string().describe("The type or name of the client application (e.g., 'cursor', 'claude', 'windsurf')."),
    config_file_path: z.undefined(), // Must be undefined if client_type is used
  }),
  z.object({
    client_type: z.undefined(), // Must be undefined if config_file_path is used
    config_file_path: z.string().describe("Absolute path to the MCP JSON configuration file. Use this for custom clients or non-standard locations. Path should include spaces literally, no shell escaping needed."),
  })
], {
  // Custom error message for the union
  errorMap: (issue, ctx) => {
    if (issue.code === z.ZodIssueCode.invalid_union) {
        // Check if the input had *both* properties defined, which is a common error case here
        if (ctx.data?.client_type !== undefined && ctx.data?.config_file_path !== undefined) {
            return { message: "Invalid input: Provide either 'client_type' OR 'config_file_path', but not both." };
        }
        // Default union error for other cases (e.g., neither provided)
        return { message: "Invalid input: Provide either 'client_type' OR 'config_file_path'." };
    }
    // Fallback to default error reporting for other issue types
    return { message: ctx.defaultError };
  }
}).describe("Specify the target configuration either by client_type (for known clients) or an absolute config_file_path.");

const AddServerConfigInput = z.object({
  server_id: z.string().describe("A unique identifier for the server configuration entry."),
  mcp_definition: z.object({
    command: z.array(z.string()).optional().describe("The command and arguments to run the server. If omitted when env/workingDir provided, defaults will be fetched."),
    env: z.record(z.string()).optional().describe("Environment variables required by the server."),
    workingDirectory: z.string().optional().describe("The working directory for the server."),
  }).describe("The MCP server definition object. If omitted, defaults are fetched. If provided without 'command', defaults are merged.").optional(),
}).and(ClientIdentifierSchema); // Combine with the client identifier union

const RemoveServerConfigInput = z.object({
  server_id: z.string().describe("The unique identifier of the server configuration entry to remove."),
}).and(ClientIdentifierSchema); // Combine with the client identifier union

// --- Tool Implementations ---

async function search_mcp_servers(input) {
  console.error('[search_mcp_servers] Received input:', input);
  const searchUrl = new URL(`${MCPFINDER_API_URL}/api/v1/search`);
  if (input.query) {
    searchUrl.searchParams.append('q', input.query);
  }
  if (input.tag) {
    searchUrl.searchParams.append('tag', input.tag);
  }
  console.error(`[search_mcp_servers] Fetching URL: ${searchUrl.toString()}`);
  try {
    const response = await fetch(searchUrl.toString());
    console.error(`[search_mcp_servers] Received status: ${response.status}`);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[search_mcp_servers] API request failed with status ${response.status}: ${errorText}`);
      throw new Error(`Failed to fetch from MCP Finder API: ${response.statusText}`);
    }
    const data = await response.json(); // Use await response.json() directly
    console.error('[search_mcp_servers] Parsed data:', data);
    const formattedContent = data.map(server => ({
      type: 'text',
      text: `ID: ${server.id}\nName: ${server.name}\nDescription: ${server.description}\nURL: ${server.url}\nTags: ${server.tags.join(', ')}`
    }));
    
    // Add instruction for LLM
    const instructionBlock = { 
      type: 'text', 
      text: "Use the 'add_mcp_server_config' tool with one of the listed server IDs to add it to the client's configuration." 
    };

    console.error('[search_mcp_servers] Returning formatted text content blocks and instruction:', { content: [...formattedContent, instructionBlock] });
    // Return structure for CallToolResult including the instruction
    return { content: [...formattedContent, instructionBlock] }; 

  } catch (error) {
    console.error('[search_mcp_servers] Error during fetch or processing:', error);
    // Return error structure for CallToolResult
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
}

async function get_mcp_server_details(input) {
  console.error('[get_mcp_server_details] Function called. Received input:', input);

  // Validation will happen in the callToolHandler 

  console.error('Getting details for MCP server:', input.id);
  const url = `${MCPFINDER_API_URL}/api/v1/tools/${input.id}`;
  console.error(`Fetching from: ${url}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
        if (response.status === 404) {
            throw new Error(`Server with ID ${input.id} not found.`);
        }
        const errorText = await response.text();
        console.error(`API Error getting details (${response.status}): ${errorText}`);
        throw new Error(`Failed to get MCP server details: ${response.statusText}`);
    }
    const manifest = await response.json();
    let installationDetails = {
        command: [], env: {}, workingDirectory: undefined,
    };
    try {
        // Original logic attempting inference (will be moved to api-worker)
        if (manifest.url && !manifest.url.startsWith('http') && manifest.url.includes('/')) {
             installationDetails.command = ['npx', '-y', manifest.url];
        } else if (manifest.url && manifest.url.startsWith('http')) {
             console.warn(`[get_mcp_server_details] Cannot reliably determine command for URL-based server: ${manifest.url}`);
        }
        if (manifest.auth && manifest.auth.type === 'api-key') {
            const envVarName = `${manifest.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_API_KEY`;
            installationDetails.env[envVarName] = `YOUR_${envVarName}`; 
             console.error(`[get_mcp_server_details] Detected API key auth. Suggesting env var: ${envVarName}`);
        }
    } catch (e) {
        console.error("[get_mcp_server_details] Error constructing installation details from manifest:", e);
    }
    // Return structure for CallToolResult - Format nicely
    const details = { ...manifest, installation: installationDetails };
    const detailsBlock = { type: 'text', text: JSON.stringify(details, null, 2) };
    
    // Add instruction for LLM
    const instructionBlock = { 
      type: 'text', 
      text: `You can use the 'add_mcp_server_config' tool with server_id '${input.id}' to add this server to the client's configuration. Optionally provide command/env/workingDirectory, or let the tool fetch defaults.` 
    };

    return { 
      content: [detailsBlock, instructionBlock] 
    }; 

  } catch (error) {
      console.error('Error fetching tool details:', error);
      // Return error structure for CallToolResult
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true }; 
  }
}

// --- File Utils ---
async function getConfigPath(clientType) {
    const homeDir = os.homedir();
    switch (clientType) {
        case 'cursor':
            return path.join(homeDir, '.cursor', 'mcp.json');
        case 'claude':
            if (process.platform === 'darwin') {
                 return path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
            } else if (process.platform === 'win32') {
                 return path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
            } else {
                return path.join(homeDir, '.config', 'Claude', 'claude_desktop_config.json');
            }
        case 'windsurf':
            return path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json');
        default:
            // For unknown client types, require an absolute path via config_file_path
            throw new Error(`Unsupported client type for automatic path resolution: '${clientType}'. Please provide an absolute 'config_file_path' instead.`);
    }
}

// Returns default {} if file not found, throws specific error for bad JSON/read errors.
async function readConfigFile(filePath) { 
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        try {
            return JSON.parse(data);
        } catch (parseError) {
            console.error(`Error parsing JSON from config file ${filePath}:`, parseError);
            throw new Error(`Failed to parse JSON configuration file: ${filePath}. Invalid content.`);
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
             // If file doesn't exist, treat it as empty config.
             console.warn(`Config file not found at ${filePath}, returning default structure.`);
             return { mcpServers: {} };
        }
        // For other errors (e.g., permissions), re-throw
        console.error(`Error reading config file ${filePath}:`, error);
        throw new Error(`Failed to read config file: ${error.message}`); 
    }
}

async function writeConfigFile(filePath, config) {
    try {
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true }); 
        await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
        console.error(`Successfully wrote config to ${filePath}`);
    } catch (error) {
        console.error(`Error writing config file ${filePath}:`, error);
        throw new Error(`Failed to write config file: ${error.message}`);
    }
}


async function add_mcp_server_config(input) {
  console.error('[add_mcp_server_config] Function called. Received input:', JSON.stringify(input));

  // Security Note: This function modifies local files based on LLM input.
  // The client application (Cursor, Claude Desktop) *MUST* implement
  // permission prompts before allowing this tool to execute.

  const { server_id, mcp_definition, client_type, config_file_path } = input;
  let configPath;

  try {
    if (config_file_path) {
      // Use absolute path if provided
      console.error(`[add_mcp_server_config] Using provided config file path: ${config_file_path}`);
      configPath = config_file_path;
      // Basic check: Ensure it's an absolute path (though could be more robust)
      if (!path.isAbsolute(configPath)) {
          throw new Error(`Provided 'config_file_path' must be absolute: ${configPath}`);
      }
    } else if (client_type) {
      // Resolve path based on known client type
      console.error(`[add_mcp_server_config] Resolving config path for client type: ${client_type}`);
      configPath = await getConfigPath(client_type);
      console.error(`[add_mcp_server_config] Resolved config path: ${configPath}`);
    } else {
        // This case should technically be prevented by the Zod schema union
        throw new Error("Invalid input: Either 'client_type' or 'config_file_path' must be provided.");
    }

    console.error(`[add_mcp_server_config] Reading config file: ${configPath}`);
    // Read config file (will return {} if not found)
    const config = await readConfigFile(configPath);

    let finalMcpDefinition = {};

    if (mcp_definition) {
      // If definition is provided, use it (potentially merging later)
      finalMcpDefinition = { ...mcp_definition };
      console.error('[add_mcp_server_config] MCP definition provided by user:', finalMcpDefinition);

      // If command is missing, fetch defaults and merge
      if (!finalMcpDefinition.command || finalMcpDefinition.command.length === 0) {
        console.error(`[add_mcp_server_config] Command missing in provided definition for ${server_id}. Fetching defaults...`);
        const detailsUrl = `${MCPFINDER_API_URL}/api/v1/tools/${server_id}`;
        const detailsResponse = await fetch(detailsUrl);
        if (!detailsResponse.ok) {
          throw new Error(`Failed to fetch default details for server ${server_id}: ${detailsResponse.statusText}`);
        }
        const detailsData = await detailsResponse.json();
        // Prefer fetched command/args if available in manifest's installation hint
        const fetchedCommand = detailsData?.installation?.command;
        if (fetchedCommand && fetchedCommand.length > 0) {
            finalMcpDefinition.command = fetchedCommand;
            console.error(`[add_mcp_server_config] Merged default command: ${fetchedCommand.join(' ')}`);
        } else {
            console.warn(`[add_mcp_server_config] No default command found in fetched details for ${server_id}. Definition might be incomplete.`);
        }
        // Merge env vars and working dir if not provided by user
        finalMcpDefinition.env = { ...(detailsData?.installation?.env || {}), ...(finalMcpDefinition.env || {}) };
        finalMcpDefinition.workingDirectory = finalMcpDefinition.workingDirectory || detailsData?.installation?.workingDirectory;
        console.error(`[add_mcp_server_config] Merged env/workingDir with defaults. Final env:`, finalMcpDefinition.env);
        console.error(`[add_mcp_server_config] Merged env/workingDir with defaults. Final workingDir:`, finalMcpDefinition.workingDirectory);
      }
    } else {
      // If no definition provided, fetch defaults completely
      console.error(`[add_mcp_server_config] No MCP definition provided for ${server_id}. Fetching defaults...`);
      const detailsUrl = `${MCPFINDER_API_URL}/api/v1/tools/${server_id}`;
      const detailsResponse = await fetch(detailsUrl);
      if (!detailsResponse.ok) {
        throw new Error(`Failed to fetch default details for server ${server_id}: ${detailsResponse.statusText}`);
      }
      const detailsData = await detailsResponse.json();
      finalMcpDefinition = detailsData?.installation || { command: [], env: {}, workingDirectory: undefined };
      console.error('[add_mcp_server_config] Using fetched default definition:', finalMcpDefinition);
       if (!finalMcpDefinition.command || finalMcpDefinition.command.length === 0) {
            console.warn(`[add_mcp_server_config] No command found in fetched default details for ${server_id}. Definition might be incomplete.`);
       }
    }

    // Ensure mcpServers key exists
    if (!config.mcpServers) {
        config.mcpServers = {};
    }

    // *** START CLIENT COMPATIBILITY FORMATTING ***
    if (Array.isArray(finalMcpDefinition.command) && finalMcpDefinition.command.length > 0) {
      const originalCommandArray = [...finalMcpDefinition.command]; // Keep original
      delete finalMcpDefinition.args; // Ensure args is not present unless specifically set for Cursor

      if (client_type === 'claude') {
        // Claude: Join command array into a single string
        console.warn(`[add_mcp_server_config] Formatting command for Claude: Joining array into string.`);
        finalMcpDefinition.command = originalCommandArray.join(' ');
        console.warn(`[add_mcp_server_config] Claude formatted command: "${finalMcpDefinition.command}"`);
      } else if (client_type === 'cursor') {
        // Cursor: Separate command string and args array
        console.warn(`[add_mcp_server_config] Formatting command for Cursor: Separating command and args.`);
        finalMcpDefinition.command = originalCommandArray[0]; // First element is command
        finalMcpDefinition.args = originalCommandArray.slice(1); // Rest are args
        console.warn(`[add_mcp_server_config] Cursor formatted command: "${finalMcpDefinition.command}", args: ${JSON.stringify(finalMcpDefinition.args)}`);
      } else {
        // Default/Other: Keep the original command array format
        console.log(`[add_mcp_server_config] Using default command array format for client type '${client_type || 'custom path'}'.`);
        finalMcpDefinition.command = originalCommandArray; // Ensure it stays an array
      }
    } else if (client_type === 'cursor') {
        // Handle case where command might not be an array but client is cursor - ensure args is absent or empty
        delete finalMcpDefinition.args;
    }
    // *** END CLIENT COMPATIBILITY FORMATTING ***

    // Add or update the server entry
    config.mcpServers[server_id] = finalMcpDefinition;
    console.error(`[add_mcp_server_config] Updated config object:`, JSON.stringify(config, null, 2)); // Pretty print for review

    console.error(`[add_mcp_server_config] Writing updated config to: ${configPath}`);
    await writeConfigFile(configPath, config);

    let successMessage = `Successfully added/updated server configuration for '${server_id}' in ${configPath}.`;

    // Add restart note for Claude or custom paths
    if (client_type === 'claude' || config_file_path) {
      successMessage += ' You may need to restart the client application for the new server to be available.';
    }

    console.error(`[add_mcp_server_config] ${successMessage}`);
    return { content: [{ type: 'text', text: successMessage }] };

  } catch (error) {
    console.error('[add_mcp_server_config] Error:', error);
    return { content: [{ type: 'text', text: `Error adding/updating server config: ${error.message}` }], isError: true };
  }
}

async function remove_mcp_server_config(input) {
  console.error('[remove_mcp_server_config] Function called. Received input:', JSON.stringify(input));

  // Security Note: Needs client-side permission prompt.

  const { server_id, client_type, config_file_path } = input;
  let configPath;

  try {
    if (config_file_path) {
      // Use absolute path if provided
      console.error(`[remove_mcp_server_config] Using provided config file path: ${config_file_path}`);
      configPath = config_file_path;
       // Basic check: Ensure it's an absolute path
       if (!path.isAbsolute(configPath)) {
          throw new Error(`Provided 'config_file_path' must be absolute: ${configPath}`);
      }
    } else if (client_type) {
      // Resolve path based on known client type
      console.error(`[remove_mcp_server_config] Resolving config path for client type: ${client_type}`);
      configPath = await getConfigPath(client_type);
      console.error(`[remove_mcp_server_config] Resolved config path: ${configPath}`);
    } else {
      // Should be prevented by Zod schema
       throw new Error("Invalid input: Either 'client_type' or 'config_file_path' must be provided.");
    }

    console.error(`[remove_mcp_server_config] Reading config file: ${configPath}`);
    // Read config file (will return {} if not found)
    const config = await readConfigFile(configPath);

    let removed = false;
    if (config.mcpServers && config.mcpServers[server_id]) {
      console.error(`[remove_mcp_server_config] Found server entry for '${server_id}'. Removing...`);
      delete config.mcpServers[server_id];
      removed = true;
      console.error(`[remove_mcp_server_config] Writing updated config to: ${configPath}`);
      await writeConfigFile(configPath, config);
    } else {
      console.warn(`[remove_mcp_server_config] Server configuration for '${server_id}' not found in ${configPath}. No changes made.`);
    }

    const successMessage = removed ? `Successfully removed server configuration for '${server_id}' from ${configPath}.` : `Server configuration for '${server_id}' not found in ${configPath}.`;
    console.error(`[remove_mcp_server_config] ${successMessage}`);
    return { content: [{ type: 'text', text: successMessage }] };

  } catch (error) {
    console.error('[remove_mcp_server_config] Error:', error);
    return { content: [{ type: 'text', text: `Error removing server config: ${error.message}` }], isError: true };
  }
}


// --- MCP Server Setup ---

// const transports = {}; // REMOVED - No session management needed for stdio

// --- Tool Definitions (using Tool type from SDK) ---

const SearchMcpServersTool = {
  name: 'search_mcp_servers',
  description: `This is the primary tool for discovering and accessing new tools, methods, features, or capabilities. **If a user asks for a tool, method, feature, or capability that you do not currently have, you MUST use this tool to search for it in the MCP Finder registry.** For example, if a user asks for an "echo" tool, OCR, file upload, PDF parsing, or any other capability not present in your current toolset, use this tool to search by relevant keywords. This is the required first step to expand your available tools.`,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords to search for in tool name or description." },
      tag: { type: "string", description: "Specific tag to filter by." },
    },
    required: [],
  }
};

const GetMcpServerDetailsTool = {
  name: 'get_mcp_server_details',
  description: 'Retrieves detailed information about a specific MCP server/tool from the registry, including its manifest and potential installation details. Use this after finding a tool with search_mcp_servers to get more info.',
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The unique MCPFinder ID of the MCP server." },
    },
    required: ["id"], // Explicitly required
  }
};

// Reverted to simpler JSON Schema to avoid client misinterpretation of oneOf.
// Runtime validation is still handled correctly by Zod.
const AddMcpServerConfigTool = {
  name: 'add_mcp_server_config',
  description: "Adds or updates the configuration for a specific MCP server/tool in the client application (e.g., Cursor, Claude). Provide EITHER client_type OR config_file_path to specify the target config file.",
  inputSchema: {
    type: "object",
    properties: {
      client_type: { type: "string", description: "The type of client application (e.g., 'cursor', 'claude'). Mutually exclusive with config_file_path." }, // Optional in schema
      config_file_path: { type: "string", description: "Absolute path to the config file (include spaces literally, no shell escaping). Mutually exclusive with client_type." }, // Optional in schema
      server_id: { type: "string", description: "A unique identifier for the server configuration entry." },
      mcp_definition: {
        type: "object",
        properties: {
          command: { type: "array", items: { type: "string" }, description: "The command and arguments to run the server. If omitted, defaults are fetched/merged." },
          env: { type: "object", additionalProperties: { type: "string" }, description: "Environment variables required by the server (e.g. API keys)." },
          workingDirectory: { type: "string", description: "The working directory for the server." }
        },
        description: "The MCP server definition object. Optional."
      }
    },
    required: ["server_id"] // Only server_id is strictly required by the schema
    // oneOf removed - Zod handles the client_type/config_file_path choice at runtime
  }
};

// Reverted to simpler JSON Schema.
const RemoveMcpServerConfigTool = {
  name: 'remove_mcp_server_config',
  description: "Removes the configuration for a specific MCP server/tool from the client application (e.g., Cursor, Claude). Provide EITHER client_type OR config_file_path to specify the target config file.",
  inputSchema: {
    type: "object",
    properties: {
      client_type: { type: "string", description: "The type of client application (e.g., 'cursor', 'claude'). Mutually exclusive with config_file_path." }, // Optional in schema
      config_file_path: { type: "string", description: "Absolute path to the config file (include spaces literally, no shell escaping). Mutually exclusive with client_type." }, // Optional in schema
      server_id: { type: "string", description: "The unique identifier of the server configuration entry to remove." }
    },
    required: ["server_id"] // Only server_id is strictly required by the schema
     // oneOf removed - Zod handles the client_type/config_file_path choice at runtime
  }
};

// Array of all defined tools
const allTools = [
  SearchMcpServersTool,
  GetMcpServerDetailsTool,
  AddMcpServerConfigTool,
  RemoveMcpServerConfigTool,
];

// Map tool names to their implementations
const toolImplementations = {
  search_mcp_servers: search_mcp_servers,
  get_mcp_server_details: get_mcp_server_details,
  add_mcp_server_config: add_mcp_server_config,
  remove_mcp_server_config: remove_mcp_server_config,
};

// --- MCP Server Instance Creation (Common) ---
function createServerInstance() {
    return new Server({
        name: 'mcpfinder-server',
        version: '0.1.0',
    }, {
        capabilities: {
            tools: {}
        },
        debug: true,
    });
}

// --- Request Handlers Setup (Common) ---
function setupRequestHandlers(server) {
    // Store Zod schemas for internal validation
    const toolSchemas = {
      search_mcp_servers: SearchServersInput,
      get_mcp_server_details: GetServerDetailsInput,
      add_mcp_server_config: AddServerConfigInput,
      remove_mcp_server_config: RemoveServerConfigInput,
    };

    // Store handlers
    const toolHandlers = {
      search_mcp_servers,
      get_mcp_server_details,
      add_mcp_server_config,
      remove_mcp_server_config,
    };

    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      console.error('Received ListToolsRequest', request);
      return { tools: allTools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      console.error('Received CallToolRequest', request);
      const name = request.params.name;
      const toolArgs = request.params.arguments;
      const toolImplementation = toolHandlers[name];
      const zodSchema = toolSchemas[name];

      if (!toolImplementation || !zodSchema) {
        console.error(`Tool implementation or Zod schema not found for: ${name}`);
        return {
          content: [{ type: 'text', text: `Unknown tool or missing schema: ${name}` }],
          isError: true
        };
      }

      console.error('Received tool arguments:', toolArgs);
      const parsedArgs = zodSchema.safeParse(toolArgs);
      if (!parsedArgs.success) {
        console.error(`Invalid arguments for tool ${name}:`, parsedArgs.error.errors);
        return {
          content: [{ type: 'text', text: `Invalid arguments: ${parsedArgs.error.message}` }],
          isError: true,
        };
      }

      try {
        const result = await toolImplementation(parsedArgs.data);
        console.error(`[CallToolRequestSchema] Raw result for tool ${name}:`, result);
        return result;
      } catch (error) {
        console.error(`Error executing tool ${name}:`, error);
        return {
          content: [{ type: 'text', text: `Error executing tool ${name}: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    });
}

// --- Stdio Mode Start Function ---
async function startStdioServer() {
    console.error("Initializing MCP Finder Server in Stdio mode...");
    serverInstance = createServerInstance();
    setupRequestHandlers(serverInstance);

    const transport = new StdioServerTransport();

    transport.onclose = () => {
        console.error("Stdio transport closed. Exiting.");
        process.exit(0);
    };

    try {
        await serverInstance.connect(transport);
        console.error("🚀 MCP Finder Server (Stdio Transport) connected and ready.");
        console.error("   Waiting for MCP requests via stdin...");
        // Log registered tools using the server's internal state
        console.error('Registered Tools:', Object.keys(toolImplementations)); 
        console.error();
        console.error('--- NOTE ---');
        console.error('This server manages local MCP configurations for clients like Cursor, Claude or Windsurf.');
        console.error(`Search/Get details tools query the MCP Finder Registry API at ${MCPFINDER_API_URL}`);
        console.error('------------');
        console.error();
    } catch (error) {
        console.error("!!! Failed to connect server to stdio transport:", error);
        process.exit(1);
    }
}

// --- HTTP Mode Start Function ---
async function startHttpServer() {
    console.error("Initializing MCP Finder Server in HTTP mode...");
    serverInstance = createServerInstance();
    setupRequestHandlers(serverInstance);

    // --- Create the single HTTP transport instance --- 
    httpTransportInstance = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(), // Transport handles session IDs
        // onsessioninitialized is optional if we don't need to track sessions externally
    });

    // Connect the server to the transport *once*
    try {
        await serverInstance.connect(httpTransportInstance);
        console.error('MCP Server connected to HTTP transport.');
    } catch (error) {
        console.error("!!! Failed to connect server to HTTP transport:", error);
        process.exit(1);
    }
    // --- End Transport Setup ---

    const app = express();
    app.use(express.json());

    // MCP Endpoint - SIMPLIFIED: Delegate directly to transport
    app.all('/mcp', async (req, res) => {
      console.error(`<- ${req.method} ${req.originalUrl}`); // Log request method/path
      try {
        // Let the transport handle the request, including handshake & sessions
        await httpTransportInstance.handleRequest(req, res, req.body);
        // Transport handles sending responses, so no further action needed here usually
        console.error(`-> ${req.method} ${req.originalUrl} - Handled by transport`);
      } catch (error) {
        console.error(`!!! Error during transport.handleRequest for ${req.method} ${req.originalUrl}:`, error);
        if (!res.headersSent) {
          // Send a generic error if the transport failed to handle it
          res.status(500).json({ error: 'Internal server error processing MCP request via transport' });
        }
      }
    });

    // Start Listening (using determined PORT)
    console.error("Attempting to start HTTP server...");
    runningHttpServer = app.listen(PORT, () => {
      console.error("Server successfully started listening.");
      console.error(`🚀 MCP Finder Server (HTTP Transport) listening on port ${PORT}`);
      console.error(`   MCP Endpoint: http://localhost:${PORT}/mcp`);
      // Log registered tools using the server's internal state
      console.error('Registered Tools:', Object.keys(toolImplementations)); 
      console.error();
      console.error('--- NOTE ---');
      console.error('This server manages local MCP configurations for clients like Cursor, Claude or Windsurf.');
      console.error('Tools modifying files (add/remove_mcp_server_config) rely on the *calling client* to obtain user permission FIRST.');
      console.error(`Search/Get details tools query the MCP Finder Registry API at ${MCPFINDER_API_URL}.`);
      console.error(`Ensure the API worker (api-worker) is running locally if MCPFINDER_API_URL is set to localhost, otherwise uses ${DEFAULT_API_URL}.`);
      console.error('------------');
      console.error();
    });

    runningHttpServer.on('error', (error) => {
      // Check for specific port-in-use error
      if (error.code === 'EADDRINUSE') {
        console.error(`\n!!! Failed to start HTTP server: Port ${PORT} is already in use.`);
        console.error(`    Another application might be running on this port.`);
        console.error(`    Try stopping the other application or use a different port via the --port option.`);
        console.error(`    Example: node index.js --http --port ${PORT + 1}\n`);
      } else {
        // Log other types of errors
        console.error("!!! Failed to start HTTP server:", error);
      }
      process.exit(1);
    });

    console.error("HTTP server listen command issued. Waiting for server to start...");
}

// --- Graceful Shutdown Handler (Mode Aware) ---
async function shutdown() {
    console.error();
    console.error('Received shutdown signal...');

    if (runHttp) {
        console.error('Shutting down HTTP server and transport...');

        // --- Close the single HTTP transport --- 
        if (httpTransportInstance) {
            try {
                console.error('Closing HTTP transport...');
                await httpTransportInstance.close();
                console.error('HTTP transport closed.');
            } catch (transportError) {
                console.error('Error closing HTTP transport:', transportError);
            }
        }
        // --- End Transport Close --- 

        // Close the HTTP server itself
        if (runningHttpServer) {
             console.error('Closing HTTP server...');
            runningHttpServer.close((err) => {
                if (err) {
                    console.error('Error closing HTTP server:', err);
                } else {
                    console.error('HTTP server closed.');
                }
                // Exit after attempting to close server
                process.exit(err ? 1 : 0);
            });
            // Force exit after timeout if server doesn't close gracefully
            setTimeout(() => {
                console.error('HTTP shutdown timeout exceeded, forcing exit.');
                process.exit(1);
            }, 5000);
        } else {
             process.exit(0); // No HTTP server was running
        }
    } else {
        console.error('Exiting MCP server (stdio)...');
        // Stdio transport closes automatically or via its onclose handler
        process.exit(0);
    }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Main Execution --- 
if (runHttp) {
    startHttpServer();
} else {
    startStdioServer();
}
