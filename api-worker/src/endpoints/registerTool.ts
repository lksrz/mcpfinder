import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex } from '@noble/hashes/utils';
import { v4 as uuidv4 } from 'uuid'; // Assuming uuid is installed or available globally
import { Bindings } from '../types'; // Import the correct Bindings type

// Remove Ajv imports and schema definition
// Define a custom validation function instead
function validateManifest(data: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Check required properties
  const requiredProps = ['name', 'description', 'url', 'protocol_version', 'capabilities'];
  requiredProps.forEach(prop => {
    if (data[prop] === undefined) {
      errors.push(`Missing required property: ${prop}`);
    }
  });
  
  // Validate name
  if (data.name !== undefined) {
    if (typeof data.name !== 'string') {
      errors.push('name must be a string');
    } else if (data.name.length < 1) {
      errors.push('name must not be empty');
    }
  }
  
  // Validate description
  if (data.description !== undefined) {
    if (typeof data.description !== 'string') {
      errors.push('description must be a string');
    } else if (data.description.length < 1) {
      errors.push('description must not be empty');
    }
  }
  
  // Validate url
  if (data.url !== undefined && typeof data.url !== 'string') {
    errors.push('url must be a string');
  }
  
  // Validate protocol_version
  if (data.protocol_version !== undefined) {
    if (typeof data.protocol_version !== 'string') {
      errors.push('protocol_version must be a string');
    } else {
      const protocolPattern = /^(MCP\/\d+\.\d+|\d{4}-\d{2}-\d{2})$/;
      if (!protocolPattern.test(data.protocol_version)) {
        errors.push('protocol_version must match pattern: MCP/x.y or YYYY-MM-DD');
      }
    }
  }
  
  // Validate capabilities
  if (data.capabilities !== undefined) {
    if (!Array.isArray(data.capabilities)) {
      errors.push('capabilities must be an array');
    } else if (data.capabilities.length < 1) {
      errors.push('capabilities must have at least one item');
    } else {
      data.capabilities.forEach((cap: any, index: number) => {
        if (typeof cap !== 'object' || Array.isArray(cap)) {
          errors.push(`capabilities[${index}] must be an object`);
        } else {
          if (cap.name === undefined) {
            errors.push(`capabilities[${index}] missing required property: name`);
          } else if (typeof cap.name !== 'string') {
            errors.push(`capabilities[${index}].name must be a string`);
          }
          
          if (cap.type === undefined) {
            errors.push(`capabilities[${index}] missing required property: type`);
          } else if (typeof cap.type !== 'string') {
            errors.push(`capabilities[${index}].type must be a string`);
          } else if (!['tool', 'resource', 'prompt'].includes(cap.type)) {
            errors.push(`capabilities[${index}].type must be one of: tool, resource, prompt`);
          }
          
          if (cap.description !== undefined && typeof cap.description !== 'string') {
            errors.push(`capabilities[${index}].description must be a string`);
          }
        }
      });
    }
  }
  
  // Validate tags
  if (data.tags !== undefined) {
    if (!Array.isArray(data.tags)) {
      errors.push('tags must be an array');
    } else {
      const tagPattern = /^[a-z0-9-]+$/;
      const tagValues = new Set<string>();
      
      data.tags.forEach((tag: any, index: number) => {
        if (typeof tag !== 'string') {
          errors.push(`tags[${index}] must be a string`);
        } else {
          if (!tagPattern.test(tag)) {
            errors.push(`tags[${index}] must match pattern: ^[a-z0-9-]+$`);
          }
          
          // Check for duplicates
          if (tagValues.has(tag)) {
            errors.push(`tags must not contain duplicate values (${tag})`);
          } else {
            tagValues.add(tag);
          }
        }
      });
    }
  }
  
  // Validate auth
  if (data.auth !== undefined) {
    if (typeof data.auth !== 'object' || Array.isArray(data.auth)) {
      errors.push('auth must be an object');
    } else {
      if (data.auth.type === undefined) {
        errors.push('auth missing required property: type');
      } else if (typeof data.auth.type !== 'string') {
        errors.push('auth.type must be a string');
      } else if (!['none', 'api-key', 'oauth', 'hmac', 'custom'].includes(data.auth.type)) {
        errors.push('auth.type must be one of: none, api-key, oauth, hmac, custom');
      }
      
      if (data.auth.instructions !== undefined && typeof data.auth.instructions !== 'string') {
        errors.push('auth.instructions must be a string');
      }
      
      if (data.auth.key_name !== undefined && typeof data.auth.key_name !== 'string') {
        errors.push('auth.key_name must be a string');
      }
    }
  }
  
  // Check for additional properties
  const allowedProps = ['name', 'description', 'url', 'protocol_version', 'capabilities', 'tags', 'auth'];
  Object.keys(data).forEach(key => {
    if (!allowedProps.includes(key)) {
      errors.push(`Additional property not allowed: ${key}`);
    }
  });
  
  return {
    valid: errors.length === 0,
    errors
  };
}

