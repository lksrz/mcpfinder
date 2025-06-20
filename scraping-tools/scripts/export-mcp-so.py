#!/usr/bin/env python3
"""
Export mcp.so data using Selenium with undetected-chromedriver
This can often bypass Cloudflare protection

Requirements:
pip install selenium undetected-chromedriver beautifulsoup4
"""

import json
import time
import sys
from typing import List, Dict
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from bs4 import BeautifulSoup

class McpSoExporter:
    def __init__(self):
        self.base_url = "https://mcp.so/servers"
        self.servers = []
        self.driver = None
        
    def setup_driver(self):
        """Setup undetected Chrome driver"""
        options = uc.ChromeOptions()
        # options.add_argument('--headless')  # Uncomment for headless mode
        options.add_argument('--disable-blink-features=AutomationControlled')
        
        self.driver = uc.Chrome(options=options)
        self.driver.implicitly_wait(10)
        
    def wait_for_cloudflare(self):
        """Wait for Cloudflare challenge to complete"""
        time.sleep(5)  # Initial wait
        
        # Check if we're still on a Cloudflare challenge page
        try:
            if "just a moment" in self.driver.page_source.lower():
                print("Waiting for Cloudflare challenge...")
                time.sleep(10)  # Wait longer
        except:
            pass
            
    def extract_servers_from_page(self) -> List[Dict]:
        """Extract server information from current page"""
        servers = []
        soup = BeautifulSoup(self.driver.page_source, 'html.parser')
        
        # Try multiple selectors
        server_links = soup.find_all('a', href=lambda x: x and '/server/' in x)
        
        for link in server_links:
            href = link.get('href', '')
            if href == '/servers':
                continue
                
            # Get parent container
            container = link.find_parent('div', class_=lambda x: x and any(
                cls in str(x) for cls in ['card', 'item', 'grid']
            ))
            
            server = {
                'name': link.get_text(strip=True),
                'url': f"https://mcp.so{href}" if not href.startswith('http') else href,
            }
            
            if container:
                # Extract description
                desc_elem = container.find(['p', 'div'], class_=lambda x: x and 'desc' in str(x).lower())
                if desc_elem:
                    server['description'] = desc_elem.get_text(strip=True)
                
                # Extract author
                author_elem = container.find(['span', 'div'], class_=lambda x: x and 'author' in str(x).lower())
                if author_elem:
                    server['author'] = author_elem.get_text(strip=True)
                
                # Look for install commands
                code_blocks = container.find_all(['code', 'pre'])
                for code in code_blocks:
                    text = code.get_text(strip=True)
                    if any(cmd in text for cmd in ['npx', 'npm install', 'uvx']):
                        server['installCommand'] = text
                        break
            
            # Parse URL for additional info
            url_parts = href.strip('/').split('/')
            if len(url_parts) >= 3:
                server['slug'] = url_parts[-2]
                server['authorFromUrl'] = url_parts[-1]
            
            servers.append(server)
        
        # Try to extract from JavaScript data
        scripts = soup.find_all('script', id='__NEXT_DATA__')
        for script in scripts:
            try:
                data = json.loads(script.string)
                if 'props' in data and 'pageProps' in data['props']:
                    if 'servers' in data['props']['pageProps']:
                        print("Found servers in __NEXT_DATA__")
                        servers.extend(data['props']['pageProps']['servers'])
            except:
                pass
        
        # Deduplicate
        seen = set()
        unique_servers = []
        for server in servers:
            key = server.get('url', server.get('name', ''))
            if key and key not in seen:
                seen.add(key)
                unique_servers.append(server)
        
        return unique_servers
    
    def navigate_all_pages(self, max_pages: int = 510):
        """Navigate through all pages and extract data"""
        current_page = 1
        
        # Go to first page
        url = f"{self.base_url}?tag=latest"
        print(f"Loading {url}")
        self.driver.get(url)
        self.wait_for_cloudflare()
        
        while current_page <= max_pages:
            print(f"\nProcessing page {current_page}...")
            
            # Wait for content to load
            try:
                WebDriverWait(self.driver, 10).until(
                    EC.presence_of_element_located((By.TAG_NAME, "a"))
                )
            except:
                print("Timeout waiting for page to load")
            
            # Extract servers
            page_servers = self.extract_servers_from_page()
            print(f"Found {len(page_servers)} servers on page {current_page}")
            
            if not page_servers:
                print("No servers found, checking if we've reached the end...")
                time.sleep(2)
                page_servers = self.extract_servers_from_page()
                if not page_servers:
                    print("No more servers, stopping.")
                    break
            
            self.servers.extend(page_servers)
            
            # Try to go to next page
            next_url = f"{self.base_url}?tag=latest&page={current_page + 1}"
            
            try:
                # Method 1: Click next button
                next_button = self.driver.find_element(
                    By.XPATH, 
                    f"//a[contains(@href, 'page={current_page + 1}')]"
                )
                next_button.click()
                time.sleep(2)
            except:
                # Method 2: Direct navigation
                self.driver.get(next_url)
                time.sleep(2)
            
            current_page += 1
        
        print(f"\nExtraction complete. Total servers: {len(self.servers)}")
    
    def save_data(self, filename: str = "mcp-so-servers.json"):
        """Save extracted data to JSON file"""
        # Deduplicate final list
        seen = set()
        unique_servers = []
        
        for server in self.servers:
            key = server.get('url', server.get('name', ''))
            if key and key not in seen:
                seen.add(key)
                unique_servers.append(server)
        
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(unique_servers, f, indent=2, ensure_ascii=False)
        
        print(f"\nSaved {len(unique_servers)} unique servers to {filename}")
        
    def extract_single_page(self, page_num: int = 1):
        """Extract data from a single page"""
        url = f"{self.base_url}?tag=latest" if page_num == 1 else f"{self.base_url}?tag=latest&page={page_num}"
        print(f"Loading {url}")
        
        self.driver.get(url)
        self.wait_for_cloudflare()
        
        servers = self.extract_servers_from_page()
        print(f"Found {len(servers)} servers")
        return servers
    
    def run(self, mode: str = "all", max_pages: int = 510):
        """Run the exporter"""
        try:
            self.setup_driver()
            
            if mode == "all":
                self.navigate_all_pages(max_pages)
                self.save_data()
            elif mode == "single":
                servers = self.extract_single_page()
                print(json.dumps(servers, indent=2))
            
        finally:
            if self.driver:
                self.driver.quit()

