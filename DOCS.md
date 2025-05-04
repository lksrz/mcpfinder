# MCP Finder Documentation

## Overview

MCP Finder (mcpfinder.dev) is a lightweight serverless platform for listing and discovering MCP (Model Context Protocol) tools. It provides:

- **Tool registration** via a CLI and REST API
- **Tool discovery** via REST search endpoints
- **Health monitoring** of registered tools

## Development Guidelines

- Use **Node.js** with plain **JavaScript (ES Modules)**.
- **Do not use TypeScript**.
- Keep files under **500 lines** for readability.
- Structure code in small, **modular** components.
- Leverage Cloudflare Workers (stateless), KV, and R2 for storage.

## Project Structure

Organize code into clear, purpose-driven folders:

```
/ (root)
├── api-worker/        # Core registry Worker code for REST API
│   └── index.js       # Entry point
├── health-worker/     # Cron-triggered Worker for health checks
│   └── index.js
├── landingpage/       # Worker + static site for landing page
│   ├── worker.js      # Worker to serve landing page
│   └── public/        # Static assets (HTML, CSS, images)
│       └── index.html
├── cli/               # Publisher CLI implementation
│   └── bin/
│       └── mcp-cli.js
├── schemas/           # JSON schemas for manifest validation
│   └── mcp.v0.1.schema.json
└── README.md          # High-level overview and folder structure
```

- Each Worker lives in its own folder with a simple `index.js` (or `worker.js`).
- Static assets for the landing page go under `landingpage/public/`.
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

Validate against JSON schema (`/schemas/mcp.v0.1.schema.json`) using `ajv` in the Worker.

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
*   **Data Schemas**: Request and response bodies are defined using JSON Schema (Draft 2020-12), located within the `components/schemas` section of the OpenAPI specification.
*   **Authentication**: Security requirements (like HMAC for registration) are declared under `components/securitySchemes` in the OpenAPI specification.
*   **Versioning**: API versioning is handled via the URI path (`/api/v1/...`). Major version changes will result in a new path segment (e.g., `/api/v2/...`).
*   **Linting & Testing**: It is recommended to use tools like [Spectral](https://github.com/stoplightio/spectral) to lint the OpenAPI specification against standard rulesets and custom rules. Contract testing (e.g., using tools like [Dredd](https://github.com/apiaryio/dredd) or provider-driven pact tests) should be integrated into the build/deployment pipeline to ensure the implementation matches the specification.

### 4. Health Checks

- Cron schedule (e.g., every 15 min).
- Worker reads all `tool:<id>` keys, sends `HEAD` to each URL.
- Updates `status` and `lastChecked` in `TOOLS_KV`.

### 5. CLI Tool

- Node.js script `mcp-cli`:
  ```bash
  mcp-cli register <path/to/mcp.json>
  ```
- Computes HMAC of manifest body.
- POSTs to `/api/v1/register` with `Authorization: HMAC <sig>`.
- Prints returned tool ID.

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