import { Context } from 'hono';
import { Bindings } from '../types';
import { v4 as uuidv4 } from 'uuid';

interface MCPRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

// Session storage (in production, use KV or Durable Objects)
const sessions = new Map<string, any>();

// Tool definitions
const TOOLS = [
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
  {
    name: 'test_echo',
    description: 'Test tool that echoes back the input',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Message to echo back',
        },
      },
      required: ['message'],
    },
  },
];

async function handleToolCall(name: string, args: any, env: Bindings): Promise<any> {
  const apiUrl = env.MCPFINDER_API_URL || 'https://mcpfinder.dev';
  
  switch (name) {
    case 'search_mcp_servers': {
      // Use KV directly
      if (!env.MCP_TOOLS_KV) {
        throw new Error('KV namespace not available');
      }
      
      try {
        const limit = args.limit || 10;
        // Get all tools from KV (up to 1000)
        const kvResults = await env.MCP_TOOLS_KV.list({ prefix: 'tool:', limit: 1000 });
        
        // Fetch all tool data
        const tools = await Promise.all(
          kvResults.keys.map(async (key) => {
            const data = await env.MCP_TOOLS_KV.get(key.name, 'json');
            return data;
          })
        );
        
        // Filter out null results
        let results = tools.filter(t => t != null);
        
        // Filter by query
        if (args.query) {
          const query = args.query.toLowerCase();
          results = results.filter((server: any) => 
            server.name?.toLowerCase().includes(query) ||
            server.description?.toLowerCase().includes(query) ||
            (server.tags && server.tags.some((tag: string) => tag.toLowerCase().includes(query)))
          );
        }
        
        // Filter by tag
        if (args.tag) {
          results = results.filter((server: any) =>
            server.tags && server.tags.includes(args.tag)
          );
        }
        
        // Filter by capability
        if (args.capability) {
          results = results.filter((server: any) =>
            server.capabilities && server.capabilities.some((cap: any) => cap.type === args.capability)
          );
        }
        
        // Limit results
        results = results.slice(0, limit);
        
        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No MCP servers found matching your criteria.',
              },
            ],
          };
        }
        
        const resultsText = results.map((server: any, index: number) => {
          const tags = server.tags && server.tags.length > 0 ? `\n  Tags: ${server.tags.join(', ')}` : '';
          const capabilities = server.capabilities ? `\n  Capabilities: ${server.capabilities.map((c: any) => `${c.type}(${c.name})`).join(', ')}` : '';
          return `${index + 1}. ${server.name}: ${server.description}${tags}${capabilities}`;
        }).join('\n\n');
        
        return {
          content: [
            {
              type: 'text',
              text: `Found ${results.length} MCP servers:\n\n${resultsText}`,
            },
          ],
        };
      } catch (error: any) {
        throw new Error(`Failed to search servers: ${error.message}`);
      }
    }
    
    case 'get_mcp_server_details': {
      // Use KV directly
      if (!env.MCP_TOOLS_KV) {
        throw new Error('KV namespace not available');
      }
      
      try {
        const { name } = args;
        if (!name) {
          throw new Error('Server name is required');
        }
        
        // Search for the tool by name in KV
        const kvResults = await env.MCP_TOOLS_KV.list({ prefix: 'tool:' });
        let toolData = null;
        let toolKey = null;
        
        for (const key of kvResults.keys) {
          const data = await env.MCP_TOOLS_KV.get(key.name, 'json');
          if (data && data.name === name) {
            toolData = data;
            toolKey = key.name;
            break;
          }
        }
        
        if (!toolData) {
          return {
            content: [
              {
                type: 'text',
                text: `Server "${name}" not found in the registry.`,
              },
            ],
          };
        }
        
        let content = `# ${toolData.name}\n\n${toolData.description}\n\n`;
        content += `**URL:** ${toolData.url}\n`;
        content += `**Protocol Version:** ${toolData.protocol_version}\n`;
        
        if (toolData.tags && toolData.tags.length > 0) {
          content += `**Tags:** ${toolData.tags.join(', ')}\n`;
        }
        
        content += `\n**Capabilities:**\n`;
        if (toolData.capabilities && toolData.capabilities.length > 0) {
          toolData.capabilities.forEach((cap: any) => {
            content += `- ${cap.name} (${cap.type}): ${cap.description || 'No description'}\n`;
          });
        } else {
          content += `- No capabilities listed\n`;
        }
        
        // Add metadata if available
        if (toolData.created_at) {
          content += `\n**Created:** ${new Date(toolData.created_at).toLocaleString()}\n`;
        }
        if (toolData.updated_at) {
          content += `**Updated:** ${new Date(toolData.updated_at).toLocaleString()}\n`;
        }
        
        return {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        };
      } catch (error: any) {
        throw new Error(`Failed to get server details: ${error.message}`);
      }
    }
    
    case 'list_trending_servers': {
      // Use KV directly
      if (!env.MCP_TOOLS_KV) {
        throw new Error('KV namespace not available');
      }
      
      try {
        const limit = args.limit || 10;
        // Get recent tools from KV
        const kvResults = await env.MCP_TOOLS_KV.list({ prefix: 'tool:', limit });
        
        // Fetch tool data
        const tools = await Promise.all(
          kvResults.keys.map(async (key) => {
            const data = await env.MCP_TOOLS_KV.get(key.name, 'json');
            return data;
          })
        );
        
        // Filter out null results
        const results = tools.filter(t => t != null);
        
        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No trending servers available.',
              },
            ],
          };
        }
        
        const resultsText = results.map((server: any, index: number) => {
          return `${index + 1}. ${server.name}: ${server.description}`;
        }).join('\n');
        
        return {
          content: [
            {
              type: 'text',
              text: `Top ${results.length} trending MCP servers:\n\n${resultsText}`,
            },
          ],
        };
      } catch (error: any) {
        throw new Error(`Failed to list trending servers: ${error.message}`);
      }
    }
    
    case 'test_echo': {
      return {
        content: [
          {
            type: 'text',
            text: `Echo: ${args.message || 'No message provided'}`,
          },
        ],
      };
    }
    
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMCPRequest(request: MCPRequest, env: Bindings, sessionId?: string): Promise<MCPResponse> {
  const { method, params, id } = request;

  try {
    switch (method) {
      case 'initialize': {
        // Store session info if needed
        if (sessionId) {
          sessions.set(sessionId, {
            initialized: true,
            clientInfo: params.clientInfo,
          });
        }
        
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'mcpfinder-http',
              version: '0.1.0',
            },
          },
        };
      }

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS,
          },
        };

      case 'tools/call': {
        const result = await handleToolCall(params.name, params.arguments || {}, env);
        return {
          jsonrpc: '2.0',
          id,
          result,
        };
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: 'Method not found',
          },
        };
    }
  } catch (error: any) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: 'Internal error',
        data: error.message,
      },
    };
  }
}

