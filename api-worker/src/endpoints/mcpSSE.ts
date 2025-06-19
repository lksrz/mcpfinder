import { Context } from 'hono';
import { Bindings } from '../types';

interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

const TOOLS: MCPTool[] = [
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

async function handleMCPRequest(
  request: MCPRequest,
  env: Bindings
): Promise<MCPResponse> {
  const { method, params, id } = request;

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'mcpfinder-sse',
              version: '0.1.0',
            },
          },
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS,
          },
        };

      case 'tools/call':
        return await handleToolCall(params, env, id);

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

async function handleToolCall(
  params: any,
  env: Bindings,
  id: string | number
): Promise<MCPResponse> {
  const { name, arguments: args } = params;

  try {
    switch (name) {
      case 'search_mcp_servers': {
        const searchParams = new URLSearchParams();
        if (args.query) searchParams.set('q', args.query);
        if (args.tag) searchParams.set('tag', args.tag);
        if (args.capability) searchParams.set('capability', args.capability);
        if (args.limit) searchParams.set('limit', args.limit.toString());

        const results = await env.MCP_TOOLS_KV.list({
          prefix: 'tool:',
          limit: args.limit || 10,
        });

        const tools = await Promise.all(
          results.keys.map(async (key) => {
            const data = await env.MCP_TOOLS_KV.get(key.name, 'json');
            return data;
          })
        );

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Found ${tools.length} MCP servers:\n\n${tools
                  .map(
                    (tool: any) =>
                      `• ${tool.name}: ${tool.description}\n  Tags: ${
                        tool.tags?.join(', ') || 'none'
                      }`
                  )
                  .join('\n\n')}`,
              },
            ],
          },
        };
      }

      case 'get_mcp_server_details': {
        const { name } = args;
        if (!name) {
          throw new Error('Server name is required');
        }

        // Search for the tool by name
        const results = await env.MCP_TOOLS_KV.list({ prefix: 'tool:' });
        let toolData = null;

        for (const key of results.keys) {
          const data = await env.MCP_TOOLS_KV.get(key.name, 'json');
          if (data && data.name === name) {
            toolData = data;
            break;
          }
        }

        if (!toolData) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Server "${name}" not found in the registry.`,
                },
              ],
            },
          };
        }

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `# ${toolData.name}\n\n${
                  toolData.description
                }\n\n**URL:** ${toolData.url}\n**Protocol:** ${
                  toolData.protocol_version
                }\n**Tags:** ${
                  toolData.tags?.join(', ') || 'none'
                }\n\n**Capabilities:**\n${toolData.capabilities
                  .map(
                    (cap: any) =>
                      `- ${cap.name} (${cap.type}): ${cap.description || 'No description'}`
                  )
                  .join('\n')}`,
              },
            ],
          },
        };
      }

      case 'list_trending_servers': {
        const limit = args.limit || 10;
        const results = await env.MCP_TOOLS_KV.list({
          prefix: 'tool:',
          limit,
        });

        const tools = await Promise.all(
          results.keys.map(async (key) => {
            const data = await env.MCP_TOOLS_KV.get(key.name, 'json');
            return data;
          })
        );

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Top ${tools.length} trending MCP servers:\n\n${tools
                  .map(
                    (tool: any, index: number) =>
                      `${index + 1}. ${tool.name}: ${tool.description}`
                  )
                  .join('\n')}`,
              },
            ],
          },
        };
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Unknown tool: ${name}`,
          },
        };
    }
  } catch (error: any) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: 'Tool execution failed',
        data: error.message,
      },
    };
  }
}

export async function mcpSSE(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  // Check if KV is available
  if (!c.env || !c.env.MCP_TOOLS_KV) {
    console.error('KV namespace not available');
    return c.json({ error: 'KV namespace not configured' }, 500);
  }

  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream({
    async start(ctrl) {
      controller = ctrl;

      // Send initial connection message
      controller.enqueue(encoder.encode(': connected\n\n'));

      // Handle incoming messages from the client
      // In SSE, the client sends messages via POST requests to a separate endpoint
      // For now, we'll set up the stream and wait for messages
      console.log('MCP SSE endpoint ready');
    },

    cancel() {
      console.log('Client disconnected from MCP SSE');
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

// Separate endpoint to handle MCP requests over SSE
export async function mcpSSERequest(
  c: Context<{ Bindings: Bindings }>
): Promise<Response> {
  try {
    const request = await c.req.json<MCPRequest>();
    
    if (!request.jsonrpc || request.jsonrpc !== '2.0') {
      return c.json(
        {
          jsonrpc: '2.0',
          id: request.id || null,
          error: {
            code: -32600,
            message: 'Invalid Request',
          },
        },
        400
      );
    }

    const response = await handleMCPRequest(request, c.env);
    return c.json(response);
  } catch (error: any) {
    return c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
          data: error.message,
        },
      },
      400
    );
  }
}