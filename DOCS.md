# MCP Finder Documentation

## Overview

MCP Finder (mcpfinder.dev) is a platform designed to facilitate the discovery and management of MCP (Model Context Protocol) servers. It consists of several core components:

1.  **Registry API (`api-worker`)**: A serverless REST API backend where developers can register their MCP servers using a CLI tool. This API serves as the central database for discoverable MCP servers.
2.  **Landing Page (`mcpfinder-www`)**: A static website providing project information, documentation for the Registry API, CLI usage instructions, and potentially a searchable directory of registered servers.
3.  **MCP Server (`mcpfinder-server`)**: An MCP server designed to run locally alongside MCP clients (like Cursor, Claude Desktop). It exposes tools to the LLM within the client, enabling it to search the Registry API and manage the client's local MCP server configuration. **This component is maintained in a separate public repository ([mcpfinder/server](https://github.com/mcpfinder/server)) and included here as a Git submodule.**
4.  **CLI (`cli/`)**: A command-line tool for developers to register their MCP servers with the Registry API.
5.  **Health Checks (`health-worker`)**: A cron-triggered worker for monitoring the status of registered servers (planned).

MCP Finder aims to streamline the process for users and LLM agents to find, configure, and utilize MCP servers within their preferred applications.

The platform provides:

- **Tool registration** via a CLI and the Registry REST API
- **Tool discovery** via the Registry REST API (used by the MCP Server Manager and potentially the landing page)
- **Local configuration management** via the MCP Server Manager tools (acting on behalf of the LLM with user consent)
- **Health monitoring** of registered tools (planned feature via `health-worker`)

## Development Guidelines

- Use **Node.js** with plain **JavaScript (ES Modules)**.
- **Do not use TypeScript**.
- Keep files under **500 lines** for readability.
- Structure code in small, **modular** components.
- Leverage Cloudflare Workers (stateless), KV, and R2 for storage.

## Project Structure

This repository uses Git submodules. See the root `README.md` for cloning instructions.

Organize code into clear, purpose-driven folders:

```
/ (root)
├── api-worker/        # Core registry Worker code for REST API
│   └── index.js       # Entry point
├── health-worker/     # Cron-triggered Worker for health checks
│   └── index.js
├── mcpfinder-www/     # Worker + static site for landing page
│   ├── worker.js      # Worker to serve landing page
│   └── public/        # Static assets (HTML, CSS, images)
│       └── index.html
├── mcpfinder-server/  # MCP Server (submodule -> mcpfinder/server)
│   └── index.js       # (Code resides in the submodule repository)
├── cli/               # Publisher CLI implementation
│   └── bin/
│       └── mcp-cli.js
├── schemas/           # JSON schemas for manifest validation
│   └── mcp.v0.1.schema.json
├── .gitmodules        # Submodule configuration
├── README.md          # High-level overview and folder structure
├── DOCS.md            # This documentation file
└── package.json       # Root package config (for CLI, shared deps)
```

