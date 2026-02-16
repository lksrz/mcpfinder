/**
 * Core types for MCPfinder
 */

/** Raw server entry from the Official MCP Registry API */
export interface RegistryServerEntry {
  server: {
    $schema?: string;
    name: string;
    description?: string;
    version: string;
    repository?: {
      url: string;
      source: string;
    };
    packages?: RegistryPackage[];
    remotes?: RegistryRemote[];
  };
  _meta?: Record<string, RegistryMeta>;
}

export interface RegistryPackage {
  registryType: string; // npm | pypi | oci | nuget | mcpb
  identifier: string;
  transport: { type: string }; // stdio | streamable-http | sse
  environmentVariables?: RegistryEnvVar[];
}

export interface RegistryRemote {
  type: string;
  url: string;
}

export interface RegistryEnvVar {
  name: string;
  description?: string;
  format?: string;
  isSecret?: boolean;
}

export interface RegistryMeta {
  status?: string;
  publishedAt?: string;
  updatedAt?: string;
  isLatest?: boolean;
}

/** Registry API list response */
export interface RegistryListResponse {
  servers: RegistryServerEntry[];
  metadata?: {
    nextCursor?: string | null;
    total?: number;
  };
}

/** Our unified server record stored in SQLite */
export interface McpServer {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  registry_type: string | null;
  package_identifier: string | null;
  transport_type: string | null;
  repository_url: string | null;
  repository_source: string | null;
  published_at: string | null;
  updated_at: string | null;
  status: string;
  popularity_score: number;
  categories: string; // JSON array
  keywords: string; // JSON array
  remote_url: string | null;
  has_remote: number;
  last_synced_at: string;
  sources: string; // JSON array
  raw_data: string; // Full JSON from source
  env_vars: string; // JSON array of env var definitions
}

/** Search result returned to MCP clients */
export interface SearchResult {
  name: string;
  description: string;
  version: string;
  registryType: string | null;
  packageIdentifier: string | null;
  transportType: string | null;
  repositoryUrl: string | null;
  hasRemote: boolean;
  rank: number;
}

/** Server detail returned to MCP clients */
export interface ServerDetail {
  name: string;
  description: string;
  version: string;
  registryType: string | null;
  packageIdentifier: string | null;
  transportType: string | null;
  repositoryUrl: string | null;
  repositorySource: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  status: string;
  hasRemote: boolean;
  remoteUrl: string | null;
  categories: string[];
  environmentVariables: RegistryEnvVar[];
}

/** Category with server count */
export interface Category {
  name: string;
  count: number;
  keywords: string[];
}
