# MCPfinder 🔧🤖 (`@mcpfinder/server`)

A serverless platform for registering and discovering MCP (Model Context Protocol) tools.

## Overview

- **api-worker/**: Core REST API Worker for registration and discovery. Also provides MCP Server via HTTP/SSE transport at `/mcp` endpoint.
- **health-worker/**: Cron-triggered Worker to perform periodic health checks.
- **mcpfinder-www/**: Worker + static site for landing page and documentation (replacing `landingpage`).
- **mcpfinder-server/**: MCP Server providing tools for clients to find and manage other MCP servers via stdio transport (external submodule: [mcpfinder/server](https://github.com/mcpfinder/server)).
- **cli/**: Node.js-based CLI for publishers to register tools.
- **schemas/**: JSON Schema definitions for validating tool manifests.
- **mcp-inspector/**: Testing tool for both stdio and HTTP/SSE MCP variants (git submodule).

## Cloning

This repository uses Git submodules. To clone it correctly, including the `mcpfinder-server` submodule, use:

```bash
git clone --recursive git@github.com:lksrz/mcpfinder.git
cd mcpfinder
```

If you have already cloned the repository without the `--recursive` flag, you can initialize and update the submodules using:

```bash
git submodule update --init --recursive
```

## Folder Structure

```
/ (root)
├── api-worker/        # Core registry Worker code for REST API + MCP HTTP/SSE endpoint
├── health-worker/     # Cron-triggered Worker for health checks
├── mcpfinder-www/     # Worker + static site for landing page
│   ├── worker.js      # Worker to serve landing page
│   └── public/        # Static assets (HTML, CSS, images)
├── mcpfinder-server/  # MCP Server stdio variant (submodule -> mcpfinder/server)
├── mcp-inspector/     # MCP testing tool (submodule -> modelcontextprotocol/inspector)
├── cli/               # Publisher CLI implementation
│   └── bin/
│       └── mcp-cli.js # CLI entry
├── schemas/           # JSON schemas for manifest validation
├── .gitmodules        # Submodule configuration
└── README.md          # This file
```

## Quick Start

1.  **Clone the repository (including submodules):**
    ```bash
    git clone --recursive git@github.com:lksrz/mcpfinder.git
    cd mcpfinder
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Configure Workers:
    - Set `MCP_REGISTRY_SECRET` in your environment.
    - Update `wrangler.toml` files in each worker folder with KV/R2 bindings.

4.  Publish API Worker:
    ```bash
    cd api-worker
    npx wrangler deploy # Use npx to ensure correct version
    cd ..
    ```

5.  Publish Health Worker:
    ```bash
    cd health-worker
    npx wrangler deploy
    cd ..
    ```

6.  Publish Landing Page (`mcpfinder-www`):
    ```bash
    cd mcpfinder-www
    npx wrangler deploy
    cd ..
    ```

7.  Using the `mcpfinder-server`:
    The MCP Server is available in two transport variants:

    *   **Stdio Transport** (`./mcpfinder-server/index.js`):
        Default mode for local MCP clients (e.g., Cursor, Claude CLI):
        ```bash
        node ./mcpfinder-server/index.js
        ```
        
    *   **HTTP/SSE Transport** (API Worker `/mcp` endpoint):
        Web-accessible variant with Server-Sent Events support:
        ```bash
        # Start the api-worker locally
        cd api-worker && npm run dev
        # MCP endpoint available at: http://localhost:8787/mcp
        ```
        Configuration options available for both transports:
        *   `--api-url <url>`: Specify the MCP Finder Registry API URL (Default: `https://mcpfinder.dev` or `MCPFINDER_API_URL` env var).
            ```bash
            # For stdio transport
            node ./mcpfinder-server/index.js --api-url http://localhost:8787
            
            # For HTTP/SSE transport, configure in api-worker/wrangler.toml
            MCPFINDER_API_URL = "http://localhost:8787"
            ```

    *   **Execute Commands:**
        *   Interactive Setup (for users/AI clients to configure a client):
            ```bash
            node ./mcpfinder-server/index.js install
            ```
            (Aliases: `setup`, `init`)
        *   Register Server Package (for server publishers):
            ```bash
            node ./mcpfinder-server/index.js register
            ```
            (This requires appropriate environment variables like `MCPFINDER_API_URL` and `MCPFINDER_REGISTRY_SECRET` to be set for the registry interaction).

    *   **Display Help:**
        ```bash
        node ./mcpfinder-server/index.js --help
        ```

8.  Install `mcp-cli` globally (for `./cli/bin/mcp-cli.js`):
    ```bash
    # No longer a separate 'cli' package.json, use root:
    npm link # Links the bin specified in the root package.json
    ```

Now you can register a tool:

```bash
export MCPFINDER_API_URL='...' # e.g., http://localhost:8787 or deployed URL
export MCPFINDER_REGISTRY_SECRET='your-secret'
mcp-cli register path/to/mcp.json
```