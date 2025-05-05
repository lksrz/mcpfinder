import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { Bindings } from '../types';

export const getToolById = async (c: Context<{ Bindings: Bindings }>) => {
    const toolId = c.req.param('id');
    if (!toolId) {
        throw new HTTPException(400, { message: 'Tool ID is required' });
    }

    const kvKey = `tool:${toolId}`;

    try {
        const manifestJson = await c.env.MCP_TOOLS_KV.get(kvKey);

        if (!manifestJson) {
            throw new HTTPException(404, { message: 'Tool not found' });
        }

        // Parse the JSON stored in KV
        const manifest = JSON.parse(manifestJson);

        // --- ADDED: Construct Installation Details ---
        // Define the structure for installation details with separate command and args
        interface InstallationDetails {
            command?: string;
            args?: string[];
            env?: Record<string, string>;
            workingDirectory?: string;
        }

        let installationDetails: InstallationDetails = {
            // Initialize with potential values from manifest.installation
            // Assuming manifest.installation might already follow the new structure
            // or the old one. We need to handle both possibilities during transition
            // or decide if we enforce the new structure immediately upon read.
            // For now, let's prioritize the new structure if present.
            command: manifest.installation?.command && typeof manifest.installation.command === 'string'
                     ? manifest.installation.command
                     : undefined,
            args: manifest.installation?.args && Array.isArray(manifest.installation.args)
                  ? manifest.installation.args
                  : [], // Default to empty array if not present or invalid
            env: manifest.installation?.env && typeof manifest.installation.env === 'object'
                 ? { ...manifest.installation.env } // Copy existing env
                 : {},
            workingDirectory: manifest.installation?.workingDirectory || undefined,
        };

        // Handle potential old format (command is an array)
        if (!installationDetails.command && manifest.installation?.command && Array.isArray(manifest.installation.command) && manifest.installation.command.length > 0) {
             console.warn(`[API Worker/getToolById] Manifest for ${toolId} uses old installation.command array format. Converting.`);
             installationDetails.command = manifest.installation.command[0];
             installationDetails.args = manifest.installation.command.slice(1);
        }

        // If no command was found in the manifest (neither new nor old format), try to infer from URL
        if (!installationDetails.command && manifest.url && !manifest.url.startsWith('http') && manifest.url.includes('/')) {
            console.log(`[API Worker/getToolById] Inferring npx command for ${toolId} from URL: ${manifest.url}`);
            // Set command and args separately for npx
            installationDetails.command = 'npx';
            installationDetails.args = ['-y', manifest.url];
        } else if (!installationDetails.command) {
             console.warn(`[API Worker/getToolById] Could not find or infer installation command for tool ID ${toolId}. URL: ${manifest.url}`);
        }

        // Suggest API key env var if auth type is api-key and not already present
        if (manifest.auth?.type === 'api-key' && manifest.name) {
            const envVarName = `${manifest.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_API_KEY`;
            if (!installationDetails.env[envVarName]) {
                 installationDetails.env[envVarName] = `YOUR_${envVarName}`; 
                 console.log(`[API Worker/getToolById] Suggesting env var for ${toolId}: ${envVarName}`);
            }
        }
        // --- END ADDED ---

        // Merge the original manifest data with the potentially enhanced installation details
        const finalResponse = { ...manifest, installation: installationDetails };

        // Optionally remove internal fields before returning (Consider if needed)
        // delete finalResponse._id;
        // delete finalResponse._registeredAt;
        // delete finalResponse._status;
        // delete finalResponse._lastChecked;

        return c.json(finalResponse); // Return the enhanced object

    } catch (error: any) {
        // Handle potential JSON parsing errors or KV errors
        if (error instanceof HTTPException) {
            throw error; // Re-throw known HTTP exceptions
        }
        console.error(`Error fetching tool ${toolId}:`, error);
        throw new HTTPException(500, { message: 'Failed to retrieve tool information', cause: error.message });
    }
}; 