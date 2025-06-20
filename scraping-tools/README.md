# MCPfinder Scraping Tools

This directory contains all the tools and scripts for discovering and extracting MCP (Model Context Protocol) servers from various sources.

## Directory Structure

```
scraping-tools/
├── scripts/          # Extraction and analysis scripts
├── scrapers/         # Source-specific scrapers
├── data/            # Extracted data and caches
└── docs/            # Documentation and resources
```

## Available Scrapers

### 1. MCP.so Scrapers
- **mcp-so-feed.js** - Scrapes the mcp.so RSS/JSON feed
- **mcp-so-api-scraper.js** - Direct API access to mcp.so
- **export-mcp-so-browser.js** - Browser console script for extracting servers
- **scrape-mcp-so-configs.js** - Extracts installation configs from server pages

### 2. Other Sources
- **github-scraper.js** - Scans GitHub repositories (modelcontextprotocol/servers, wong2/awesome-mcp-servers)
- **glama-ai-scraper.js** - Extracts servers from glama.ai/mcp/servers
- **mcpservers-org-scraper.js** - Parses mcpservers.org website

## Usage

### Running All Scrapers
```bash
node scrapers/run-all-scrapers.js
```

### Running Individual Scrapers
```bash
# Scrape mcp.so feed
node scrapers/mcp-so-feed.js

# Scrape GitHub repositories
node scrapers/github-scraper.js

# View scraper results
node scrapers/view-log.js
```

### Browser-Based Extraction (mcp.so)
1. Open https://mcp.so in your browser
2. Open Developer Console (F12)
3. Copy and paste the content from `scripts/export-mcp-so-browser-v2.js`
4. Follow the prompts to extract server data

### Analyzing Extracted Data
```bash
# Analyze mcp.so servers
node scripts/analyze-mcp-configs.js

# Quick analysis of viable servers
node scripts/quick-mcp-so-analyzer.js

# Merge multiple extraction files
node scripts/merge-mcp-so-files.js
```

## Data Files

### Input/Cache Files
- `data/*-cache.json` - Cached responses from various sources
- `data/mcpso-jsons/` - Raw extraction batches from mcp.so

### Output Files
- `data/mcp-so-servers-merged.json` - All unique servers from mcp.so (13,258 servers)
- `data/mcp-so-viable-*.json` - Servers that can be installed via npm/uvx
- `data/scraper-results.log` - Log of all scraping operations

## Key Findings

From the mcp.so extraction:
- Total servers found: 638,746
- Unique servers: 13,258 (97.9% were duplicates)
- Most servers are GitHub repositories requiring manual installation
- Only a small fraction have npm/uvx packages for easy installation

## Known Issues

1. **Config Extraction**: The mcp.so config extraction had issues with dynamic content, resulting in corrupted text instead of package names.
2. **Rate Limiting**: Some sources implement rate limiting; scripts include delays to handle this.
3. **Authentication**: Many servers require authentication tokens which cannot be automatically scraped.

## Development

### Adding a New Scraper
1. Create a new file in `scrapers/` directory
2. Follow the pattern used in existing scrapers
3. Update `run-all-scrapers.js` to include your scraper
4. Test thoroughly before running in production

### Testing Extraction
```bash
# Test known viable servers
node scripts/test-known-servers.js

# Test config extraction
node scripts/test-config-extraction.js
```

## Automation

The scrapers can be run automatically:
```bash
# Run daily scraper (scheduled for 6 AM UTC)
node scripts/daily-scraper.js

# Run once and exit
node scrapers/run-all-scrapers.js --once
```

## Notes

- Always check `data/scraper-results.log` for errors or issues
- The browser extraction scripts require manual intervention
- GitHub API requires a token for higher rate limits (set GITHUB_TOKEN env var)
- Results are automatically deduplicated based on package name or URL