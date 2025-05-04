# MCP Finder - MVP TODO List

## 1. Setup & Configuration

- Initialize project:
  - `npm init -y`
  - Install Cloudflare Wrangler: `npm install -g @cloudflare/wrangler`
  - Create worker: `wrangler init mcp-finder --type=javascript`
- Initialize Git repository and connect to remote.
- Configure `wrangler.toml`:
  - Bind KV namespaces: `TOOLS_KV`, `TAGS_KV`, `API_KEYS_KV`
  - Bind R2 bucket: `MANIFEST_BACKUPS`
  - Set environment variable `REGISTRY_SECRET`.
- Set up CI/CD (e.g., GitHub Actions) to run `wrangler publish` on merge.

## 2. Manifest & Schema

- Define `mcp.json` v0.1 manifest format:
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
- Create JSON schema in `/schemas/mcp.v0.1.schema.json`.
- Validate manifests in Worker using `ajv`.

## 3. Data Layer

- KV namespaces:
  - `TOOLS_KV`: key `tool:<id>` → manifest JSON.
  - `TAGS_KV`: key `tag:<tag>` → JSON array of tool IDs.
  - `API_KEYS_KV`: key `apikey:<key>` → publisher metadata.
- R2 bucket `MANIFEST_BACKUPS`: store raw manifest files under `manifests/<id>.json`.

## 4. API Implementation (Cloudflare Worker)

- Choose minimal router (e.g., `itty-router`) or manual switch on `request.method` + `request.url`.
- Endpoints:
  1. `POST /api/v1/register`
     - Authenticate with HMAC (`REGISTRY_SECRET`).
     - Parse and validate JSON body against schema.
     - Ping `url` from manifest (GET request).
     - Generate unique ID (UUID).
     - Store manifest in `TOOLS_KV` and backup in R2.
     - For each tag, update its list in `TAGS_KV`.
     - Return `200 OK` with `{ "success": true, "id": "<id>" }`.
  2. `GET /api/v1/tools/:id`
     - Lookup `tool:<id>` in `TOOLS_KV`.
     - Return manifest or `404 Not Found`.
  3. `GET /api/v1/search?tag={tag}&q={query}`
     - If `tag` present, fetch `tag:<tag>` list.
     - If `q` present, scan tools for name/description match.
     - Return array of summary objects `{ id, name, description, url, status, tags }`.
- Enable CORS for GET APIs: `Access-Control-Allow-Origin: *`.

## 5. CLI Tool (`mcp-cli`)

- Node.js script (`#!/usr/bin/env node`).
- Command: `mcp-cli register <path/to/mcp.json>`.
- Read manifest file, compute HMAC signature of body.
- POST to `/api/v1/register` with header `Authorization: HMAC <sig>`.
- Print success message and returned tool ID.

## 6. Health Checks (Cron)

- Configure Cron trigger in `wrangler.toml` (e.g., `cron */15 * * * *`).
- Handler:
  - List all `tool:<id>` keys from `TOOLS_KV`.
  - For each, send a `HEAD` request to its `url`.
  - Update `status` and `lastChecked` in the stored manifest.

## 7. Security & Rate Limiting

- Use HMAC authentication for `/api/v1/register`.
- Apply simple rate limiting on GET endpoints (e.g., Cloudflare rate limit or in-Worker counter).

## 8. Docs & Landing Page

- Create `public/index.html` with:
  - Overview of platform.
  - API endpoint guide.
  - CLI usage examples.
- Serve static assets using KV asset handler.

## 9. Deployment & Feedback

- Deploy to Cloudflare Workers (and Pages if hosting site).
- Announce MVP release (Discord, Twitter, developer forums).
- Use GitHub Issues or Discord channel for bug reports and feedback.

---

# Future Roadmap

- **Web UI:** Browsing, filtering, and tool management.
- **Publisher Accounts:** JWT/OAuth for secure publish/update flows.
- **Manifest Signing:** Ed25519 signatures & DNS TXT verification.
- **Agent-native Discovery:** MCP-compliant `searchDirectory` endpoint.
- **Semantic Search:** Vector-based relevance ranking.
- **Federation:** Import and dedupe from other registries.
- **Analytics:** Dashboard for usage stats and trends.
- **Enterprise / On-Prem:** Docker/Helm charts, RBAC, SSO, audit logs, SLAs. 