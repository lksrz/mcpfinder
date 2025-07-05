// Script to find API endpoints that mcp.so uses
// Paste this into browser console on https://mcp.so/servers

(async function() {
    console.log('🔍 Looking for API endpoints...');
    
    // Common API endpoint patterns to try
    const possibleEndpoints = [
        'https://mcp.so/api/servers',
        'https://mcp.so/api/servers?page=1',
        'https://mcp.so/api/v1/servers',
        'https://mcp.so/api/v1/servers?page=1',
        'https://mcp.so/_next/data/servers',
        'https://mcp.so/_next/data/build-id/servers',
        'https://api.mcp.so/servers',
        'https://api.mcp.so/v1/servers'
    ];
    
    console.log('Trying common API endpoints...');
    
    for (const endpoint of possibleEndpoints) {
        try {
            console.log(`Trying: ${endpoint}`);
            const response = await fetch(endpoint);
            
            if (response.ok) {
                const contentType = response.headers.get('content-type');
                console.log(`✅ SUCCESS: ${endpoint}`);
                console.log(`   Status: ${response.status}`);
                console.log(`   Content-Type: ${contentType}`);
                
                if (contentType?.includes('json')) {
                    const data = await response.json();
                    console.log(`   Data type: ${typeof data}`);
                    console.log(`   Data preview:`, data);
                    
                    if (Array.isArray(data)) {
                        console.log(`   Array length: ${data.length}`);
                        if (data.length > 0) {
                            console.log(`   First item:`, data[0]);
                        }
                    } else if (data && typeof data === 'object') {
                        console.log(`   Object keys:`, Object.keys(data));
                    }
                }
            } else {
                console.log(`❌ ${endpoint} - Status: ${response.status}`);
            }
        } catch (error) {
            console.log(`❌ ${endpoint} - Error: ${error.message}`);
        }
        
        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Also check what network requests the page is making
    console.log('\n🌐 NETWORK MONITORING:');
    console.log('Check the Network tab in DevTools and look for:');
    console.log('1. XHR/Fetch requests');
    console.log('2. Requests to /api/ endpoints');
    console.log('3. Requests that return JSON data');
    console.log('4. Next.js data requests (_next/data/)');
    
    // Try to intercept fetch requests
    console.log('\n🕵️ INTERCEPTING FUTURE REQUESTS:');
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        console.log('Intercepted fetch request:', args[0]);
        return originalFetch.apply(this, args);
    };
    
    console.log('Now navigate to another page or refresh to see what API calls are made');
    
    return 'API endpoint search complete';
})();