def main():
    import argparse
    
    parser = argparse.ArgumentParser(description="Export mcp.so server data")
    parser.add_argument(
        "--mode", 
        choices=["all", "single"], 
        default="all",
        help="Extract all pages or just current page"
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=510,
        help="Maximum number of pages to extract"
    )
    parser.add_argument(
        "--output",
        default="mcp-so-servers.json",
        help="Output filename"
    )
    
    args = parser.parse_args()
    
    exporter = McpSoExporter()
    
    print("==============================================")
    print("mcp.so Data Exporter (Selenium)")
    print("==============================================")
    print(f"Mode: {args.mode}")
    print(f"Max pages: {args.max_pages}")
    print(f"Output: {args.output}")
    print("==============================================\n")
    
    try:
        exporter.run(mode=args.mode, max_pages=args.max_pages)
        
        if args.mode == "all" and args.output != "mcp-so-servers.json":
            import shutil
            shutil.move("mcp-so-servers.json", args.output)
            
        print("\nNext steps:")
        print(f"1. Check the exported file: {args.output}")
        print(f"2. Analyze the data: node src/scrapers/mcp-so-bulk-analyzer.js analyze {args.output}")
        
    except KeyboardInterrupt:
        print("\nExport interrupted by user")
        if exporter.servers:
            exporter.save_data("mcp-so-partial.json")
            print("Partial data saved to mcp-so-partial.json")
    except Exception as e:
        print(f"\nError: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()