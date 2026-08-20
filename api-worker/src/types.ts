import type { Context } from "hono";
/** Bindings are generated from wrangler.toml; runtime routes still fail safe if absent. */
export type Bindings = Cloudflare.Env;
export type AppContext = Context<{ Bindings: Bindings }>;
