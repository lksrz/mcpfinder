# MCP Finder - MVP TODO List

## 1. Setup & Configuration [COMPLETED]

- Initialize project:
  - Create root directory `mcpfinder`.
  - Initialize Git repository and connect to remote.
- Create Worker Directories: `api-worker`, `health-worker`, `landingpage`, `mcp-manager-worker`.
- Initialize each worker directory as a separate Wrangler project:
  - `cd api-worker && npx wrangler init api-worker --type=javascript && cd ..`
  - `cd health-worker && npx wrangler init health-worker --type=javascript && cd ..`
  - `cd landingpage && npx wrangler init landingpage-worker --type=javascript && cd ..`
  - `cd mcp-manager-worker && npx wrangler init mcp-manager-worker --type=javascript && cd ..`
  - *Note: Ensure Node.js/npm is installed for `npx`.*
- Configure `wrangler.toml` *within each worker directory*:
  - Set `name` appropriately (e.g., `mcp-finder-api`, `mcp-finder-health`).
  - Set `main` entry point (e.g., `index.js`, `worker.js`).
  - Add necessary `kv_namespaces`, `r2_buckets`, and `vars` bindings *specific to each worker*.
    - `api-worker`: Needs `MCP_TOOLS_KV`, `MCP_SEARCH_INDEX_KV` (or similar), `MCP_MANIFEST_BACKUPS`, `MCP_REGISTRY_SECRET`.
    - `health-worker`: Needs `MCP_TOOLS_KV`.
    - `landingpage-worker`: Needs KV for assets if using KV Assets (e.g., `MCP_STATIC_CONTENT`).
    - `mcp-manager-worker`: May need access to its *own* configuration or secrets if calling the API securely.
  - Configure Cron trigger for `health-worker` in its `wrangler.toml`.
- Set up CI/CD (e.g., GitHub Actions) to run `npx wrangler deploy` from *within each relevant worker directory* on merge/push.

## 2. Manifest & Schema [COMPLETED]

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
- Validate manifests in Worker using custom validation logic.

## 3. Data Layer [COMPLETED]

