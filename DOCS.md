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

| Method | Path                    | Description                         |
| ------ | ----------------------- | ----------------------------------- |
| POST   | /api/v1/register        | Register a tool (HMAC auth)         |
| GET    | /api/v1/tools/:id       | Get full manifest by ID             |
| GET    | /api/v1/search?tag=&q=  | Search tools by tag or keyword      |

**Details:**

- **POST /register**
  1. Authenticate using HMAC header with `REGISTRY_SECRET`.
  2. Validate JSON body against schema.
  3. Ping `url` (GET).
  4. Store manifest in `TOOLS_KV` (generate UUID). Backup in R2.
  5. Update `TAGS_KV` entries.
  6. Respond `{ success: true, id }`.

- **GET /tools/:id**
  - Fetch `tool:<id>` from KV or return 404.

- **GET /search**
  - If `tag`, fetch list from `TAGS_KV`.
  - If `q`, scan KV entries for name/description match.
  - Return list of summaries `{ id, name, description, url, status, tags }`.

Enable CORS (`*`) for GET endpoints.

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