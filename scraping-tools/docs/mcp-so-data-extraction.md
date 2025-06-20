# mcp.so Data Extraction Guide

Since mcp.so is protected by Cloudflare, we need to use a manual approach to extract and analyze all 15,000+ servers.

## Step-by-Step Process

### 1. Manual Data Export

Since automated scraping is blocked, you'll need to manually export the data:

#### Option A: Browser Console Method
1. Visit https://mcp.so/servers?tag=latest
2. Open browser developer tools (F12)
3. Scroll through all pages to load data
4. Run this in console to extract data:
```javascript
// Extract all server data from the page
const servers = [];
document.querySelectorAll('a[href*="/server/"]').forEach(link => {
  const parent = link.closest('div');
  servers.push({
    name: link.textContent.trim(),
    url: link.href,
    description: parent.querySelector('p')?.textContent || '',
    // Add more fields as needed
  });
});
console.log(JSON.stringify(servers, null, 2));
```
5. Save the output as `mcp-so-servers.json`

#### Option B: Save Page HTML
1. Visit each page of mcp.so (or use a browser extension to save all pages)
2. Save as HTML files
3. Use our HTML parser:
```bash
node src/scrapers/mcp-so-html-parser.js saved-page.html
```

#### Option C: Browser Automation with Authentication
Use a tool like Selenium with undetected-chromedriver to bypass Cloudflare:
```python
from undetected_chromedriver import Chrome
driver = Chrome()
driver.get("https://mcp.so/servers")
# Extract data after page loads
```

### 2. Analyze Extracted Data

Once you have the data in JSON format:

```bash
# Analyze all servers to find viable ones
node src/scrapers/mcp-so-bulk-analyzer.js analyze mcp-so-servers.json
```

This will:
- Check each server to determine if it's npm/uvx/HTTP/SSE
- Test npm packages for existence
- Test HTTP/SSE endpoints for accessibility
- Generate a report with statistics
- Save viable servers to `data/mcp-so-viable-servers.json`

### 3. Register Viable Servers

After analysis, register all viable servers:

```bash
# Register all viable servers
node src/scrapers/mcp-so-bulk-analyzer.js register data/mcp-so-viable-servers.json
```

## Expected Results

Based on the pattern we've seen:
- **Total servers**: ~15,000
- **Expected viable**: ~150-300 (1-2%)
  - npm packages: ~100-200
  - Python (uvx) packages: ~20-50
  - HTTP/SSE endpoints: ~30-50
  - GitHub repos: ~14,500+ (not viable for auto-registration)

## Alternative Approaches

1. **Contact mcp.so**: Request API access or data export
2. **Use their RSS feed**: Monitor new additions daily
3. **Collaborate**: Work with mcp.so to create an official integration
4. **Scraping Service**: Use services like ScrapingBee or Bright Data

## Data Format

The analyzer expects JSON in this format:
```json
[
  {
    "name": "Server Name",
    "description": "Description",
    "install": "npx package-name",
    "url": "https://github.com/...",
    "author": "username",
    "tags": ["tag1", "tag2"]
  }
]
```

The analyzer is flexible and will search all fields for:
- npm package patterns (npx, npm install)
- Python package patterns (uvx)
- HTTP/SSE URLs
- GitHub repositories