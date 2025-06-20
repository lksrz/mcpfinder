#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Parse mcp.so HTML to extract server information
 */
export async function parseMcpSoHtml(htmlFile) {
    console.log(`📄 Parsing mcp.so HTML from: ${htmlFile}\n`);
    
    try {
        // Read HTML file
        const html = await fs.readFile(htmlFile, 'utf-8');
        
        // Parse with JSDOM
        const dom = new JSDOM(html);
        const document = dom.window.document;
        
        const servers = [];
        
        // Try different selectors that might contain server information
        const selectors = [
            // Common card/list patterns
            '[class*="server-card"]',
            '[class*="server-item"]',
            '[class*="project-card"]',
            '[class*="list-item"]',
            'article',
            '.card',
            // Link patterns
            'a[href*="/server/"]',
            'a[href*="/project/"]',
            // Div patterns
            'div[data-server]',
            'div[data-project]'
        ];
        
        let elements = [];
        for (const selector of selectors) {
            const found = document.querySelectorAll(selector);
            if (found.length > 0) {
                console.log(`Found ${found.length} elements with selector: ${selector}`);
                elements = found;
                break;
            }
        }
        
        if (elements.length === 0) {
            console.log('Trying generic approach - looking for repeated structures...');
            // Look for divs that appear to be repeated items
            const allDivs = document.querySelectorAll('div');
            const classCount = {};
            
            allDivs.forEach(div => {
                const className = div.className;
                if (className && typeof className === 'string') {
                    classCount[className] = (classCount[className] || 0) + 1;
                }
            });
            
            // Find classes that appear multiple times (likely list items)
            const repeatedClasses = Object.entries(classCount)
                .filter(([cls, count]) => count > 5 && count < 1000)
                .sort((a, b) => b[1] - a[1]);
            
            if (repeatedClasses.length > 0) {
                const [className] = repeatedClasses[0];
                elements = document.querySelectorAll(`.${className.split(' ')[0]}`);
                console.log(`Found ${elements.length} repeated elements with class: ${className}`);
            }
        }
        
        // Extract information from elements
        elements.forEach((element, index) => {
            const server = {
                name: '',
                description: '',
                author: '',
                url: '',
                install: '',
                tags: []
            };
            
            // Extract name (look for headings or links)
            const headings = element.querySelectorAll('h1, h2, h3, h4, h5, h6');
            if (headings.length > 0) {
                server.name = headings[0].textContent.trim();
            } else {
                const links = element.querySelectorAll('a');
                if (links.length > 0) {
                    server.name = links[0].textContent.trim();
                }
            }
            
            // Extract description (look for paragraphs)
            const paragraphs = element.querySelectorAll('p');
            if (paragraphs.length > 0) {
                server.description = paragraphs[0].textContent.trim();
            }
            
            // Extract URLs
            const links = element.querySelectorAll('a[href]');
            links.forEach(link => {
                const href = link.getAttribute('href');
                if (href) {
                    if (href.includes('/server/')) {
                        server.url = href.startsWith('http') ? href : `https://mcp.so${href}`;
                    } else if (href.includes('github.com')) {
                        server.github = href;
                    }
                }
            });
            
            // Extract install commands (look for code blocks)
            const codeBlocks = element.querySelectorAll('code, pre');
            codeBlocks.forEach(code => {
                const text = code.textContent;
                if (text.includes('npx') || text.includes('npm install')) {
                    server.install = text.trim();
                } else if (text.includes('uvx')) {
                    server.install = text.trim();
                }
            });
            
            // Extract author (look for specific patterns)
            const authorPatterns = [
                /by\s+(@?\w+)/i,
                /author:\s*(@?\w+)/i,
                /created by\s+(@?\w+)/i
            ];
            
            const elementText = element.textContent;
            for (const pattern of authorPatterns) {
                const match = elementText.match(pattern);
                if (match) {
                    server.author = match[1];
                    break;
                }
            }
            
            // Only add if we found meaningful data
            if (server.name || server.url || server.install) {
                servers.push(server);
            }
        });
        
        // Also try to extract from script tags (React/Next.js data)
        const scriptTags = document.querySelectorAll('script');
        scriptTags.forEach(script => {
            const content = script.textContent;
            if (content && content.includes('__NEXT_DATA__')) {
                try {
                    const match = content.match(/\{.*\}/);
                    if (match) {
                        const data = JSON.parse(match[0]);
                        if (data.props?.pageProps?.servers) {
                            console.log('Found server data in __NEXT_DATA__');
                            servers.push(...data.props.pageProps.servers);
                        }
                    }
                } catch (e) {
                    // Ignore JSON parse errors
                }
            }
        });
        
        // Deduplicate servers
        const uniqueServers = [];
        const seen = new Set();
        
        servers.forEach(server => {
            const key = server.name || server.url || server.install;
            if (key && !seen.has(key)) {
                seen.add(key);
                uniqueServers.push(server);
            }
        });
        
        // Save extracted data
        const outputFile = path.join(__dirname, '../../data/mcp-so-extracted-servers.json');
        await fs.writeFile(outputFile, JSON.stringify(uniqueServers, null, 2));
        
        console.log(`\n✅ Extracted ${uniqueServers.length} servers`);
        console.log(`📄 Data saved to: ${outputFile}`);
        console.log('\nYou can now run:');
        console.log(`  node src/scrapers/mcp-so-bulk-analyzer.js analyze ${outputFile}`);
        
        return uniqueServers;
        
    } catch (error) {
        console.error('❌ HTML parsing failed:', error);
        throw error;
    }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args.includes('--help')) {
        console.log(`
Usage: node mcp-so-html-parser.js <html-file>

Parses mcp.so HTML to extract server information.

Example:
  # Save mcp.so page HTML and parse it
  node mcp-so-html-parser.js mcp-so-page.html

The HTML file should be saved from mcp.so website.
The parser will try to extract server names, descriptions,
install commands, and other relevant information.
`);
        process.exit(0);
    }
    
    const htmlFile = args[0];
    
    parseMcpSoHtml(htmlFile)
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}