#!/usr/bin/env node
/**
 * MCPfinder MCP Server
 * Search engine for MCP servers — find the right tool for any task.
 * Aggregates Official MCP Registry, Glama, and Smithery with full-text search.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  initDatabase,
  syncOfficialRegistry,
  syncGlamaRegistry,
  syncSmitheryRegistry,
  isSyncNeeded,
  getServerCount,
  searchServers,
  getServerDetails,
  getInstallCommand,
  listCategories,
  getServersByCategory,
} from '@mcpfinder/core';

// Initialize database
const db = initDatabase();

// Create MCP server
const server = new McpServer({
  name: 'mcpfinder',
  version: '1.1.0',
});

/**
 * Format use count for display (e.g., 7900000 -> "7.9M")
 */
function formatUseCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

/**
 * Build source badges string for display.
 */
function sourceBadges(sources: string[], useCount: number, verified: boolean): string {
  const badges: string[] = [];
  if (sources.includes('official')) badges.push('📦 Official');
  if (sources.includes('smithery')) {
    let badge = '🌟 Smithery';
    if (useCount > 0) badge += ` (${formatUseCount(useCount)} uses)`;
    if (verified) badge += ' ✓';
    badges.push(badge);
  }
  if (sources.includes('glama')) badges.push('🔍 Glama');
  return badges.length > 0 ? badges.join(' | ') : '';
}

/**
 * Ensure data is synced before handling requests.
 * Syncs all three registries, failing gracefully per-registry.
 */
async function ensureSync(): Promise<void> {
  const count = getServerCount(db);
  if (count === 0 || isSyncNeeded(db)) {
    // Sync all registries in parallel, each handles its own errors
    const results = await Promise.allSettled([
      syncOfficialRegistry(db),
      syncGlamaRegistry(db),
      syncSmitheryRegistry(db),
    ]);

    const counts = results.map((r) => (r.status === 'fulfilled' ? r.value : 0));
    process.stderr.write(
      `[mcpfinder] Synced: Official=${counts[0]}, Glama=${counts[1]}, Smithery=${counts[2]} (${getServerCount(db)} total)\n`,
    );
  }
}

// ─── Tool: search_mcp_servers ───────────────────────────────────────────────

server.tool(
  'search_mcp_servers',
  'Search for MCP servers by keyword, use case, or technology. Returns ranked results from Official Registry, Glama, and Smithery.',
  {
    query: z.string().describe(
      'Search query — a keyword (e.g., "filesystem"), use case ("query databases"), or technology ("postgres")',
    ),
    limit: z.number().min(1).max(50).default(10).describe('Maximum results to return (default: 10, max: 50)'),
    transportType: z
      .enum(['stdio', 'streamable-http', 'sse', 'any'])
      .default('any')
      .describe('Filter by transport type'),
    registryType: z
      .enum(['npm', 'pypi', 'oci', 'any'])
      .default('any')
      .describe('Filter by package registry type'),
    registrySource: z
      .enum(['official', 'glama', 'smithery', 'any'])
      .default('any')
      .describe('Filter by registry source'),
  },
  async ({ query, limit, transportType, registryType, registrySource }) => {
    await ensureSync();

    const results = searchServers(db, query, limit, {
      transportType: transportType === 'any' ? undefined : transportType,
      registryType: registryType === 'any' ? undefined : registryType,
      registrySource: registrySource === 'any' ? undefined : registrySource,
    });

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No servers found for "${query}". Try a different search term.`,
          },
        ],
      };
    }

    const formatted = results
      .map((r) => {
        const badges = sourceBadges(r.sources, r.useCount, r.verified);
        return (
          `${r.rank}. **${r.name}** (v${r.version || 'n/a'})\n` +
          `   ${r.description}\n` +
          `   Package: ${r.packageIdentifier || 'N/A'} | Transport: ${r.transportType || 'N/A'}` +
          (r.hasRemote ? ' | 🌐 Remote available' : '') +
          (badges ? `\n   ${badges}` : '')
        );
      })
      .join('\n\n');

    return {
      content: [
        {
          type: 'text' as const,
          text: `Found ${results.length} MCP server(s) for "${query}":\n\n${formatted}`,
        },
      ],
    };
  },
);

// ─── Tool: get_server_details ───────────────────────────────────────────────

server.tool(
  'get_server_details',
  'Get detailed information about a specific MCP server, including install instructions and configuration.',
  {
    name: z.string().describe('Server name (e.g., "io.modelcontextprotocol/filesystem") or slug (e.g., "filesystem")'),
  },
  async ({ name }) => {
    await ensureSync();

    const detail = getServerDetails(db, name);
    if (!detail) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Server "${name}" not found. Try searching with search_mcp_servers first.`,
          },
        ],
      };
    }

    const envSection =
      detail.environmentVariables.length > 0
        ? '\n\n**Environment Variables:**\n' +
          detail.environmentVariables
            .map(
              (v) =>
                `- \`${v.name}\`: ${v.description || 'No description'}${v.isSecret ? ' (secret)' : ''}`,
            )
            .join('\n')
        : '';

    const badges = sourceBadges(detail.sources, detail.useCount, detail.verified);

    const text = [
      `# ${detail.name}`,
      '',
      detail.description,
      '',
      `**Version:** ${detail.version || 'N/A'}`,
      `**Status:** ${detail.status}`,
      `**Package:** ${detail.packageIdentifier || 'N/A'} (${detail.registryType || 'unknown'})`,
      `**Transport:** ${detail.transportType || 'N/A'}`,
      `**Repository:** ${detail.repositoryUrl || 'N/A'}`,
      detail.hasRemote ? `**Remote URL:** ${detail.remoteUrl}` : '',
      `**Published:** ${detail.publishedAt || 'N/A'}`,
      `**Updated:** ${detail.updatedAt || 'N/A'}`,
      detail.categories.length > 0 ? `**Categories:** ${detail.categories.join(', ')}` : '',
      badges ? `**Sources:** ${badges}` : '',
      detail.useCount > 0 ? `**Popularity:** ${formatUseCount(detail.useCount)} uses` : '',
      detail.verified ? '**Verified:** ✓' : '',
      envSection,
    ]
      .filter(Boolean)
      .join('\n');

    return {
      content: [{ type: 'text' as const, text }],
    };
  },
);