- KV namespaces:
  - `MCP_TOOLS_KV`: key `tool:<id>` → manifest JSON.
  - `MCP_SEARCH_INDEX_KV`: key `index:<keyword/tag>` → JSON array of tool IDs (Future optimization).
  - `API_KEYS_KV`: key `apikey:<key>` → publisher metadata (Still needed? Or handle via `MCP_REGISTRY_SECRET` for MVP? -> Let's stick with MCP_REGISTRY_SECRET for MVP)
- R2 bucket `MCP_MANIFEST_BACKUPS`: store raw manifest files under `manifests/<id>.json`.
- Parse and validate JSON body using custom validation logic.

## 4. API Implementation (`api-worker`) [COMPLETED]

- **Framework**: Use Cloudflare Workers with `itty-router` or similar for routing.
- **Storage**: Utilize Cloudflare KV for primary data storage.
  - `MCP_TOOLS_KV`: Key `tool:<id>` -> Full Manifest JSON (as submitted).
  - `MCP_SEARCH_INDEX_KV` (or similar): Potentially use for basic keyword/tag indexing if KV scan proves insufficient. Key `index:<keyword/tag>` -> List of tool IDs.
- **Endpoints**:
  1.  `POST /api/v1/register`
      - Authenticate with HMAC using `MCP_REGISTRY_SECRET`.
      - Parse and validate JSON body against `/schemas/mcp.v0.1.schema.json` using `ajv`.
      - *Optional Ping*: Consider if pinging the `url` during registration is essential for MVP.
      - Generate unique ID (UUID).
      - Store full manifest JSON in `MCP_TOOLS_KV` (`tool:<uuid>`).
      - Store raw manifest in R2 `MCP_MANIFEST_BACKUPS` (`manifests/<uuid>.json`).
      - *Simplified Search Indexing*: For MVP, perhaps only store basic info (name, desc, tags) alongside ID in a searchable format, or rely on listing all keys from `MCP_TOOLS_KV` for search.
      - Return `201 Created` with `{ "success": true, "id": "<uuid>" }`.
  2.  `GET /api/v1/tools/:id`
      - Lookup `tool:<id>` in `MCP_TOOLS_KV`.
      - Return manifest JSON or `404 Not Found`.
  3.  `GET /api/v1/search?q={query}&tag={tag}`
      - Implement basic search logic:
        - List keys from `MCP_TOOLS_KV` (using prefix `tool:`).
        - Fetch each manifest.
        - Filter manifests based on `q` (substring match in `name`/`description`) and/or `tag`.
        - *Consider KV limitations*: Listing all keys can be slow/costly at scale. Plan for future optimization (e.g., using `MCP_SEARCH_INDEX_KV`).
      - Return array of summary objects: `{ id, name, description, url, tags }` (limit results, e.g., 50).
- **CORS**: Enable CORS for GET endpoints (`Access-Control-Allow-Origin: *`).
- **Error Handling**: Implement consistent error responses (e.g., `application/problem+json`).

## 5. CLI Tool (`mcp-cli`) [COMPLETED]

- Node.js script (`#!/usr/bin/env node`).
- Command: `mcp-cli register <path/to/mcp.json>`.
- Read manifest file, compute HMAC signature of body.
- POST to `/api/v1/register` with header `Authorization: HMAC <sig>`.
- Print success message and returned tool ID.
- **Security:** Rely on the host client for permission.
- Add tests for file manipulation logic.
- Consider how to handle API keys/environment variables securely (initially, the LLM asks the user, then passes them to `add_mcp_server_config`).
- Plan future enhancement for API key retrieval via MCP Finder API.

## 6. Health Checks (Cron) [TODO] //SKIPPED FOR LATER

- Configure Cron trigger in `wrangler.toml` (e.g., `cron */15 * * * *`).
- Handler:
  - List all `tool:<id>` keys from `MCP_TOOLS_KV`.
  - For each, send a `HEAD` request to its `url`.
  - Update `status` and `lastChecked` in the stored manifest.
- Apply simple rate limiting on GET endpoints (e.g., Cloudflare rate limit or in-Worker counter).

## 7. Security & Rate Limiting [COMPLETED]

- Use HMAC authentication for `/api/v1/register`.
- Apply simple rate limiting on GET endpoints (e.g., Cloudflare rate limit or in-Worker counter).

## 8. Docs & Landing Page [COMPLETED]

- Create `public/index.html` with:
  - Overview of platform.
  - API endpoint guide.
  - CLI usage examples.
- Serve static assets using KV asset handler.

## 9. Deployment [COMPLETED]

- Deploy to Cloudflare Workers (and Pages if hosting site).

---

## 10. MCP Server (`mcpfinder-server`) [COMPLETED]

- **Refine search tool description**: Updated the `search_mcp_servers` tool description to explicitly instruct the LLM to use it when a user requests any missing tool, method, feature, or capability. [COMPLETED]

- **Project Setup & Configuration**: [COMPLETED]
    - Ensure `mcpfinder-server/` exists and is initialized (`npm init -y`). [COMPLETED]
    - Confirm dependencies: `@modelcontextprotocol/sdk`, `zod`, `node-fetch`, `express`. Install if missing (`npm install ...`). [COMPLETED]
    - Configure `package.json`: [COMPLETED]
        - Set `name` (e.g., `@mcpfinder/server`), `version`, `description`, `author`, `license`. [COMPLETED]
        - Add `"type": "module"` to enable ES Module syntax. [COMPLETED]
        - Add `"main": "index.js"` as the entry point. [COMPLETED]
        - Add a `"bin"` field to allow execution via `npx` or global install (e.g., `"bin": { "mcpfinder-server": "./index.js" }`). [COMPLETED]
    - Ensure `index.js` starts with the shebang `#!/usr/bin/env node`. [COMPLETED]
    - Create `.gitignore` if not present (add `node_modules/`, `.env*`, `*.log`, etc.). [COMPLETED]
    - Define environment variable for registry API URL (`MCPFINDER_API_URL`). [COMPLETED]

- **Implement MCP Server Core (`index.js`)**: [COMPLETED]
    - Import `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`. [COMPLETED]
    - Import `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`. [COMPLETED]
    - Import and use `express` to handle HTTP listening and routing to the transport. [COMPLETED]
    - Instantiate `McpServer` and `StreamableHTTPServerTransport`. [COMPLETED]
    - Implement basic server start logic (`server.connect(transport)` and `app.listen()`). [COMPLETED]
    - Add graceful shutdown handling (`process.on('SIGINT', ...)`). [COMPLETED]

- **Define Tool Schemas (Zod)**: [COMPLETED]
    - Define Zod input schemas for `SearchServersInput`, `GetServerDetailsInput`, `AddServerConfigInput`, `RemoveServerConfigInput`. [COMPLETED]
    - Include descriptions for schemas and fields. [COMPLETED]

- **Implement Tool Logic**: [COMPLETED]
    - `search_mcp_servers(input)`: [COMPLETED]
        - Use `fetch` to call `GET ${MCPFINDER_API_URL}/api/v1/search`. [COMPLETED]
        - Append `q` and `tag` query parameters. [COMPLETED]
        - Handle fetch errors/non-200 responses. [COMPLETED]
        - Return server summaries. [COMPLETED]
    - `get_mcp_server_details(input)`: [COMPLETED]
        - Use `fetch` to call `GET ${MCPFINDER_API_URL}/api/v1/tools/${input.id}`. [COMPLETED]
        - Handle fetch errors/404 responses. [COMPLETED]
        - Extract manifest details. [COMPLETED]
        - Construct basic `installation` object. [COMPLETED]
        - Return details including `installation`. [COMPLETED]
    - `add_mcp_server_config(input)`: [COMPLETED]
        - Implement `getConfigPath` (with OS handling). [COMPLETED]
        - Implement `readConfigFile` (with error handling). [COMPLETED]
        - Implement `writeConfigFile` (with dir creation). [COMPLETED]
        - Combine helpers to add/update config. [COMPLETED]
        - Include security note. [COMPLETED]
        - Return success/failure message. [COMPLETED]
    - `remove_mcp_server_config(input)`: [COMPLETED]
        - Use helpers to read/write config. [COMPLETED]
        - Delete entry if exists. [COMPLETED]
        - Return success/failure message. [COMPLETED]
        - Include security note. [COMPLETED]

- **Register Tools with MCP Server**: [COMPLETED]
    - Use `server.tool()` for each tool (`search_mcp_servers`, `get_mcp_server_details`, `add_mcp_server_config`, `remove_mcp_server_config`). [COMPLETED]

- **Refine API Key Handling for `add_mcp_server_config`**: [DOCUMENTED]
    - Clarify in code comments that `mcp_definition` should contain pre-filled `env` variables. [COMPLETED]

- **Add Unit Tests**: [TODO]
    - Create `test/` directory.
    - Choose & install testing framework (e.g., `jest`).
    - Add tests for file utils (`getConfigPath`, `readConfigFile`, `writeConfigFile`).
    - Add tests for config logic (`add_mcp_server_config`, `remove_mcp_server_config`) mocking `fs`.
    - *Optional*: Add tests for API calling functions, mocking `fetch`.

- **Write Package Documentation (`README.md`)**: [COMPLETED]
    - Create `mcpfinder-server/README.md`.
    - Detail purpose, installation, configuration, tools, security model.

- **Publishing Preparation (Future Step)**: [TODO]
    - Finalize `package.json`.
    - Add license file.
    - Ensure README is comprehensive.

---

## 11. API & Docs Refinements [TODO]

- Implement ping-on-register: The `/api/v1/register` endpoint should attempt a `HEAD` request to the provided `url` before successfully registering the tool (ref: #8).
- Align `/register` response: Update the API to return `200 OK` with a `status` field (reflecting ping result) OR update documentation (`api.html`, `openapi.yaml`) to match the current `201 Created` response without `status` (ref: #8).
- Implement Search Indexing: Add logic to create/update search indexes (e.g., in `MCP_SEARCH_INDEX_KV`) during registration to optimize the `/search` endpoint performance (ref: #4, #8).

## 12. Landing Page (mcpfinder-www) Updates [TODO]

- Update the public website (`mcpfinder-www`) to showcase the MCP Server's integration with LLM clients (Cursor, Claude Desktop, Windsurf).
- Emphasize how users can add the mcpfinder-server tool to their client application via simple conversation with an LLM.
- Provide step-by-step examples and guides demonstrating dynamic MCP Server installation and management through natural language prompts ("vibe coding").
- Highlight key benefits: streamlined tool/capability discovery, automated server selection by the LLM, and simplified mcp server configuration.
- Include visuals (screenshots or code snippets) illustrating the process on the landing page.
- change API page to Docs and make there 3 tabs: MCP server - installation detalis (for a few clients), our MCP tools description , and API description

# Future Roadmap

- **Web UI:** Browsing, filtering, and tool management. [TODO]
- **Publisher Accounts:** JWT/OAuth for secure publish/update flows. [TODO]
- **Manifest Signing:** Ed25519 signatures & DNS TXT verification. [TODO]
- **Agent-native Discovery:** MCP-compliant `searchDirectory` endpoint. [TODO]
- **Semantic Search:** Vector-based relevance ranking. [TODO]
- **Federation:** Import and dedupe from other registries. [TODO]
- **Analytics:** Dashboard for usage stats and trends. [TODO]
- **Enterprise / On-Prem:** Docker/Helm charts, RBAC, SSO, audit logs, SLAs.  [TODO]

# Release and Feedback [TODO]

- Announce MVP release (Discord, Twitter, developer forums).
- Use GitHub Issues or Discord channel for bug reports and feedback.

# Monetization & Stripe Integration (MVP) [TODO]

## 13. Stripe Account & Setup [TODO]

-   [ ] Create MCPfinder Stripe account.
-   [ ] Configure Stripe Connect settings (platform profile, branding, redirect URLs).
-   [ ] Obtain Stripe API keys (publishable and secret) and store them securely in Cloudflare secrets/environment variables for `api-worker`.

## 14. Publisher Onboarding & Verification [TODO]

-   [ ] **NPM Data Fetching:**
    -   [ ] Implement logic (likely in `api-worker` or a shared lib) to query the NPM registry API for package details using a package name.
    -   [ ] Extract `package.publisher.email` reliably.
    -   [ ] Handle cases where email is missing or package not found.
-   [ ] **Stripe Connect Onboarding Flow:**
    -   [ ] Create an API endpoint (e.g., `GET /api/v1/stripe/connect/onboard`) or logic in the future web UI to generate the Stripe Connect OAuth authorization URL.
    -   [ ] Create an API endpoint (e.g., `GET /api/v1/stripe/connect/callback`) to handle the redirect back from Stripe.
    -   [ ] Implement logic in the callback handler to exchange the received `code` for the publisher's `stripe_account_id` using the Stripe API.
-   [ ] **Email Verification:**
    -   [ ] Choose and integrate an email sending service/library accessible from `api-worker` (e.g., Mailgun, SendGrid, or potentially Cloudflare Email Routing if simple enough).
    -   [ ] Implement secure verification code generation (random string, short expiry).
    -   [ ] Store the code temporarily (e.g., in KV with TTL) associated with the pending verification.
    -   [ ] Implement logic to send the verification email to the publisher's NPM email after Stripe Account ID is obtained.
    -   [ ] Create an API endpoint (e.g., `POST /api/v1/stripe/connect/verify`) for the publisher to submit the code.
    -   [ ] Implement logic to validate the submitted code against the stored one.
-   [ ] **Data Storage:**
    -   [ ] Define schema and implement storage (e.g., new KV namespace `MCP_PUBLISHER_STRIPE`) to securely store the mapping: `npm_package_name` -> `{ verifiedStripeAccountId: 'acct_...', publisherEmail: '...' }`.
    -   [ ] Store this mapping only after successful email verification.

## 15. API Worker Changes (`api-worker`) [TODO]

-   [ ] Add `stripe` Node.js library dependency (`npm install stripe`).
-   [ ] Add new KV namespace bindings to `wrangler.toml` for `MCP_PURCHASES` and `MCP_PUBLISHER_STRIPE`.
-   [ ] Implement `POST /api/v1/create-payment-link` endpoint:
    -   [ ] Input: `mcp_id`, potentially `user_id`.
    -   [ ] Logic: Fetch MCP manifest, get `price`, retrieve verified `publisherStripeAccountId` from `MCP_PUBLISHER_STRIPE` KV using `mcp_id` (or package name derived from it).
    -   [ ] Call Stripe API (`checkout.sessions.create` or `paymentLinks.create`) configuring `amount`, `currency`, `transfer_data[destination]`, and `application_fee_amount`.
    -   [ ] Return Stripe Checkout/Payment Link URL.
-   [ ] Implement `POST /api/v1/stripe-webhook` endpoint:
    -   [ ] Verify Stripe webhook signature using the webhook signing secret (configured in Stripe dashboard & Cloudflare secrets).
    -   [ ] Handle `checkout.session.completed` event (or other relevant success events).
    -   [ ] Extract necessary data (MCP ID, user/customer info if available, payment status).
    -   [ ] Write purchase record to `MCP_PURCHASES` KV.
    -   [ ] Consider idempotency (ignore duplicate events).
    -   [ ] Return appropriate `200 OK` response to Stripe.
-   [ ] (Optional/Alternative) Implement `GET /api/v1/payment-status/{checkout_session_id}` for polling confirmation.
-   [ ] Update `/api/v1/register` and `/api/v1/tools/:id` to handle reading/writing the new optional `price` field in manifests stored in `MCP_TOOLS_KV`.

## 16. Schema Changes [TODO]

-   [ ] Modify `/schemas/mcp.v0.1.schema.json` to add the optional `price: { type: object, properties: { amount: { type: integer }, currency: { type: string, pattern: '^[a-z]{3}$' } }, required: ['amount', 'currency'] }` field.
-   [ ] Ensure validation logic in `api-worker` uses the updated schema.

## 17. MCP Server Changes (`mcpfinder-server`) [TODO]

-   [ ] Modify `add_mcp_server_config` tool logic:
    -   [ ] Check the fetched MCP manifest details for the `price` field.
    -   [ ] If `price` exists:
        -   Inform the user of the price.
        -   Call the `/api/v1/create-payment-link` endpoint.
        -   Present the payment URL to the user.
        -   Implement a waiting/confirmation mechanism (e.g., polling `payment-status` API, or checking a flag updated by the webhook).
        -   Proceed with installation *only* after payment confirmation.
    -   [ ] If no `price`, proceed directly with installation.

## 18. CLI Changes (`cli/mcp-cli.js`) [TODO]

-   [ ] Update `mcp-cli register` command to correctly parse and include the optional `price` object when sending the manifest to the `/api/v1/register` endpoint.

## 19. Documentation & Frontend [TODO]

-   [ ] Create and populate `DOCS_STRIPE.md` with the detailed flow.
-   [ ] Update `DOCS.md` to reference the new monetization process.
-   [ ] Update `mcpfinder-www` landing page:
    -   Explain the payment flow for users purchasing MCPs.
    -   Add a section/page for publishers explaining how to monetize their MCPs (NPM email requirement, Stripe Connect process, verification).
-   [ ] (Future) Build a simple web UI for publishers to manage their Stripe connection and potentially view basic stats.

## 20. Testing [TODO]

-   [ ] Configure Stripe test mode API keys.
-   [ ] Set up Stripe CLI for local webhook testing.
-   [ ] Add unit/integration tests for:
    -   NPM data fetching.
    -   Stripe Connect onboarding flow (mocking Stripe API calls).
    -   Email verification logic.
    -   Payment link creation API endpoint.
    -   Webhook handler logic (using mock Stripe events).
    -   `add_mcp_server_config` modifications for paid MCPs.
-   [ ] Perform end-to-end tests of the publisher onboarding and user purchase flows in the Stripe test environment.

# Release and Feedback [TODO]

- Announce MVP release (Discord, Twitter, developer forums).
- Use GitHub Issues or Discord channel for bug reports and feedback.