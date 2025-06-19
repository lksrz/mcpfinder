import { z } from 'zod';
import fetch from 'node-fetch';

// Tool Schemas
export const SearchServersInput = z.object({
  query: z.string().optional().describe('Search query to find servers by name, tags, or description'),
  tag: z.string().optional().describe('Filter results by a specific tag'),
  capability: z.enum(['tool', 'resource', 'prompt']).optional().describe('Filter by capability type'),
  limit: z.number().optional().describe('Maximum number of results to return').default(10),
});

export const GetServerDetailsInput = z.object({
  name: z.string().describe('Exact name of the MCP server to look up'),
});

export const ListTrendingServersInput = z.object({
  limit: z.number().optional().describe('Number of trending servers to return').default(10),
});

// Tool implementations
export async function searchMCPServers(args, apiUrl) {
  const validated = SearchServersInput.parse(args);
  
  const params = new URLSearchParams();
  if (validated.query) params.set('q', validated.query);
  if (validated.tag) params.set('tag', validated.tag);
  if (validated.capability) params.set('capability', validated.capability);
  if (validated.limit) params.set('limit', validated.limit.toString());
  
  const response = await fetch(`${apiUrl}/api/v1/search?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to search servers: ${response.statusText}`);
  }
  
  const data = await response.json();
  
  if (!data.results || data.results.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'No MCP servers found matching your criteria.',
        },
      ],
    };
  }
  
  const resultsText = data.results.map((server, index) => {
    const tags = server.tags && server.tags.length > 0 ? `\n  Tags: ${server.tags.join(', ')}` : '';
    const capabilities = server.capabilities ? `\n  Capabilities: ${server.capabilities.map(c => `${c.type}(${c.name})`).join(', ')}` : '';
    return `${index + 1}. ${server.name}: ${server.description}${tags}${capabilities}`;
  }).join('\n\n');
  
  return {
    content: [
      {
        type: 'text',
        text: `Found ${data.results.length} MCP servers:\n\n${resultsText}`,
      },
    ],
  };
}

export async function getMCPServerDetails(args, apiUrl) {
  const validated = GetServerDetailsInput.parse(args);
  
  // First search for the server by name
  const searchResponse = await fetch(`${apiUrl}/api/v1/search?q=${encodeURIComponent(validated.name)}`);
  if (!searchResponse.ok) {
    throw new Error(`Failed to search for server: ${searchResponse.statusText}`);
  }
  
  const searchData = await searchResponse.json();
  const server = searchData.results?.find(s => s.name === validated.name);
  
  if (!server) {
    return {
      content: [
        {
          type: 'text',
          text: `Server "${validated.name}" not found in the registry.`,
        },
      ],
    };
  }
  
  // Get detailed information
  const detailsResponse = await fetch(`${apiUrl}/api/v1/tools/${server.id}`);
  if (!detailsResponse.ok) {
    throw new Error(`Failed to get server details: ${detailsResponse.statusText}`);
  }
  
  const details = await detailsResponse.json();
  
  let content = `# ${details.name}\n\n${details.description}\n\n`;
  content += `**URL:** ${details.url}\n`;
  content += `**Protocol Version:** ${details.protocol_version}\n`;
  
  if (details.tags && details.tags.length > 0) {
    content += `**Tags:** ${details.tags.join(', ')}\n`;
  }
  
  content += `\n**Capabilities:**\n`;
  details.capabilities.forEach(cap => {
    content += `- ${cap.name} (${cap.type}): ${cap.description || 'No description'}\n`;
  });
  
  if (details.installation_instructions) {
    content += `\n**Installation:**\n${details.installation_instructions}\n`;
  }
  
  return {
    content: [
      {
        type: 'text',
        text: content,
      },
    ],
  };
}

export async function listTrendingServers(args, apiUrl) {
  const validated = ListTrendingServersInput.parse(args);
  
  // For now, just get the most recently added servers
  const response = await fetch(`${apiUrl}/api/v1/search?limit=${validated.limit}`);
  if (!response.ok) {
    throw new Error(`Failed to list trending servers: ${response.statusText}`);
  }
  
  const data = await response.json();
  
  if (!data.results || data.results.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'No trending servers available.',
        },
      ],
    };
  }
  
  const resultsText = data.results.map((server, index) => {
    return `${index + 1}. ${server.name}: ${server.description}`;
  }).join('\n');
  
  return {
    content: [
      {
        type: 'text',
        text: `Top ${data.results.length} trending MCP servers:\n\n${resultsText}`,
      },
    ],
  };
}

// Tool definitions for MCP
export const TOOL_DEFINITIONS = [
  {
    name: 'search_mcp_servers',
    description: 'Search for MCP servers in the MCPfinder registry',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to find servers by name, tags, or description',
        },
        tag: {
          type: 'string',
          description: 'Filter results by a specific tag',
        },
        capability: {
          type: 'string',
          description: 'Filter by capability type',
          enum: ['tool', 'resource', 'prompt'],
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return',
          default: 10,
        },
      },
    },
  },
  {
    name: 'get_mcp_server_details',
    description: 'Get detailed information about a specific MCP server',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact name of the MCP server to look up',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_trending_servers',
    description: 'Get a list of trending MCP servers',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of trending servers to return',
          default: 10,
        },
      },
    },
  },
];

// Tool handler
export async function handleToolCall(toolName, args, apiUrl) {
  switch (toolName) {
    case 'search_mcp_servers':
      return await searchMCPServers(args, apiUrl);
    case 'get_mcp_server_details':
      return await getMCPServerDetails(args, apiUrl);
    case 'list_trending_servers':
      return await listTrendingServers(args, apiUrl);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}