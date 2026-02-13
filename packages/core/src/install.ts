/**
 * Generate installation commands for MCP servers.
 * Supports Claude Desktop, Cursor, and generic configurations.
 */
import type Database from 'better-sqlite3';
import type { McpServer, RegistryEnvVar } from './types.js';

export type ClientType = 'claude-desktop' | 'cursor' | 'vscode' | 'generic';

interface InstallConfig {
  client: ClientType;
  serverName: string;
  config: Record<string, unknown>;
  instructions: string;
  envVarsNeeded: RegistryEnvVar[];
}

/**
 * Generate install configuration for a specific MCP server and client.
 */
export function getInstallCommand(
  db: Database.Database,
  nameOrSlug: string,
  client: ClientType = 'claude-desktop',
): InstallConfig | null {
  const row = db
    .prepare(
      `SELECT * FROM servers
       WHERE id = ?
          OR slug = ?
          OR name = ?
          OR name LIKE ?
       LIMIT 1`,
    )
    .get(nameOrSlug, nameOrSlug, nameOrSlug, `%/${nameOrSlug}`) as McpServer | undefined;

  if (!row) return null;

  let envVars: RegistryEnvVar[] = [];
  try {
    envVars = JSON.parse(row.env_vars || '[]');
  } catch {
    envVars = [];
  }

  const serverKey = row.slug || row.name.split('/').pop() || row.name;

  if (row.registry_type === 'npm' && row.package_identifier) {
    return generateNpmConfig(serverKey, row.package_identifier, envVars, client);
  }

  if (row.registry_type === 'pypi' && row.package_identifier) {
    return generatePypiConfig(serverKey, row.package_identifier, envVars, client);
  }

  if (row.registry_type === 'oci' && row.package_identifier) {
    return generateDockerConfig(serverKey, row.package_identifier, envVars, client);
  }

  if (row.has_remote && row.remote_url) {
    return generateRemoteConfig(serverKey, row.remote_url, envVars, client);
  }

  return {
    client,
    serverName: serverKey,
    config: {
      note: 'Unable to generate auto-config. Check the repository for installation instructions.',
      repositoryUrl: row.repository_url,
      registryType: row.registry_type,
      packageIdentifier: row.package_identifier,
    },
    instructions: `Check the repository for installation instructions: ${row.repository_url || 'N/A'}`,
    envVarsNeeded: envVars,
  };
}

function generateNpmConfig(
  serverKey: string,
  packageId: string,
  envVars: RegistryEnvVar[],
  client: ClientType,
): InstallConfig {
  const env: Record<string, string> = {};
  for (const v of envVars) {
    env[v.name] = v.isSecret ? '<YOUR_VALUE>' : (v.description || '<VALUE>');
  }

  const config: Record<string, unknown> = {
    command: 'npx',
    args: ['-y', packageId],
  };
  if (Object.keys(env).length > 0) {
    config.env = env;
  }

  const mcpConfig = { mcpServers: { [serverKey]: config } };

  let instructions: string;
  switch (client) {
    case 'claude-desktop':
      instructions = `Add to your Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json):\n\n${JSON.stringify(mcpConfig, null, 2)}`;
      break;
    case 'cursor':
      instructions = `Add to your Cursor MCP config (.cursor/mcp.json):\n\n${JSON.stringify(mcpConfig, null, 2)}`;
      break;
    default:
      instructions = `MCP server configuration:\n\n${JSON.stringify(mcpConfig, null, 2)}`;
  }

  return { client, serverName: serverKey, config: mcpConfig, instructions, envVarsNeeded: envVars };
}

function generatePypiConfig(
  serverKey: string,
  packageId: string,
  envVars: RegistryEnvVar[],
  client: ClientType,
): InstallConfig {
  const env: Record<string, string> = {};
  for (const v of envVars) {
    env[v.name] = v.isSecret ? '<YOUR_VALUE>' : (v.description || '<VALUE>');
  }

  const config: Record<string, unknown> = { command: 'uvx', args: [packageId] };
  if (Object.keys(env).length > 0) config.env = env;

  const mcpConfig = { mcpServers: { [serverKey]: config } };

  return {
    client,
    serverName: serverKey,
    config: mcpConfig,
    instructions: `Install via uvx/pip. Add to your MCP config:\n\n${JSON.stringify(mcpConfig, null, 2)}`,
    envVarsNeeded: envVars,
  };
}

function generateDockerConfig(
  serverKey: string,
  packageId: string,
  envVars: RegistryEnvVar[],
  client: ClientType,
): InstallConfig {
  const envFlags = envVars.map((v) => `-e ${v.name}=<YOUR_VALUE>`).join(' ');
  const dockerCmd = `docker run -i ${envFlags} ${packageId}`.trim();

  const config: Record<string, unknown> = {
    command: 'docker',
    args: ['run', '-i', ...envVars.flatMap((v) => ['-e', `${v.name}=<YOUR_VALUE>`]), packageId],
  };

  const mcpConfig = { mcpServers: { [serverKey]: config } };

  return {
    client,
    serverName: serverKey,
    config: mcpConfig,
    instructions: `Run via Docker:\n\n${dockerCmd}\n\nOr add to MCP config:\n\n${JSON.stringify(mcpConfig, null, 2)}`,
    envVarsNeeded: envVars,
  };
}

function generateRemoteConfig(
  serverKey: string,
  remoteUrl: string,
  envVars: RegistryEnvVar[],
  client: ClientType,
): InstallConfig {
  const mcpConfig = { mcpServers: { [serverKey]: { url: remoteUrl } } };

  return {
    client,
    serverName: serverKey,
    config: mcpConfig,
    instructions: `This server is available remotely. Add to your MCP config:\n\n${JSON.stringify(mcpConfig, null, 2)}`,
    envVarsNeeded: envVars,
  };
}
