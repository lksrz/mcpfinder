import { Context } from 'hono';
import { Bindings } from '../types';

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

// Tool definitions - matching the mcpfinder-server tools
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
];

class MCPSSEHandler {
  private env: Bindings;
  private controller: ReadableStreamDefaultController<Uint8Array>;
  private encoder = new TextEncoder();
  private messageQueue: MCPRequest[] = [];

  constructor(env: Bindings, controller: ReadableStreamDefaultController<Uint8Array>) {
    this.env = env;
    this.controller = controller;
  }

  private sendSSE(message: SSEMessage) {
    let sseString = '';
    if (message.event) {
      sseString += `event: ${message.event}\n`;
    }
    sseString += `data: ${message.data}\n\n`;
    this.controller.enqueue(this.encoder.encode(sseString));
  }

  private sendResponse(response: MCPResponse) {
    this.sendSSE({
      event: 'message',
      data: JSON.stringify(response),
    });
  }

  async handleRequest(request: MCPRequest) {
    const { method, params, id } = request;

    try {
      switch (method) {
        case 'initialize':
          this.sendResponse({
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
          });
          break;

        case 'tools/list':
          this.sendResponse({
            jsonrpc: '2.0',
            id,
            result: {
              tools: TOOLS,
            },
          });
          break;

        case 'tools/call':
          await this.handleToolCall(params, id!);
          break;

        default:
          this.sendResponse({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: 'Method not found',
            },
          });
      }
    } catch (error: any) {
      this.sendResponse({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: 'Internal error',
          data: error.message,
        },
      });
    }
  }

  private async handleToolCall(params: any, id: string | number) {
    const { name, arguments: args } = params;

    try {
      switch (name) {
        case 'search_mcp_servers': {
          const results = await this.env.MCP_TOOLS_KV.list({
            prefix: 'tool:',
            limit: args.limit || 10,
          });

          const tools = await Promise.all(
            results.keys.map(async (key) => {
              const data = await this.env.MCP_TOOLS_KV.get(key.name, 'json');
              return data;
            })
          );

          // Filter by query if provided
          let filteredTools = tools;
          if (args.query) {
            const query = args.query.toLowerCase();
            filteredTools = tools.filter((tool: any) => 
              tool.name.toLowerCase().includes(query) ||
              tool.description.toLowerCase().includes(query) ||
              (tool.tags && tool.tags.some((tag: string) => tag.toLowerCase().includes(query)))
            );
          }

          // Filter by tag if provided
          if (args.tag) {
            filteredTools = filteredTools.filter((tool: any) =>
              tool.tags && tool.tags.includes(args.tag)
            );
          }

          // Filter by capability if provided
          if (args.capability) {
            filteredTools = filteredTools.filter((tool: any) =>
              tool.capabilities && tool.capabilities.some((cap: any) => cap.type === args.capability)
            );
          }

          this.sendResponse({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Found ${filteredTools.length} MCP servers:\n\n${filteredTools
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
          });
          break;
        }

        case 'get_mcp_server_details': {
          const { name } = args;
          if (!name) {
            throw new Error('Server name is required');
          }

          const results = await this.env.MCP_TOOLS_KV.list({ prefix: 'tool:' });
          let toolData = null;

          for (const key of results.keys) {
            const data = await this.env.MCP_TOOLS_KV.get(key.name, 'json');
            if (data && data.name === name) {
              toolData = data;
              break;
            }
          }

          if (!toolData) {
            this.sendResponse({
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
            });
            return;
          }

          this.sendResponse({
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
          });
          break;
        }

        case 'list_trending_servers': {
          const limit = args.limit || 10;
          const results = await this.env.MCP_TOOLS_KV.list({
            prefix: 'tool:',
            limit,
          });

          const tools = await Promise.all(
            results.keys.map(async (key) => {
              const data = await this.env.MCP_TOOLS_KV.get(key.name, 'json');
              return data;
            })
          );

          this.sendResponse({
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
          });
          break;
        }

        default:
          this.sendResponse({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Unknown tool: ${name}`,
            },
          });
      }
    } catch (error: any) {
      this.sendResponse({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: 'Tool execution failed',
          data: error.message,
        },
      });
    }
  }

  async processMessageQueue() {
    // Process any queued messages
    while (this.messageQueue.length > 0) {
      const request = this.messageQueue.shift()!;
      await this.handleRequest(request);
    }
  }
}

export async function mcpSSETransport(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  // Check if KV is available
  if (!c.env || !c.env.MCP_TOOLS_KV) {
    console.error('KV namespace not available');
    return c.json({ error: 'KV namespace not configured' }, 500);
  }

  // Get request ID from query params (for message correlation)
  const requestId = c.req.query('requestId');
  
  // For SSE transport, we need to handle both GET (for SSE stream) and POST (for sending messages)
  if (c.req.method === 'POST') {
    // Handle incoming MCP request
    try {
      const request = await c.req.json<MCPRequest>();
      
      // Store the request in KV for the SSE handler to process
      if (requestId) {
        await c.env.MCP_TOOLS_KV.put(
          `mcp-request:${requestId}`,
          JSON.stringify(request),
          { expirationTtl: 60 } // 1 minute TTL
        );
      }
      
      return c.json({ success: true });
    } catch (error: any) {
      return c.json({ error: 'Invalid request' }, 400);
    }
  }

  // Handle SSE stream
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let handler: MCPSSEHandler;

  const stream = new ReadableStream({
    async start(ctrl) {
      controller = ctrl;
      handler = new MCPSSEHandler(c.env, controller);

      // Send initial connection event
      controller.enqueue(encoder.encode('event: open\ndata: {"type":"connection","status":"connected"}\n\n'));

      // Set up polling for incoming requests if requestId is provided
      if (requestId) {
        const pollInterval = setInterval(async () => {
          try {
            const requestData = await c.env.MCP_TOOLS_KV.get(`mcp-request:${requestId}`, 'json');
            if (requestData) {
              // Delete the request from KV
              await c.env.MCP_TOOLS_KV.delete(`mcp-request:${requestId}`);
              
              // Process the request
              await handler.handleRequest(requestData as MCPRequest);
            }
          } catch (error) {
            console.error('Error polling for requests:', error);
          }
        }, 100); // Poll every 100ms

        // Clean up on disconnect
        setTimeout(() => {
          clearInterval(pollInterval);
          controller.enqueue(encoder.encode('event: close\ndata: {"type":"connection","status":"disconnected"}\n\n'));
          controller.close();
        }, 25000); // Close after 25 seconds (Cloudflare limit)
      }
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
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}