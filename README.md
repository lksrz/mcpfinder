# MCP Finder (mcpfinder.dev)

A serverless platform for registering and discovering MCP (Model Context Protocol) tools.

## Overview

- **api-worker/**: Core REST API Worker for registration and discovery.
- **health-worker/**: Cron-triggered Worker to perform periodic health checks.
- **mcpfinder-www/**: Worker + static site for landing page and documentation (replacing `landingpage`).
- **mcpfinder-server/**: MCP Server providing tools for clients to find and manage other MCP servers (external submodule: [mcpfinder/server](https://github.com/mcpfinder/server)).
- **cli/**: Node.js-based CLI for publishers to register tools.
- **schemas/**: JSON Schema definitions for validating tool manifests.

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
├── api-worker/        # Core registry Worker code for REST API
├── health-worker/     # Cron-triggered Worker for health checks
├── mcpfinder-www/     # Worker + static site for landing page
│   ├── worker.js      # Worker to serve landing page
│   └── public/        # Static assets (HTML, CSS, images)
├── mcpfinder-server/  # MCP Server (submodule -> mcpfinder/server)
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

7.  (Optional) Run MCP Finder Server Locally:
    *   Stdio mode (for clients like Cursor):
        ```bash
        node ./mcpfinder-server/index.js
        ```
    *   HTTP mode:
        ```bash
        node ./mcpfinder-server/index.js --http [--port 6181] [--api-url <registry_api_url>]
        ```

8.  Install CLI globally:
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