- Each Worker lives in its own folder with a simple `index.js` (or `worker.js`).
- Static assets for the landing page go under `mcpfinder-www/public/`.
- The `mcpfinder-server` is included as a Git submodule, pointing to the [mcpfinder/server](https://github.com/mcpfinder/server) repository. Its code is developed and versioned independently there.
- Reuse shared helpers (e.g., HMAC, validation) by placing them in a common `lib/` folder if needed.

---

## MVP Specification

### 1. Manifest Format

Define `mcp.json` v0.1:

```json
{
  "name": "ToolName",
  "description": "Short description",
  "url": "https://example.com/mcp",
  "protocol_version": "MCP/1.0",
  "capabilities": [ { "name": "doThing", "type": "tool" } ],
  "tags": ["tag1","tag2"],
  "auth": { "type": "api-key", "instructions": "Get key at ..." }
}
```

Validate manifest using custom validation logic (`validateManifest` function) in the Worker.

### 2. Storage

- **KV Namespaces:**
  - `TOOLS_KV`: `tool:<id>` → manifest JSON
  - `TAGS_KV`: `tag:<tag>` → JSON array of tool IDs
  - `API_KEYS_KV`: `apikey:<key>` → publisher info
- **R2 Bucket:** `MANIFEST_BACKUPS` for raw manifests (`manifests/<id>.json`)

### 3. API Endpoints

Refer to the [API Documentation](landingpage/public/api.html) for detailed endpoint specifications, request/response formats, and authentication requirements. The documentation includes a link to the machine-readable [OpenAPI 3.1 specification](landingpage/public/openapi.yaml).

### 3.1 API Design Standards

The API adheres to the following standards:

*   **Specification**: OpenAPI 3.1 ([`landingpage/public/openapi.yaml`](landingpage/public/openapi.yaml)). This serves as the definitive contract.
*   **Protocol**: RESTful principles using standard HTTP verbs (GET, POST) and resource-oriented nouns (e.g., `/tools/{id}`).
*   **Status Codes**: Standard HTTP status codes are used (2xx for success, 4xx for client errors, 5xx for server errors).
*   **Error Responses**: Errors follow the RFC-7807 `application/problem+json` format, providing `type`, `title`, `status`, and `detail` fields.
*   **Data Schemas**: Request and response body schemas are defined within the OpenAPI specification. Additionally, the specific MCP manifest submitted to `/api/v1/register` is validated against the project's JSON schema (`/schemas/mcp.v0.1.schema.json`).
*   **Authentication**: Security requirements (like HMAC for registration) are declared under `components/securitySchemes` in the OpenAPI specification.
*   **Versioning**: API versioning is handled via the URI path (`/api/v1/...`). Major version changes will result in a new path segment (e.g., `/api/v2/...`).
*   **Linting & Testing**: It is recommended to use tools like [Spectral](https://github.com/stoplightio/spectral) to lint the OpenAPI specification against standard rulesets and custom rules. Contract testing (e.g., using tools like [Dredd](https://github.com/apiaryio/dredd) or provider-driven pact tests) should be integrated into the build/deployment pipeline to ensure the implementation matches the specification.

### 3.2 MCP Server (`mcpfinder-server`)

This MCP server (developed in [mcpfinder/server](https://github.com/mcpfinder/server) and included as a submodule) provides tools specifically designed for LLMs interacting with MCP clients (like Cursor or Claude Desktop) to manage the configuration of *other* MCP servers. It utilizes the `@modelcontextprotocol/sdk`, leveraging the `StreamableHTTPServerTransport` for communication and `express` for the underlying HTTP server. It allows the LLM to:

1.  **Discover available MCP servers**: Search the central MCP Finder registry by keyword or tag. **This is the primary tool for discovering and accessing new tools, methods, features, or capabilities. If a user requests a tool, method, feature, or capability not currently available, the LLM must use this tool first.**
    *   Tool: `search_mcp_servers` (Calls `GET /api/v1/search`) — **required first step for missing capabilities.**
2.  **Get details about a specific server**: Retrieve the full manifest and construct basic installation details (command, env placeholders) based on the manifest.
    *   Tool: `get_mcp_server_details` (Calls `GET /api/v1/tools/{id}`)
3.  **Add/Update server configurations**: Modify the client's local configuration file (e.g., `~/.cursor/mcp.json`, `~/Library/Application Support/Claude/claude_desktop_config.json`) to add or update a server entry. This requires user permission.
    *   Tool: `add_mcp_server_config`
        *   Identifies the configuration file either by:
            *   `client_type`: A string identifying the client (e.g., 'cursor', 'claude', 'my-custom-app'). Known types ('cursor', 'claude', 'windsurf') resolve to default paths. For unknown types, `config_file_path` must be used.
            *   `config_file_path`: An absolute path to the target JSON configuration file. If the path contains spaces, provide the string argument with the spaces included literally (no shell escaping needed).
        *   **Note:** You must provide *either* `client_type` *or* `config_file_path`, but not both. The tool will return an error if this rule is violated.
        *   If the full `mcp_definition` (including `command` and optional `args`) is provided, it's used directly.
        *   If `mcp_definition` is provided *without* `command` (e.g., only `env` or `workingDirectory`), the tool fetches the default command/args from the registry and merges them with the provided fields.
        *   If `mcp_definition` is omitted entirely, the tool fetches the complete default configuration (command, args) from the registry.
4.  **Remove server configurations**: Modify the client's local configuration file to remove a server entry. This requires user permission.
    *   Tool: `remove_mcp_server_config`
        *   Identifies the configuration file using `client_type` or `config_file_path`, similar to `add_mcp_server_config`.
        *   Requires *either* `client_type` *or* `config_file_path`, but not both.

This server acts as an abstraction layer, enabling LLMs to manage MCP setups across different clients without needing hardcoded knowledge of specific file paths or configuration formats (beyond the common `mcpServers` JSON structure). It relies on the host client (Cursor, Claude Desktop) to grant permission for file modification tools.

### 4. Health Checks

- Cron schedule (e.g., every 15 min).
- Worker reads all `tool:<id>` keys, sends `HEAD` to each URL.
- Updates `status` and `lastChecked` in `TOOLS_KV`.

### 5. CLI Tool (`mcp-cli`)

- **Purpose**: Allows developers to register their MCP server manifests with the MCP Finder Registry API.
- **Location**: Defined in the root `package.json` (`bin` field), sourced from `/cli/bin/mcp-cli.js`.
- **Installation/Usage**:
  - Clone the main `mcpfinder` repository **recursively** (`git clone --recursive ...`) to include submodules.
  - Run `npm install` in the root directory.
  - Link the CLI for development using `npm link` in the root directory.
  - Alternatively, execute directly from the root: `node ./cli/bin/mcp-cli.js <command>`
  - Or use via `npx` if published: `npx @mcpfinder/cli register ...` (assuming future package name)
- **Command**: `register <path/to/mcp.json>`
  ```bash
  # Example usage (from root of cloned mcpfinder repo):
  export MCPFINDER_REGISTRY_SECRET='your-super-secret-key'
  export MCPFINDER_API_URL='https://api.mcpfinder.dev' # Optional, defaults to deployed prod or http://localhost:8787 if run locally
  # Ensure mcp.json exists
  mcp-cli register ./path/to/your/server/mcp.json
  ```
- **Functionality**:
  - Reads the specified `mcp.json` file.
  - Reads the `MCPFINDER_REGISTRY_SECRET` environment variable.
  - Computes the HMAC-SHA256 signature of the manifest content using the secret.
  - Sends a POST request to the `/api/v1/register` endpoint (configurable via `MCPFINDER_API_URL`).
  - Includes the manifest as the JSON body and the signature in the `Authorization: HMAC <signature>` header.
  - Prints the success response (including the new tool ID) or error details.
- **Security**: Relies on the secure handling of the `MCPFINDER_REGISTRY_SECRET` environment variable by the user.

### 6. Security & Rate Limiting

- HMAC for `/register`.
- Simple rate limiting on GET (Cloudflare or in-Worker).

### 7. Landing Page & Docs

- Static `public/index.html`:
  - Overview
  - API reference
  - CLI usage
- Serve via KV Assets in Worker.

### 8. Deployment & Feedback

- Deploy with Wrangler to Workers (and optionally Pages).
- Announce release (Discord, Twitter).
- Collect issues/feedback on GitHub or Discord.

---

## Roadmap

- **Web UI:** Browse, filter, manage tools.
- **Publisher Accounts:** JWT/OAuth login.
- **Manifest Signing:** Ed25519 & DNS TXT.
- **Agent Discovery:** MCP `searchDirectory` resource.
- **Semantic Search:** Vector embeddings.
- **Federation:** Import from other registries.
- **Analytics:** Usage dashboards.
- **Enterprise:** Docker/Helm, RBAC, SSO, SLAs.

The goal is to become a central, reliable hub within the MCP ecosystem, facilitating seamless interaction between AI agents and external tools. 