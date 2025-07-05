// Debug script to understand mcp.so page structure
// Paste this into browser console on https://mcp.so/ first

(function() {
    console.log('🔍 Debugging mcp.so page structure...');
    
    // Check current URL
    console.log('Current URL:', window.location.href);
    
    // Check all links on the page
    const allLinks = document.querySelectorAll('a');
    console.log(`Total links found: ${allLinks.length}`);
    
    // Look for server-related links
    const serverLinks = Array.from(allLinks).filter(a => 
        a.href && (a.href.includes('/servers/') || a.getAttribute('href')?.includes('/servers/'))
    );
    console.log(`Server links found: ${serverLinks.length}`);
    
    if (serverLinks.length > 0) {
        console.log('Sample server links:');
        serverLinks.slice(0, 5).forEach((link, i) => {
            console.log(`${i + 1}. href="${link.href}" text="${link.textContent.trim()}"`);
        });
    }
    
    // Check page content
    console.log('Page title:', document.title);
    console.log('Body content preview:', document.body.textContent.substring(0, 200));
    
    // Check for specific elements that might contain servers
    const possibleContainers = [
        'div[class*="server"]',
        'div[class*="card"]',
        'div[class*="item"]',
        'article',
        '.grid > div',
        '[data-server]'
    ];
    
    possibleContainers.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
            console.log(`Found ${elements.length} elements with selector: ${selector}`);
        }
    });
    
    // Try to fetch the servers page directly
    console.log('Trying to fetch servers page...');
    fetch('https://mcp.so/servers?tag=latest&page=1')
        .then(response => response.text())
        .then(html => {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const links = doc.querySelectorAll('a[href*="/servers/"]');
            console.log(`Found ${links.length} server links in fetched page`);
            
            if (links.length > 0) {
                console.log('Sample links from fetched page:');
                Array.from(links).slice(0, 5).forEach((link, i) => {
                    console.log(`${i + 1}. href="${link.getAttribute('href')}" text="${link.textContent.trim()}"`);
                });
            }
            
            // Check page structure
            console.log('Page title from fetch:', doc.title);
            console.log('Body preview from fetch:', doc.body.textContent.substring(0, 200));
        })
        .catch(error => {
            console.error('Error fetching servers page:', error);
        });
    
    return 'Debug complete - check console output above';
})();