async function verifyHmac(secret: string, body: string, signature: string): Promise<boolean> {
    if (!secret || !body || !signature) return false;
    try {
        const encoder = new TextEncoder();
        const expectedSignature = bytesToHex(hmac(sha256, encoder.encode(secret), encoder.encode(body)));
        return expectedSignature === signature;
    } catch (error) {
        console.error("HMAC verification error:", error);
        return false;
    }
}

// Define an interface for the expected manifest structure
interface McpManifest {
    name: string;
    description: string;
    url: string;
    protocol_version: string;
    capabilities: Array<{ name: string; type: string; description?: string }>;
    tags?: string[];
    auth?: { type: string; instructions?: string; key_name?: string };
    // Allow other properties potentially added during validation/processing
    [key: string]: any;
}

// Use the correct Bindings type in the Context generic
export const registerTool = async (c: Context<{ Bindings: Bindings }>) => {
    console.log("Available env bindings:", c.env);
    // Remove the explicit cast, c.env should now be correctly typed
    // const env = c.env as Env['Bindings'];

    const rawBody = await c.req.text();
    const signatureHeader = c.req.header('Authorization');

    if (!signatureHeader || !signatureHeader.startsWith('HMAC ')) {
        throw new HTTPException(401, { message: 'Authorization header missing or invalid' });
    }

    const signature = signatureHeader.substring(5); // Remove 'HMAC '
    // Use c.env directly
    const secret = c.env.MCP_REGISTRY_SECRET;

    if (!secret) {
        console.error('MCP_REGISTRY_SECRET is not configured in environment');
        throw new HTTPException(500, { message: 'Server configuration error' });
    }

    const isValidHmac = await verifyHmac(secret, rawBody, signature);
    if (!isValidHmac) {
        throw new HTTPException(401, { message: 'Invalid HMAC signature' });
    }

    let manifestData: McpManifest;
    try {
        manifestData = JSON.parse(rawBody) as McpManifest;
    } catch (e) {
        throw new HTTPException(400, { message: 'Invalid JSON body' });
    }

    // Use custom validation instead of Ajv
    const validation = validateManifest(manifestData);
    if (!validation.valid) {
        throw new HTTPException(400, {
            message: 'Manifest validation failed',
            cause: validation.errors,
        });
    }

    // Generate ID
    const toolId = uuidv4();
    const kvKey = `tool:${toolId}`;
    const r2Key = `manifests/${toolId}.json`;

    // Add metadata before storing
    const storedManifest = {
        ...manifestData,
        _id: toolId,
        _registeredAt: new Date().toISOString(),
        _status: 'unknown',
        _lastChecked: null
    };

    try {
        // Use c.env directly
        await c.env.MCP_TOOLS_KV.put(kvKey, JSON.stringify(storedManifest));
        await c.env.MCP_MANIFEST_BACKUPS.put(r2Key, rawBody);

        // TODO: Implement simplified search indexing if needed for MVP

        return c.json({ success: true, id: toolId }, 201);
    } catch (error: any) {
        console.error('Error storing manifest:', error);
        // Attempt cleanup if possible (optional)
        // await c.env.MCP_TOOLS_KV.delete(kvKey);
        // await c.env.MCP_MANIFEST_BACKUPS.delete(r2Key);
        throw new HTTPException(500, { message: 'Failed to store tool manifest', cause: error.message });
    }
}; 