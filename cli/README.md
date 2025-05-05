# MCP Finder CLI Tools

This directory contains command-line tools for interacting with the MCP Finder ecosystem and MCP servers.

## Scripts

### `introspect_servers.js`

**Purpose:** This script reads a list of potential MCP server packages from `npm_mcp_search_results.json`, attempts to connect to each one using `npx`, introspects their capabilities (primarily `listTools`), and updates the `processed` status and any errors directly within the `npm_mcp_search_results.json` file. If introspection is successful and the `MCPFINDER_REGISTRY_SECRET` environment variable is set, it generates a basic manifest and attempts to register the server using `mcp-cli.js`.

**Input File:**

*   `npm_mcp_search_results.json`: Contains an object with a `packages` array. Each package object should have at least a `package.name` field and a `processed` status (0: unprocessed, 1: not MCP, 2: failed, 3: success). This script reads this file and updates it in place.

**Usage:**

1.  Ensure you have run `npm install` in the root directory of the `mcpfinder` project to install dependencies (including `@modelcontextprotocol/sdk`).
2.  Ensure the `npm_mcp_search_results.json` file exists in the project root.
3.  (Optional) Set the `MCPFINDER_REGISTRY_SECRET` environment variable if you want the script to attempt registration of successfully introspected servers.
4.  Run the script from the **root** directory of the `mcpfinder` project:

    ```bash
    # Introspects packages from npm_mcp_search_results.json, updates the file,
    # and attempts registration if MCPFINDER_REGISTRY_SECRET is set.
    node ./cli/introspect_servers.js
    ```

5.  The script will attempt to launch each server package using `npx`. It connects via stdio, attempts to list tools, and updates the `processed` status in `npm_mcp_search_results.json`.
6.  Check the console for progress and errors.

**Note:** This script relies on `npx` to find and execute the server packages. Ensure the packages are published or linked appropriately.

### `mcp-cli.js`

**Purpose:** Allows developers to register their MCP server manifests with the MCP Finder Registry API.

**Usage:** See `DOCS.md` in the project root for detailed usage instructions.

   ```bash
   # Example (after npm link or global install)
   export MCPFINDER_REGISTRY_SECRET='your-secret'
   mcp-cli register /path/to/your/mcp.json
   ``` 