import { Context } from 'hono';
import { Bindings } from '../types';

export async function testKV(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  try {
    // Check if env exists
    if (!c.env) {
      return c.json({ error: 'Environment not available' }, 500);
    }

    // Check if KV binding exists
    if (!c.env.MCP_TOOLS_KV) {
      return c.json({ 
        error: 'KV binding not available',
        env: Object.keys(c.env),
        hasKV: 'MCP_TOOLS_KV' in c.env
      }, 500);
    }

    // Try to use KV
    const testKey = 'test:' + Date.now();
    await c.env.MCP_TOOLS_KV.put(testKey, 'test value');
    const value = await c.env.MCP_TOOLS_KV.get(testKey);
    await c.env.MCP_TOOLS_KV.delete(testKey);

    return c.json({ 
      success: true,
      kvAvailable: true,
      testResult: value === 'test value'
    });
  } catch (error: any) {
    return c.json({ 
      error: 'KV operation failed',
      message: error.message,
      stack: error.stack
    }, 500);
  }
}