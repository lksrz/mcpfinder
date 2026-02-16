/**
 * @mcpfinder/core — Shared types, database, sync engine, and search.
 */

// Types
export type {
  RegistryServerEntry,
  RegistryPackage,
  RegistryRemote,
  RegistryEnvVar,
  RegistryMeta,
  RegistryListResponse,
  McpServer,
  SearchResult,
  ServerDetail,
  Category,
  GlamaServer,
  GlamaListResponse,
  SmitheryServer,
  SmitheryListResponse,
} from './types.js';

// Database
export { initDatabase, getDataDir, getLastSyncTimestamp, updateSyncLog } from './db.js';

// Sync
export { syncOfficialRegistry, syncGlamaRegistry, syncSmitheryRegistry, isSyncNeeded, getServerCount } from './sync.js';

// Search
export { searchServers, getServerDetails, findServerByNameOrSlug } from './search.js';

// Categories
export {
  extractKeywords,
  categorizeServer,
  listCategories,
  getServersByCategory,
} from './categories.js';

// Install
export { getInstallCommand } from './install.js';
export type { ClientType } from './install.js';
