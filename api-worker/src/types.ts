import { DateTime, Str } from "chanfana";
import type { Context } from "hono";
import { z } from "zod";

// Define the bindings type directly
export interface Bindings {
	MCP_TOOLS_KV: KVNamespace;
	MCP_MANIFEST_BACKUPS: R2Bucket;
	MCP_REGISTRY_SECRET: string;
	// Add other bindings if needed
}

// Example AppContext using the direct Bindings type
export type AppContext = Context<{ Bindings: Bindings }>;

// The old Env interface might not be needed anymore, or could be adapted
// interface Env { /* ... */ }

export const Task = z.object({
	name: Str({ example: "lorem" }),
	slug: Str(),
	description: Str({ required: false }),
	completed: z.boolean().default(false),
	due_date: DateTime(),
});
