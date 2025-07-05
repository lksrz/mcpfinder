// Debug what's actually on the current page
// Paste this into browser console while on https://mcp.so/servers

(function() {
    console.log('🔍 Debugging current page content...');
    
    console.log('Current URL:', window.location.href);
    console.log('Page title:', document.title);
    
    // Check all links
    const allLinks = document.querySelectorAll('a');
    console.log(`Total links on page: ${allLinks.length}`);
    
    // Check for server links with different patterns
    const patterns = [
        'a[href*="/servers/"]',
        'a[href^="/servers/"]', 
        '[href*="/servers/"]',
        'a[href*="mcp.so/servers/"]'
    ];
    
    patterns.forEach(pattern => {
        const elements = document.querySelectorAll(pattern);
        console.log(`Pattern "${pattern}": ${elements.length} matches`);
        
        if (elements.length > 0) {
            console.log('Sample matches:');
            Array.from(elements).slice(0, 3).forEach((el, i) => {
                console.log(`  ${i + 1}. href="${el.getAttribute('href')}" text="${el.textContent.trim().substring(0, 50)}"`);
            });
        }
    });
    
    // Check for specific text that might indicate servers
    const bodyText = document.body.textContent.toLowerCase();
    const serverKeywords = ['playwright', 'github', 'git', 'browser', 'filesystem'];
    
    console.log('\nChecking for server keywords in page text:');
    serverKeywords.forEach(keyword => {
        if (bodyText.includes(keyword)) {
            console.log(`✅ Found "${keyword}" in page text`);
        } else {
            console.log(`❌ "${keyword}" not found in page text`);
        }
    });
    
    // Check for dynamic content containers
    const containers = [
        '.grid',
        '.container', 
        'main',
        'section',
        '[data-*]',
        '[class*="server"]',
        '[class*="card"]'
    ];
    
    console.log('\nChecking for content containers:');
    containers.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
            console.log(`${selector}: ${elements.length} elements`);
        }
    });
    
    // Check if content is still loading
    const loadingIndicators = document.querySelectorAll('[class*="loading"], [class*="spinner"], [class*="skeleton"]');
    console.log(`\nLoading indicators found: ${loadingIndicators.length}`);
    
    // Wait a bit and check again
    console.log('\n⏳ Waiting 3 seconds for content to load...');
    
    setTimeout(() => {
        console.log('\n🔄 Re-checking after 3 seconds...');
        
        const newLinks = document.querySelectorAll('a[href*="/servers/"]:not([href$="/servers"])');
        console.log(`Server links found after wait: ${newLinks.length}`);
        
        if (newLinks.length > 0) {
            console.log('✅ Content loaded! Sample links:');
            Array.from(newLinks).slice(0, 5).forEach((link, i) => {
                console.log(`  ${i + 1}. href="${link.getAttribute('href')}" text="${link.textContent.trim()}"`);
            });
        } else {
            console.log('❌ Still no server links found');
            console.log('💡 Try:');
            console.log('1. Wait longer for the page to fully load');
            console.log('2. Scroll down to trigger lazy loading');
            console.log('3. Check Network tab for failed requests');
        }
    }, 3000);
    
    return 'Debug running... check console in 3 seconds';
})();