// ─── Tool: get_install_command ──────────────────────────────────────────────

server.tool(
  'get_install_command',
  'Get the exact install/configuration for an MCP server, ready to paste into Claude Desktop, Cursor, or other MCP clients.',
  {
    name: z.string().describe('Server name or slug'),
    client: z
      .enum(['claude-desktop', 'cursor', 'vscode', 'generic'])
      .default('claude-desktop')
      .describe('Target MCP client for install instructions'),
  },
  async ({ name, client }) => {
    await ensureSync();

    const result = getInstallCommand(db, name, client);
    if (!result) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Server "${name}" not found. Try searching with search_mcp_servers first.`,
          },
        ],
      };
    }

    let text = result.instructions;
    if (result.envVarsNeeded.length > 0) {
      text +=
        '\n\n**Required environment variables:**\n' +
        result.envVarsNeeded
          .map(
            (v: { name: string; description?: string; isSecret?: boolean }) =>
              `- \`${v.name}\`: ${v.description || 'No description'}${v.isSecret ? ' ⚠️ secret' : ''}`,
          )
          .join('\n');
    }

    return {
      content: [{ type: 'text' as const, text }],
    };
  },
);

// ─── Tool: list_categories ──────────────────────────────────────────────────

server.tool(
  'list_categories',
  'List all MCP server categories with server counts. Categories are derived from server names and descriptions.',
  {},
  async () => {
    await ensureSync();

    const categories = listCategories(db);

    if (categories.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No categories found. The database may be empty.',
          },
        ],
      };
    }

    const formatted = categories
      .map((c: { name: string; count: number }) => `- **${c.name}** (${c.count} servers)`)
      .join('\n');

    return {
      content: [
        {
          type: 'text' as const,
          text: `MCP Server Categories:\n\n${formatted}\n\nUse browse_category to inspect one category, or search_mcp_servers for free-form queries.`,
        },
      ],
    };
  },
);

// ─── Tool: browse_category ─────────────────────────────────────────────────

server.tool(
  'browse_category',
  'Browse MCP servers inside a specific category like database, filesystem, api, ai, security, etc.',
  {
    category: z.string().describe('Category name from list_categories output'),
    limit: z.number().min(1).max(50).default(20).describe('Maximum results to return (default: 20, max: 50)'),
  },
  async ({ category, limit }) => {
    await ensureSync();

    const servers = getServersByCategory(db, category.toLowerCase(), limit);

    if (servers.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No servers found in category "${category}". Use list_categories to see available categories.`,
          },
        ],
      };
    }

    const formatted = servers
      .map((s, idx) => `${idx + 1}. **${s.name}** (v${s.version})\n   ${s.description}`)
      .join('\n\n');

    return {
      content: [
        {
          type: 'text' as const,
          text: `Servers in category "${category}" (${servers.length}):\n\n${formatted}`,
        },
      ],
    };
  },
);

// ─── Start the server ───────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
