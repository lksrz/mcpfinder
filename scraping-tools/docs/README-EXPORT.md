# How to Export Data from mcp.so

Since mcp.so is protected by Cloudflare, here are several methods to export the data:

## Method 1: Browser Console (Easiest)

1. Open Chrome/Firefox and go to https://mcp.so/servers?tag=latest
2. Open Developer Console (F12)
3. Copy the entire content from `export-mcp-so.js`
4. Paste it into the console and press Enter
5. Run: `extractAllServers()` to start extraction
6. The script will auto-navigate through pages and download a JSON file

**Note**: Keep the browser tab active during extraction.

## Method 2: Python with Selenium (Most Reliable)

1. Install dependencies:
```bash
pip install selenium undetected-chromedriver beautifulsoup4
```

2. Run the script:
```bash
python scripts/export-mcp-so.py --mode all --max-pages 510
```

This uses undetected-chromedriver which can often bypass Cloudflare.

## Method 3: Playwright (Node.js Alternative)

1. Install dependencies:
```bash
npm install playwright playwright-extra playwright-extra-plugin-stealth
```

2. Run the script:
```bash
node scripts/export-mcp-so-playwright.js all 510 mcp-so-servers.json
```

## Method 4: Manual Export

If automated methods fail:

1. Manually save pages from mcp.so as HTML files
2. Use the HTML parser:
```bash
node src/scrapers/mcp-so-html-parser.js saved-page.html
```

## After Export

Once you have the JSON file:

1. **Analyze the data**:
```bash
node src/scrapers/mcp-so-bulk-analyzer.js analyze mcp-so-servers.json
```

This will:
- Check npm packages for existence
- Test HTTP/SSE endpoints
- Categorize all servers
- Create `mcp-so-viable-servers.json`

2. **Register viable servers**:
```bash
node src/scrapers/mcp-so-bulk-analyzer.js register data/mcp-so-viable-servers.json
```

## Expected Results

From ~15,000 servers:
- ~100-200 npm packages
- ~20-50 Python (uvx) packages  
- ~30-50 HTTP/SSE endpoints
- ~14,500+ GitHub repos (not auto-installable)

Total viable: ~150-300 servers (1-2%)

## Troubleshooting

- **Cloudflare blocks**: Try different methods or wait between requests
- **Empty results**: Check if the page structure changed
- **Partial data**: The scripts save partial data if interrupted

## Tips

1. Run during off-peak hours
2. Use a VPN if getting rate-limited
3. The browser console method is least likely to be blocked
4. Save partial results frequently