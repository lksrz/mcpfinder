# MCP Finder (mcpfinder.dev)

A serverless platform for registering and discovering MCP (Model Context Protocol) tools.

## Overview

- **api-worker/**: Core REST API Worker for registration and discovery.
- **health-worker/**: Cron-triggered Worker to perform periodic health checks.
- **landingpage/**: Worker + static site that serves the landing page and documentation.
- **cli/**: Node.js-based CLI for publishers to register tools.
- **schemas/**: JSON Schema definitions for validating tool manifests.

## Folder Structure

```
/ (root)
├── api-worker/        # Core registry Worker code for REST API
├── health-worker/     # Cron-triggered Worker for health checks
├── landingpage/       # Worker + static site for landing page
│   ├── worker.js      # Worker to serve landing page
│   └── public/        # Static assets (HTML, CSS, images)
├── cli/               # Publisher CLI implementation
│   └── bin/
│       └── mcp-cli.js # CLI entry
├── schemas/           # JSON schemas for manifest validation
└── README.md          # This file
```

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure Workers:
   - Set `MCP_REGISTRY_SECRET` in your environment.
   - Update `wrangler.toml` files in each worker folder with KV/R2 bindings.

3. Publish API Worker:
   ```bash
   cd api-worker
   wrangler publish
   ```

4. Publish Health Worker:
   ```bash
   cd ../health-worker
   wrangler publish
   ```

5. Publish Landing Page:
   ```bash
   cd ../landingpage
   wrangler publish
   ```

6. Install CLI globally:
   ```bash
   cd ../cli
   npm link
   ```

Now you can register a tool:

```bash
mcp-cli register path/to/mcp.json
```