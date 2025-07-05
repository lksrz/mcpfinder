// Debug script to see what we actually get when fetching mcp.so pages
// Paste this into browser console

(async function() {
    console.log('🔍 Debugging fetch vs current page content...');
    
    // Check what's on the current page
    console.log('\n1. CURRENT PAGE CONTENT:');
    const currentLinks = document.querySelectorAll('a[href*="/servers/"]:not([href$="/servers"])');
    console.log(`Found ${currentLinks.length} server links on current page`);
    
    if (currentLinks.length > 0) {
        console.log('Sample current page links:');
        Array.from(currentLinks).slice(0, 3).forEach((link, i) => {
            console.log(`  ${i + 1}. href="${link.getAttribute('href')}" text="${link.textContent.trim()}"`);
        });
    }
    
    // Now try fetching the same page
    console.log('\n2. FETCHED PAGE CONTENT:');
    try {
        const response = await fetch('https://mcp.so/servers?page=1');
        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        console.log('Fetched page title:', doc.title);
        console.log('Fetched HTML size:', html.length, 'characters');
        
        const fetchedLinks = doc.querySelectorAll('a[href*="/servers/"]:not([href$="/servers"])');
        console.log(`Found ${fetchedLinks.length} server links in fetched HTML`);
        
        if (fetchedLinks.length > 0) {
            console.log('Sample fetched links:');
            Array.from(fetchedLinks).slice(0, 3).forEach((link, i) => {
                console.log(`  ${i + 1}. href="${link.getAttribute('href')}" text="${link.textContent.trim()}"`);
            });
        }
        
        // Check if there are any script tags that might load content
        const scripts = doc.querySelectorAll('script');
        console.log(`Found ${scripts.length} script tags in fetched HTML`);
        
        // Look for Next.js data or other dynamic content indicators
        const nextDataScript = Array.from(scripts).find(script => 
            script.textContent.includes('__NEXT_DATA__') || 
            script.textContent.includes('buildId') ||
            script.textContent.includes('props')
        );
        
        if (nextDataScript) {
            console.log('Found Next.js data script - content is dynamically loaded');
            console.log('Script content preview:', nextDataScript.textContent.substring(0, 200));
        }
        
        // Check for any data attributes or other content
        const allElements = doc.querySelectorAll('*');
        console.log(`Total elements in fetched HTML: ${allElements.length}`);
        
        // Look for any elements that might contain server data
        const potentialContainers = doc.querySelectorAll('[data-*], .grid, .container, main, section');
        console.log(`Potential container elements: ${potentialContainers.length}`);
        
    } catch (error) {
        console.error('Error fetching page:', error);
    }
    
    // Check if there's an API endpoint we could use instead
    console.log('\n3. LOOKING FOR API ENDPOINTS:');
    
    // Check network tab or look for API calls
    console.log('You should check the Network tab in DevTools to see what API calls mcp.so makes');
    console.log('Look for XHR/Fetch requests that return JSON with server data');
    
    return 'Debug complete - check console output above';
})();