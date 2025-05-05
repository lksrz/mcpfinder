# MCP Finder Server (`@mcpfinder/server`)

This Node.js application implements an MCP (Model Context Protocol) server designed to run locally alongside MCP clients (like Cursor, Claude Desktop, Windsurf). It provides tools that allow an AI assistant (LLM) within the client to interact with the MCP Finder ecosystem.

Specifically, it enables the AI assistant to:

1.  **Discover** available MCP servers registered in the central [MCP Finder Registry](https://mcpfinder.dev) (via `search_mcp_servers`).
2.  **Retrieve details** about specific servers (via `get_mcp_server_details`).
3.  **Manage** the client application's local MCP server configuration file (add/update via `add_mcp_server_config`, remove via `remove_mcp_server_config`).

**Note for AI Agents:** This server is your primary interface for finding and enabling new tools and capabilities requested by the user if they aren't already available in your current toolset. Always use `search_mcp_servers` first when asked for a capability you don't possess.

## Installation & Usage

Currently, the primary way to run this server is directly from the source code within the `mcpfinder` monorepo.

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/mcpfinder.git # Replace with actual repo URL
    cd mcpfinder
    ```
2.  **Install dependencies:**
    ```bash
    npm install # In the root directory
    ```
3.  **Run the server:**

    *   **Stdio Mode (Recommended for clients like Cursor/Claude/Windsurf):**
        ```bash
        node ./mcpfinder-server/index.js
        ```
        The server will communicate over standard input/output.

    *   **HTTP Mode (For direct testing or specific integrations):**
        ```bash
        node ./mcpfinder-server/index.js --http [--port 6181] [--api-url https://mcpfinder.dev]
        ```
        -   `--port <number>`: Specifies the port to listen on (default: 6181, or `MCP_PORT` env var).
        -   `--api-url <url>`: Specifies the MCP Finder Registry API URL (default: https://mcpfinder.dev, or `MCPFINDER_API_URL` env var).

## Configuration

The server uses the following environment variables:

*   `MCPFINDER_API_URL`: The base URL for the MCP Finder Registry API. Defaults to `https://mcpfinder.dev`. Set this if you are running a local instance of the registry API.
*   `MCP_PORT` (HTTP Mode Only): The port number for the server to listen on. Defaults to `6181`.

## Provided Tools

This MCP server exposes the following tools to the connected AI assistant:

---

### 1. `search_mcp_servers`

*   **Description:** Searches the MCP Finder Registry for available MCP servers. **This is the primary tool for discovering and accessing new tools, methods, features, or capabilities.** If a user asks for a tool, method, feature, or capability that you do not currently have, you **MUST** use this tool to search for it by relevant keywords. This is the required first step to expand your available tools.
*   **Input Schema:**
    *   `query` (string, optional): Keywords to search for in tool name or description.
    *   `tag` (string, optional): Specific tag to filter by.
*   **Output:** A list of matching server summaries (ID, name, description, URL, tags) and an instruction to use `add_mcp_server_config` to install one.

---

### 2. `get_mcp_server_details`

*   **Description:** Retrieves detailed information about a specific MCP server from the registry, including its full manifest and basic installation suggestions (command, environment variables). Use this after finding a server ID via `search_mcp_servers` to get more information before potentially adding it.
*   **Input Schema:**
    *   `id` (string, **required**): The unique MCPFinder ID of the MCP server.
*   **Output:** The detailed server manifest and installation hints, along with an instruction to use `add_mcp_server_config`.

---

### 3. `add_mcp_server_config`

*   **Description:** Adds or updates the configuration for a specific MCP server in the *client application's* local configuration file (e.g., Cursor's `~/.cursor/mcp.json`, Claude's `claude_desktop_config.json`). **Requires user permission via the client application before execution.** You must provide *either* `client_type` OR `config_file_path`.
*   **Input Schema:**
    *   `server_id` (string, **required**): A unique identifier for the server configuration entry (typically the MCPFinder ID obtained from search/details).
    *   `client_type` (string, optional): The type of client application (known types: `'cursor'`, `'claude'`, `'windsurf'`). Mutually exclusive with `config_file_path`. Use this for standard client installations.
    *   `config_file_path` (string, optional): Absolute path to the target JSON configuration file (e.g., `/path/to/custom/mcp.json`). Mutually exclusive with `client_type`. Use this for non-standard locations or custom clients. Include spaces literally if needed.
    *   `mcp_definition` (object, optional): Defines the server configuration.
        *   `command` (array of strings, optional): Command and arguments (e.g., `["npx", "-y", "my-mcp-package"]`). If omitted, defaults are fetched from the registry. If provided without `command` but with `env` or `workingDirectory`, the default command is fetched and merged.
        *   `env` (object, optional): Environment variables (e.g., `{"API_KEY": "YOUR_KEY"}`).
        *   `workingDirectory` (string, optional): The working directory for the server process.
*   **Output:** A success or error message.

---

### 4. `remove_mcp_server_config`

*   **Description:** Removes the configuration for a specific MCP server from the client application's local configuration file. **Requires user permission via the client application before execution.** You must provide *either* `client_type` OR `config_file_path`.
*   **Input Schema:**
    *   `server_id` (string, **required**): The unique identifier of the server configuration entry to remove.
    *   `client_type` (string, optional): The type of client application (known types: `'cursor'`, `'claude'`, `'windsurf'`). Mutually exclusive with `config_file_path`.
    *   `config_file_path` (string, optional): Absolute path to the target JSON configuration file. Mutually exclusive with `client_type`.
*   **Output:** A success or error message indicating whether the entry was found and removed.

---

## Security Considerations

The tools `add_mcp_server_config` and `remove_mcp_server_config` modify files on the user's local system. It is **CRITICAL** that the host MCP client application (e.g., Cursor, Claude Desktop, Windsurf) implements a robust permission system. The client **MUST** prompt the user for explicit approval before allowing this MCP server to execute these file modification tools. This server itself does not perform permission checks; it relies entirely on the calling client for security enforcement.

## Contributing

Please refer to the main project [CONTRIBUTING.md](../../CONTRIBUTING.md) (if available) for details on how to contribute.

## License

[Specify License Here - e.g., MIT, Apache 2.0] - Currently ISC as per package.json. 