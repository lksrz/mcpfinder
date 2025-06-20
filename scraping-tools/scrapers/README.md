# MCPfinder Automated Scrapers

This directory contains automated scrapers that discover new MCP servers from various sources and register them with the MCPfinder registry.

## Available Scrapers

### 1. MCP.so Feed Scraper (`mcp-so-feed.js`)
- **Source**: https://mcp.so/feed
- **Description**: Parses RSS/Atom feed from mcp.so to discover new MCP servers
- **Confidence Levels**: 0.4-0.8 based on URL type and context
- **Cache**: `data/mcp-so-cache.json`

### 2. GitHub Repositories Scraper (`github-scraper.js`)
- **Sources**: 
  - `modelcontextprotocol/servers`
  - `wong2/awesome-mcp-servers`
- **Description**: Scans GitHub repositories for MCP server references in README files and package.json
- **Confidence Levels**: 0.6-0.9 based on source type
- **Cache**: `data/github-cache.json`
- **Rate Limiting**: Respects GitHub API limits, supports GITHUB_TOKEN env var

### 3. MCPServers.org Scraper (`mcpservers-org-scraper.js`)
- **Sources**:
  - https://mcpservers.org/remote-mcp-servers
  - https://mcpservers.org
- **Description**: Parses HTML content to extract MCP server links and references
- **Confidence Levels**: 0.5-0.7 based on URL patterns
- **Cache**: `data/mcpservers-cache.json`

### 4. Glama.ai Scraper (`glama-ai-scraper.js`)
- **Source**: https://glama.ai/mcp/servers?sort=added-at%3Adesc
- **Description**: Extracts MCP server data from Glama.ai's MCP server directory
- **Confidence Levels**: 0.7-0.9 based on data source
- **Cache**: `data/glama-cache.json`

## Usage

### Run Individual Scrapers
```bash
# Run individual scrapers
node src/scrapers/mcp-so-feed.js
node src/scrapers/github-scraper.js
node src/scrapers/mcpservers-org-scraper.js
node src/scrapers/glama-ai-scraper.js
```

### Run All Scrapers
```bash
# Run all scrapers once
node mcpfinder-server/index.js scrape

# Or using the aggregator directly
node src/scrapers/run-all-scrapers.js
```

### Daily Automation
```bash
# Run scrapers once and exit
node mcpfinder-server/index.js scrape --once

# Start daily scheduler (runs at 6 AM UTC by default)
node mcpfinder-server/index.js schedule-scraper

# Or using the daily scraper directly
node src/daily-scraper.js              # Start scheduler
node src/daily-scraper.js --once       # Run once
```

## Configuration

### Environment Variables

- `GITHUB_TOKEN` - GitHub personal access token for higher API rate limits
- `SCRAPER_SCHEDULE` - Cron schedule for daily scraping (default: `0 6 * * *`)
- `WEBHOOK_URL` - Slack/Discord webhook URL for notifications
- `RUN_IMMEDIATELY` - Set to `true` to run scraping immediately when scheduler starts
- `MCPFINDER_API_URL` - Override the MCPfinder API URL (default: https://mcpfinder.dev)

### Headless Registration Options

Each scraper uses the headless registration system with these default options:

```javascript
{
  headless: true,
  description: "Auto-generated description based on source",
  tags: "auto-discovered,{source-name}",
  confirm: 'y',
  requiresApiKey: false,
  authType: 'api-key',
  manualCapabilities: 'n',
  hasTools: 'y',
  hasResources: 'n',
  hasPrompts: 'n'
}
```

## Incremental Processing

All scrapers implement incremental processing to avoid re-processing the same entries:

- **Cache Files**: Store processed URLs/entries in JSON format
- **ETags**: GitHub scraper uses ETags for conditional requests
- **Deduplication**: Remove duplicate entries within and across scraping runs
- **Confidence Filtering**: Only auto-register entries above confidence threshold (typically 0.6-0.7)

## Output and Logging

### Results Format
```json
{
  "totalServers": 42,
  "newServers": 5,
  "successfulRegistrations": 3
}
```

### Log Files
- `data/scraper-log.json` - Detailed results from run-all-scrapers
- `data/daily-scraper.log` - Daily scheduler log messages
- Individual cache files for each scraper

### Console Output
- Progress indicators and status messages
- Error handling with detailed error messages
- Summary statistics after completion

## Error Handling

- **Graceful Degradation**: Individual scraper failures don't stop the entire process
- **Rate Limiting**: Built-in delays between requests and registrations
- **Retry Logic**: Some scrapers implement retry mechanisms for transient failures
- **Validation**: Input validation before attempting registration
- **Caching**: Failed entries are still cached to avoid re-processing

## Development

### Adding New Scrapers

1. Create a new scraper file in `src/scrapers/`
2. Implement the main scraping function that returns results in the expected format
3. Add cache management for incremental processing
4. Add the scraper to `run-all-scrapers.js`
5. Update this README

### Testing Scrapers

```bash
# Test individual scrapers
node src/scrapers/your-scraper.js

# Test with custom API URL
MCPFINDER_API_URL=http://localhost:8787 node src/scrapers/your-scraper.js

# Test registration without actually registering (dry run mode could be added)
```

## Security Notes

- Scrapers respect robots.txt and rate limits where applicable
- No credentials or sensitive data are cached
- All registration attempts use the standard headless registration flow
- GitHub token is optional and only used for API rate limit increases