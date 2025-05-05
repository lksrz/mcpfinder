# CLI TODO List

This file tracks potential improvements and future tasks for the command-line tools in the `cli/` directory.

## `introspect_servers.js`

-   [x] **Input Flexibility:** Allow passing the list of server packages/configs via a config file instead of hardcoding. _(Changed: Now reads from `npm_mcp_search_results.json` instead of a dedicated config file)_.
-   [x] **Handle Server Arguments:** Allow specifying command-line arguments needed to launch certain servers. _(Removed: Input format no longer supports passing args/env per package)_.
-   [x] **Handle Environment Variables:** Allow specifying environment variables needed by servers. _(Removed: Input format no longer supports passing args/env per package)_.
-   [ ] **Investigate Failures (Status 2):** Understand why some servers connect but immediately close the connection (`MCP error -32000: Connection closed`). This might require deeper debugging of those specific servers or the SDK's handling of early errors.
-   [ ] **Robustness:** Improve handling of unexpected `npx` errors or server hangs.
-   [ ] **Capabilities Check:** Ensure `capabilities` array construction in `generateManifest` correctly handles various `listTools/Resources/Prompts` outputs.
-   [not required] **Pagination Support:** Implement logic to fetch all pages of results for `listTools` if `nextCursor` is present.
-   [not required] **Detailed Tool Schemas:** Optionally add logic to call `tools/get` (if supported by the server) for each discovered tool to fetch detailed `inputSchema`.
-   [not required] **Configurable Timeouts:** Allow overriding default timeouts via command-line arguments.
-   [not required] **Output Formatting:** Offer different output formats besides updating the JSON (e.g., a summary report).
-   [not required] **Error Reporting:** Improve error reporting granularity (e.g., distinguish different types of connection failures). Currently relies on logged errors and the `error` field in JSON.
-   [not required] **Dependency Management:** Consider if the CLI tools should have their own `package.json`.

## `mcp-cli.js`

-   [ ] **Improve Error Handling:** Provide more specific feedback for API errors (e.g., invalid secret, detailed manifest validation errors from the API response).
-   [ ] **Add `update` command:** Allow updating an existing registration.
-   [ ] **Add `list` command:** List servers registered under a specific API key.
-   [ ] **Add `unregister` command:** Remove a server registration.
-   [ ] **Configuration File:** Support reading API URL and secret from a config file instead of only environment variables. 