export async function mcpHTTP(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  // Handle CORS preflight
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id',
      },
    });
  }

  // Handle GET requests for SSE
  if (c.req.method === 'GET') {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Send initial connection event
        controller.enqueue(encoder.encode('event: open\ndata: {"type":"connection","status":"connected"}\n\n'));
        
        // Keep connection alive with heartbeat
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          } catch (e) {
            clearInterval(heartbeat);
          }
        }, 15000);
        
        // Close after 25 seconds (Cloudflare limit)
        setTimeout(() => {
          clearInterval(heartbeat);
          controller.enqueue(encoder.encode('event: close\ndata: {"type":"connection","status":"closing"}\n\n'));
          controller.close();
        }, 25000);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // Handle POST requests for JSON-RPC
  if (c.req.method === 'POST') {
    try {
      const request = await c.req.json<MCPRequest>();
      
      if (!request.jsonrpc || request.jsonrpc !== '2.0') {
        return c.json({
          jsonrpc: '2.0',
          id: request.id || null,
          error: {
            code: -32600,
            message: 'Invalid Request',
          },
        }, 400);
      }

      // Handle session ID
      let sessionId = c.req.header('Mcp-Session-Id');
      
      // Generate session ID for initialize requests
      if (request.method === 'initialize' && !sessionId) {
        sessionId = uuidv4();
      }

      const response = await handleMCPRequest(request, c.env, sessionId);
      
      // Add session ID header for initialize responses
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id',
      };
      
      if (request.method === 'initialize' && sessionId) {
        headers['Mcp-Session-Id'] = sessionId;
      }
      
      return new Response(JSON.stringify(response), { headers });
    } catch (error: any) {
      return c.json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
          data: error.message,
        },
      }, 400);
    }
  }

  return c.json({ error: 'Method not allowed' }, 405);
}