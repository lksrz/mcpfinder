import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex } from '@noble/hashes/utils';
import { v4 as uuidv4 } from 'uuid'; // Assuming uuid is installed or available globally
import { Bindings } from '../types'; // Import the correct Bindings type
import { createEvent } from './streamEvents'; // Import event creation helper

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
  const allowedProps = ['name', 'description', 'url', 'protocol_version', 'capabilities', 'tags', 'auth', 'installation'];
  Object.keys(data).forEach(key => {
    if (!allowedProps.includes(key)) {
      errors.push(`Additional property not allowed: ${key}`);
    }
  });
  
  // Validate installation (if provided)
  if (data.installation !== undefined) {
    if (typeof data.installation !== 'object' || Array.isArray(data.installation)) {
      errors.push('installation must be an object');
    } else {
      const allowedInstallProps = ['command', 'args', 'env', 'workingDirectory'];
      Object.keys(data.installation).forEach(key => {
        if (!allowedInstallProps.includes(key)) {
          errors.push(`Additional property not allowed in installation: ${key}`);
        }
      });

      if (data.installation.command !== undefined && typeof data.installation.command !== 'string') {
        errors.push('installation.command must be a string');
      }
      if (data.installation.args !== undefined) {
        if (!Array.isArray(data.installation.args)) {
          errors.push('installation.args must be an array');
        } else if (!data.installation.args.every((arg: any) => typeof arg === 'string')) {
          errors.push('installation.args must be an array of strings');
        }
      }
      if (data.installation.env !== undefined && (typeof data.installation.env !== 'object' || Array.isArray(data.installation.env))) {
        errors.push('installation.env must be an object');
      }
      if (data.installation.workingDirectory !== undefined && typeof data.installation.workingDirectory !== 'string') {
        errors.push('installation.workingDirectory must be a string');
      }
    }
  }
  
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

interface InstallationDetails {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    workingDirectory?: string;
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
    installation?: InstallationDetails;
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
    const secret = c.env.MCP_REGISTRY_SECRET;
    
    // Check if authentication is provided
    let isVerified = false;
    
    if (signatureHeader && signatureHeader.startsWith('HMAC ')) {
        // Authentication provided - verify it
        if (!secret) {
            console.error('MCP_REGISTRY_SECRET is not configured in environment');
            throw new HTTPException(500, { message: 'Server configuration error' });
        }
        
        const signature = signatureHeader.substring(5); // Remove 'HMAC '
        const isValidHmac = await verifyHmac(secret, rawBody, signature);
        if (!isValidHmac) {
            throw new HTTPException(401, { message: 'Invalid HMAC signature' });
        }
        isVerified = true;
    }
    // If no auth header, allow registration but mark as unverified

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

    let toolId: string;
    let isNewTool = false;
    let oldStoredData: any = null; // To store existing metadata if updating

    const urlIndexKey = `urlidx:${manifestData.url}`;
    const existingToolId = await c.env.MCP_TOOLS_KV.get(urlIndexKey);

    if (existingToolId) {
        toolId = existingToolId;
        console.log(`Tool with URL '${manifestData.url}' found. Updating existing ID: ${toolId}`);
        const oldToolDataKey = `tool:${toolId}`;
        const oldJson = await c.env.MCP_TOOLS_KV.get(oldToolDataKey);
        if (oldJson) {
            oldStoredData = JSON.parse(oldJson);
        } else {
            // This case is unlikely if urlidx exists, but handle defensively
            console.warn(`URL index pointed to tool ID ${toolId}, but no data found at ${oldToolDataKey}. Treating as new registration for this ID.`);
            // Fallback to creating as new, but with the existing ID - new registeredAt, new updatedAt
            // Alternatively, could throw an error for inconsistent state.
            // For now, let's overwrite with new metadata but keep the ID.
        }
    } else {
        toolId = uuidv4();
        isNewTool = true;
        console.log(`New tool. Generating ID: ${toolId} for URL '${manifestData.url}'`);
    }

    // Generate ID - This section is now replaced by the logic above
    // const toolId = uuidv4();
    const kvKey = `tool:${toolId}`;
    const r2Key = `manifests/${toolId}.json`;

    // Add metadata before storing
    const registeredAt = isNewTool
        ? new Date().toISOString()
        : (oldStoredData?._registeredAt || new Date().toISOString()); // Preserve old, or set new if old is missing

    const updatedAt = new Date().toISOString();

    const status = oldStoredData?._status || 'unknown';
    const lastChecked = oldStoredData?._lastChecked || null;
    
    // Build metadata object
    const metadata: any = {
        _id: toolId,
        _registeredAt: registeredAt,
        _updatedAt: updatedAt,
        _status: status,
        _lastChecked: lastChecked
    };
    
    // Add _unverified flag if submitted without authentication
    if (!isVerified) {
        metadata._unverified = true;
    } else if (oldStoredData?._unverified && isVerified) {
        // If it was unverified before but now is verified, explicitly set to false
        metadata._unverified = false;
    } else if (oldStoredData?._unverified !== undefined) {
        // Preserve existing verification status if not changing
        metadata._unverified = oldStoredData._unverified;
    }

    const storedManifest = {
        ...manifestData,
        ...metadata
    };

    try {
        await c.env.MCP_TOOLS_KV.put(kvKey, JSON.stringify(storedManifest));
        await c.env.MCP_MANIFEST_BACKUPS.put(r2Key, rawBody); // Backup the raw request body

        if (isNewTool) {
            // Create the URL to ID index mapping only for new tools
            await c.env.MCP_TOOLS_KV.put(urlIndexKey, toolId);
        }

        // Create event for SSE stream
        const eventType = isNewTool ? 'tool.registered' : 'tool.updated';
        const changes: string[] = [];
        
        if (!isNewTool && oldStoredData) {
            // Track what changed
            if (oldStoredData.name !== manifestData.name) changes.push('name');
            if (oldStoredData.description !== manifestData.description) changes.push('description');
            if (JSON.stringify(oldStoredData.capabilities) !== JSON.stringify(manifestData.capabilities)) changes.push('capabilities');
            if (JSON.stringify(oldStoredData.tags) !== JSON.stringify(manifestData.tags)) changes.push('tags');
        }
        
        await createEvent(c.env, eventType, {
            toolId,
            name: manifestData.name,
            description: manifestData.description,
            url: manifestData.url,
            tags: manifestData.tags,
            changes: isNewTool ? undefined : changes
        });

        return c.json({ success: true, id: toolId, operation: isNewTool ? 'created' : 'updated' }, 201);
    } catch (error: any) {
        console.error('Error storing manifest:', error);
        // Attempt cleanup for a new tool if storage failed mid-way (optional, might be complex)
        // if (isNewTool) { ... }
        throw new HTTPException(500, { message: 'Failed to store tool manifest', cause: error.message });
    }
}; 