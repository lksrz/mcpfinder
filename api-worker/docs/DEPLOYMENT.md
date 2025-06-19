# Deployment Guide

## Prerequisites

1. Node.js and npm installed
2. Wrangler CLI (`npm install -g wrangler`)
3. Cloudflare account with Workers enabled
4. Access to MCPfinder Cloudflare account

## Critical Deployment Instructions

### ⚠️ IMPORTANT: Always Deploy with Config Flag

```bash
# CORRECT - This preserves KV bindings
npx wrangler deploy -c wrangler.toml

# WRONG - This will remove KV bindings!
npx wrangler deploy
```

### Why This Matters

Deploying without the `-c wrangler.toml` flag or deploying from the Cloudflare dashboard will:
- Remove all KV namespace bindings
- Break all API functionality
- Cause "KV namespace not available" errors

## Step-by-Step Deployment

### 1. Install Dependencies

```bash
cd api-worker
npm install
```

### 2. Configure Secrets

```bash
# Set the registry secret for API authentication
npx wrangler secret put MCP_REGISTRY_SECRET
# Enter the secret value when prompted
```

### 3. Verify KV Namespaces

Check that KV namespaces exist:

```bash
npx wrangler kv namespace list
```

You should see:
- `MCP_TOOLS_KV` (ID: 59bfeb2ef6ab471a9a3461f113704891)
- `MCP_SEARCH_INDEX_KV` (ID: 38748fb584cb46dbab1585f66e6f2fb0)

### 4. Deploy to Production

```bash
# Always use the -c flag!
npx wrangler deploy -c wrangler.toml
```

Expected output:
```
Your Worker has access to the following bindings:
Binding                                                                  Resource                  
env.MCP_TOOLS_KV (59bfeb2ef6ab471a9a3461f113704891)                    KV Namespace              
env.MCP_SEARCH_INDEX_KV (38748fb584cb46dbab1585f66e6f2fb0)             KV Namespace              
env.MCP_MANIFEST_BACKUPS (mcp-finder-manifest-backups)                 R2 Bucket                 
```

### 5. Verify Deployment

Test the API:

```bash
# Test search endpoint
curl "https://mcpfinder.dev/api/v1/search?limit=1"

# Test MCP endpoint
curl -X POST https://mcpfinder.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}'
```

## Local Development

### Run Locally

```bash
# Start local development server
npm run dev
# or
npx wrangler dev
```

Access at: http://localhost:8787

### Test with Local KV

```bash
# List keys in local KV
npx wrangler kv key list --namespace-id 59bfeb2ef6ab471a9a3461f113704891 --local

# Add test data
npx wrangler kv key put "tool:test" '{"name":"test"}' --namespace-id 59bfeb2ef6ab471a9a3461f113704891 --local
```

## Troubleshooting

### KV Namespace Not Available

If you see this error after deployment:

1. Check deployment output for bindings confirmation
2. Redeploy with: `npx wrangler deploy -c wrangler.toml`
3. Never deploy from Cloudflare dashboard

### Routes Not Working

Ensure routes are configured in:
1. wrangler.toml (automatic with deployment)
2. Cloudflare dashboard → Workers → Routes

Required routes:
- `mcpfinder.dev/api/*`
- `mcpfinder.dev/mcp`

### Search Returns Empty

1. Verify KV has data:
   ```bash
   npx wrangler kv key list --namespace-id 59bfeb2ef6ab471a9a3461f113704891
   ```

2. Check a specific key:
   ```bash
   npx wrangler kv key get "tool:some-id" --namespace-id 59bfeb2ef6ab471a9a3461f113704891
   ```

## Rollback

To rollback to a previous version:

```bash
# List deployments
npx wrangler deployments list

# View details
npx wrangler deployments view <deployment-id>

# Rollback (via dashboard)
# Go to Workers → mcp-api-worker → Deployments → Rollback
```

## Monitoring

1. **Real-time logs:**
   ```bash
   npx wrangler tail
   ```

2. **Analytics:**
   - Cloudflare dashboard → Workers → mcp-api-worker → Analytics

3. **Error tracking:**
   - Check worker logs for errors
   - Monitor KV operations in dashboard

## Best Practices

1. Always test locally before deploying
2. Use version control for all changes
3. Document any manual configuration changes
4. Monitor error rates after deployment
5. Keep KV namespace IDs in sync with wrangler.toml