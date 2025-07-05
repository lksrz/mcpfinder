# KV Analysis Queries for Cloudflare Dashboard

Run these queries in the Cloudflare dashboard KV browser:

## 1. Count tool records without corresponding urlidx

Look for `tool:` keys, then for each one check if there's a corresponding `urlidx:` entry.

## 2. Find duplicate URL registrations

List all `urlidx:` keys and check if any point to different tool IDs.

## 3. Sample queries to run:

```
# Get a sample tool record
tool:0044cc0e-088b-409d-925f-76b971baa601

# Check its URL index
urlidx:@kevin29a/viq-mcp

# Look for patterns in tool records without urlidx
```

## Expected state:
- Every `tool:` record should have a `url` field
- Every unique `url` should have one `urlidx:` entry
- No duplicate `urlidx:` entries pointing to different tools

## Current state:
- 423 `tool:` records
- 339 `urlidx:` records
- 84 missing `urlidx:` entries

This suggests either:
1. 84 tools share URLs with other tools (duplicates)
2. 84 tools were registered before URL indexing was implemented
3. 84 tools have missing/null URLs