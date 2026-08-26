/**
 * Environment-variable extraction shared by the sync normalizers and the
 * merge-time rebuild in server-merge.ts.
 *
 * Registries that publish env vars as a JSON Schema (Glama today) must be
 * parsed identically on the insert path and on the merge path — a second,
 * slimmer copy of this mapping in server-merge.ts silently dropped `default`
 * and `writeOnly` from every deduplicated row, un-fixing GitHub issue #10 and
 * turning secrets back into unmasked values. One implementation, two callers.
 */
import type { RegistryEnvVar } from './types.js';

/**
 * Map an `environmentVariablesJsonSchema` object onto `RegistryEnvVar[]`,
 * keeping every field the config generator can use.
 *
 * Returns `[]` when the schema (or its `properties`) is simply absent, and
 * `null` when it is present but malformed — callers on the merge path treat
 * `null` as "cannot reconstruct this source's contribution" and fall back to a
 * conservative union merge, while the insert path substitutes an empty list.
 */
export function envVarsFromJsonSchema(schema: unknown): RegistryEnvVar[] | null {
  if (schema === null || schema === undefined) return [];
  if (typeof schema !== 'object' || Array.isArray(schema)) return null;
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (properties === undefined) return [];
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
  const required = new Set(
    (Array.isArray(record.required) ? record.required : []).filter(
      (name): name is string => typeof name === 'string',
    ),
  );
  return Object.entries(properties as Record<string, unknown>).map(([name, value]) => {
    const prop = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const envVar: RegistryEnvVar = { name };
    if (typeof prop.description === 'string') envVar.description = prop.description;
    if (typeof prop.format === 'string') envVar.format = prop.format;
    if (
      typeof prop.default === 'string' ||
      typeof prop.default === 'number' ||
      typeof prop.default === 'boolean'
    ) {
      envVar.default = prop.default;
    }
    // JSON Schema marks write-only fields (credentials) with `writeOnly`.
    if (prop.writeOnly === true) envVar.isSecret = true;
    if (required.has(name)) envVar.isRequired = true;
    return envVar;
  });
}
