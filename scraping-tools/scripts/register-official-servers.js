#!/usr/bin/env node

/**
 * Register official MCP servers from modelcontextprotocol organization
 */

import fetch from 'node-fetch';
import crypto from 'crypto';

const API_URL = process.env.MCPFINDER_API_URL || 'https://mcpfinder.dev';
const REGISTRY_SECRET = process.env.MCP_REGISTRY_SECRET;

/**
 * Generate HMAC signature for request
 */
function generateHmac(secret, body) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Register a single server
 */
async function registerServer(manifest) {
    const body = JSON.stringify(manifest);
    const headers = {
        'Content-Type': 'application/json'
    };
    
    if (REGISTRY_SECRET) {
        headers['Authorization'] = `HMAC ${generateHmac(REGISTRY_SECRET, body)}`;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/v1/register`, {
            method: 'POST',
            headers,
            body
        });
        
        const result = await response.json();
        
        if (response.ok) {
            return { success: true, id: result.id, operation: result.operation };
        } else {
            return { success: false, error: result.message || response.statusText };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Official MCP servers from modelcontextprotocol organization
const OFFICIAL_SERVERS = [
    {
        name: '@modelcontextprotocol/server-everything',
        description: 'MCP server that exercises all the features of the MCP protocol. For testing and demonstration.',
        url: '@modelcontextprotocol/server-everything',
        capabilities: [
            { name: 'echo', type: 'tool', description: 'Echoes back the input' },
            { name: 'add', type: 'tool', description: 'Adds two numbers' },
            { name: 'longRunningOperation', type: 'tool', description: 'Simulates a long running operation' },
            { name: 'sampleLLM', type: 'tool', description: 'Samples from an LLM' },
            { name: 'getTinyImage', type: 'resource', description: 'Returns a tiny test image' }
        ],
        tags: ['official', 'testing', 'demo']
    },
    {
        name: '@modelcontextprotocol/server-fetch',
        description: 'Simple MCP server for fetching web content',
        url: '@modelcontextprotocol/server-fetch',
        capabilities: [
            { name: 'fetch', type: 'tool', description: 'Fetches a URL and returns its content' }
        ],
        tags: ['official', 'web', 'fetch']
    },
    {
        name: '@modelcontextprotocol/server-filesystem',
        description: 'Secure MCP server for filesystem access with configurable permissions',
        url: '@modelcontextprotocol/server-filesystem',
        capabilities: [
            { name: 'read_file', type: 'tool', description: 'Read file contents' },
            { name: 'write_file', type: 'tool', description: 'Write file contents' },
            { name: 'list_directory', type: 'tool', description: 'List directory contents' },
            { name: 'create_directory', type: 'tool', description: 'Create a directory' },
            { name: 'delete', type: 'tool', description: 'Delete file or directory' },
            { name: 'move', type: 'tool', description: 'Move file or directory' },
            { name: 'file_info', type: 'tool', description: 'Get file information' },
            { name: 'file://*', type: 'resource', description: 'Access files' }
        ],
        tags: ['official', 'filesystem', 'files']
    },
    {
        name: '@modelcontextprotocol/server-git',
        description: 'MCP server for Git repository operations',
        url: '@modelcontextprotocol/server-git',
        capabilities: [
            { name: 'git_status', type: 'tool', description: 'Show git status' },
            { name: 'git_diff', type: 'tool', description: 'Show git diff' },
            { name: 'git_log', type: 'tool', description: 'Show git log' },
            { name: 'git_commit', type: 'tool', description: 'Create a git commit' },
            { name: 'git_add', type: 'tool', description: 'Stage files' },
            { name: 'git_reset', type: 'tool', description: 'Unstage files' },
            { name: 'git_branch', type: 'tool', description: 'List or create branches' },
            { name: 'git_checkout', type: 'tool', description: 'Switch branches' }
        ],
        tags: ['official', 'git', 'version-control']
    },
    {
        name: '@modelcontextprotocol/server-memory',
        description: 'Simple KV memory for MCP with persistent storage',
        url: '@modelcontextprotocol/server-memory',
        capabilities: [
            { name: 'store', type: 'tool', description: 'Store a value' },
            { name: 'retrieve', type: 'tool', description: 'Retrieve a value' },
            { name: 'delete', type: 'tool', description: 'Delete a value' },
            { name: 'list', type: 'tool', description: 'List all keys' }
        ],
        tags: ['official', 'memory', 'storage']
    },
    {
        name: '@modelcontextprotocol/server-sequentialthinking',
        description: 'Server for sequential thinking and problem decomposition',
        url: '@modelcontextprotocol/server-sequentialthinking',
        capabilities: [
            { name: 'sequentialThinking', type: 'tool', description: 'Performs sequential thinking to solve problems' }
        ],
        tags: ['official', 'reasoning', 'problem-solving']
    },
    {
        name: '@modelcontextprotocol/server-time',
        description: 'Simple MCP server for time operations',
        url: '@modelcontextprotocol/server-time',
        capabilities: [
            { name: 'getCurrentTime', type: 'tool', description: 'Get current time' }
        ],
        tags: ['official', 'time', 'utility']
    },
    {
        name: '@modelcontextprotocol/server-github',
        description: 'MCP server for GitHub API interactions - create repos, manage issues, and more',
        url: '@modelcontextprotocol/server-github',
        capabilities: [
            { name: 'create_or_update_file', type: 'tool', description: 'Create or update a single file in a GitHub repository' },
            { name: 'search_repositories', type: 'tool', description: 'Search for GitHub repositories' },
            { name: 'create_repository', type: 'tool', description: 'Create a new GitHub repository in your account' },
            { name: 'get_file_contents', type: 'tool', description: 'Get the contents of a file or directory from a GitHub repository' },
            { name: 'push_files', type: 'tool', description: 'Push multiple files to a GitHub repository in a single commit' },
            { name: 'create_issue', type: 'tool', description: 'Create a new issue in a GitHub repository' },
            { name: 'create_pull_request', type: 'tool', description: 'Create a new pull request in a GitHub repository' },
            { name: 'fork_repository', type: 'tool', description: 'Fork a GitHub repository to your account or specified organization' },
            { name: 'create_branch', type: 'tool', description: 'Create a new branch in a GitHub repository' },
            { name: 'list_commits', type: 'tool', description: 'Get list of commits of a branch in a GitHub repository' },
            { name: 'list_issues', type: 'tool', description: 'List issues in a GitHub repository with filtering options' },
            { name: 'update_issue', type: 'tool', description: 'Update an existing issue in a GitHub repository' },
            { name: 'add_issue_comment', type: 'tool', description: 'Add a comment to an existing issue' },
            { name: 'search_code', type: 'tool', description: 'Search for code across GitHub repositories' },
            { name: 'search_issues', type: 'tool', description: 'Search for issues and pull requests across GitHub repositories' },
            { name: 'search_users', type: 'tool', description: 'Search for users on GitHub' },
            { name: 'get_issue', type: 'tool', description: 'Get details of a specific issue in a GitHub repository.' },
            { name: 'get_pull_request', type: 'tool', description: 'Get details of a specific pull request' },
            { name: 'list_pull_requests', type: 'tool', description: 'List and filter repository pull requests' },
            { name: 'create_pull_request_review', type: 'tool', description: 'Create a review on a pull request' },
            { name: 'merge_pull_request', type: 'tool', description: 'Merge a pull request' },
            { name: 'get_pull_request_files', type: 'tool', description: 'Get the list of files changed in a pull request' },
            { name: 'get_pull_request_status', type: 'tool', description: 'Get the combined status of all status checks for a pull request' },
            { name: 'update_pull_request_branch', type: 'tool', description: 'Update a pull request branch with the latest changes from the base branch' },
            { name: 'get_pull_request_comments', type: 'tool', description: 'Get the review comments on a pull request' },
            { name: 'get_pull_request_reviews', type: 'tool', description: 'Get the reviews on a pull request' }
        ],
        tags: ['official', 'github', 'git', 'collaboration'],
        auth: {
            type: 'api-key',
            key_name: 'GITHUB_TOKEN',
            instructions: 'Create a GitHub personal access token with appropriate permissions'
        }
    }
];

async function registerOfficialServers() {
    console.log('🚀 Registering official MCP servers...\n');
    
    if (!REGISTRY_SECRET) {
        console.warn('⚠️  Warning: MCP_REGISTRY_SECRET not set. Registrations will be unverified.\n');
    }
    
    const stats = {
        total: OFFICIAL_SERVERS.length,
        created: 0,
        updated: 0,
        failed: 0,
        errors: []
    };
    
    for (const server of OFFICIAL_SERVERS) {
        const manifest = {
            ...server,
            protocol_version: 'MCP/1.0',
            installation: {
                command: 'npx',
                args: ['-y', server.url]
            }
        };
        
        const result = await registerServer(manifest);
        
        if (result.success) {
            if (result.operation === 'created') {
                stats.created++;
                console.log(`✅ Created: ${server.name}`);
            } else {
                stats.updated++;
                console.log(`🔄 Updated: ${server.name}`);
            }
        } else {
            stats.failed++;
            stats.errors.push({ server: server.name, error: result.error });
            console.log(`❌ Failed: ${server.name} - ${result.error}`);
        }
        
        // Small delay between registrations
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('📊 Registration Summary:');
    console.log('='.repeat(50));
    console.log(`Total processed: ${stats.total}`);
    console.log(`✅ Created: ${stats.created}`);
    console.log(`🔄 Updated: ${stats.updated}`);
    console.log(`❌ Failed: ${stats.failed}`);
    console.log('='.repeat(50));
    
    if (stats.errors.length > 0) {
        console.log('\n❌ Errors:');
        stats.errors.forEach(err => {
            console.log(`  - ${err.server}: ${err.error}`);
        });
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    registerOfficialServers().catch(console.error);
}

export { registerOfficialServers };