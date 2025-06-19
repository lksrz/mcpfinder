#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import EventSource from 'eventsource';

const API_URL = process.env.MCPFINDER_API_URL || 'http://localhost:8787/api/v1';

class MCPSSEServer {
  constructor() {
    this.server = new Server(
      {
        name: 'mcp-sse-events',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    this.eventSource = null;
    this.events = [];
    this.maxEvents = 100;
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'connect_to_events',
          description: 'Connect to MCPfinder SSE event stream',
          inputSchema: {
            type: 'object',
            properties: {
              filter: {
                type: 'string',
                description: 'Comma-separated event types to filter (e.g., "tool.registered,tool.updated")',
              },
              since: {
                type: 'string',
                description: 'ISO timestamp to get events from (default: last hour)',
              },
            },
          },
        },
        {
          name: 'disconnect_from_events',
          description: 'Disconnect from MCPfinder SSE event stream',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_recent_events',
          description: 'Get recent events from the buffer',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Number of recent events to return (default: 10, max: 100)',
              },
            },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'connect_to_events':
          return await this.connectToEvents(args);
        case 'disconnect_from_events':
          return await this.disconnectFromEvents();
        case 'get_recent_events':
          return await this.getRecentEvents(args);
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  async connectToEvents(args) {
    if (this.eventSource) {
      return {
        content: [
          {
            type: 'text',
            text: 'Already connected to event stream',
          },
        ],
      };
    }

    const url = new URL(`${API_URL}/events`);
    if (args.filter) {
      url.searchParams.set('filter', args.filter);
    }
    if (args.since) {
      url.searchParams.set('since', args.since);
    }

    return new Promise((resolve) => {
      this.eventSource = new EventSource(url.toString());
      
      this.eventSource.onopen = () => {
        console.error('Connected to SSE stream');
        resolve({
          content: [
            {
              type: 'text',
              text: `Connected to MCPfinder event stream at ${url.toString()}`,
            },
          ],
        });
      };

      this.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.addEvent(data);
          console.error(`Event received: ${data.type} - ${data.data.name}`);
        } catch (e) {
          console.error('Failed to parse event:', e);
        }
      };

      this.eventSource.addEventListener('tool.registered', (event) => {
        try {
          const data = JSON.parse(event.data);
          this.addEvent(data);
          console.error(`New tool registered: ${data.data.name}`);
        } catch (e) {
          console.error('Failed to parse tool.registered event:', e);
        }
      });

      this.eventSource.addEventListener('tool.updated', (event) => {
        try {
          const data = JSON.parse(event.data);
          this.addEvent(data);
          console.error(`Tool updated: ${data.data.name}`);
        } catch (e) {
          console.error('Failed to parse tool.updated event:', e);
        }
      });

      this.eventSource.addEventListener('tool.status_changed', (event) => {
        try {
          const data = JSON.parse(event.data);
          this.addEvent(data);
          console.error(`Tool status changed: ${data.data.name} - ${data.data.previousStatus} → ${data.data.currentStatus}`);
        } catch (e) {
          console.error('Failed to parse tool.status_changed event:', e);
        }
      });

      this.eventSource.addEventListener('close', (event) => {
        const data = JSON.parse(event.data);
        console.error('Server closed connection:', data.reason);
        // Auto-reconnect will be handled by EventSource
      });

      this.eventSource.onerror = (error) => {
        console.error('SSE connection error:', error);
        if (this.eventSource.readyState === EventSource.CLOSED) {
          console.error('Connection closed, will auto-reconnect...');
        }
      };
    });
  }

  async disconnectFromEvents() {
    if (!this.eventSource) {
      return {
        content: [
          {
            type: 'text',
            text: 'Not connected to event stream',
          },
        ],
      };
    }

    this.eventSource.close();
    this.eventSource = null;
    
    return {
      content: [
        {
          type: 'text',
          text: 'Disconnected from MCPfinder event stream',
        },
      ],
    };
  }

  async getRecentEvents(args) {
    const limit = Math.min(args.limit || 10, this.maxEvents);
    const recentEvents = this.events.slice(-limit);
    
    if (recentEvents.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No events in buffer. Connect to the event stream first.',
          },
        ],
      };
    }

    const eventList = recentEvents.map(event => {
      const timestamp = new Date(event.timestamp).toLocaleString();
      let details = `[${timestamp}] ${event.type}: ${event.data.name}`;
      
      if (event.data.description) {
        details += `\n  Description: ${event.data.description}`;
      }
      if (event.data.changes && event.data.changes.length > 0) {
        details += `\n  Changes: ${event.data.changes.join(', ')}`;
      }
      if (event.data.previousStatus && event.data.currentStatus) {
        details += `\n  Status: ${event.data.previousStatus} → ${event.data.currentStatus}`;
      }
      
      return details;
    }).join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `Recent events (${recentEvents.length}):\n\n${eventList}`,
        },
      ],
    };
  }

  addEvent(event) {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('MCP SSE Server running on stdio');
  }
}

const server = new MCPSSEServer();
server.run().catch(console.error);