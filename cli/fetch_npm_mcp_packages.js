#!/usr/bin/env node
import https from 'https';
import fs from 'fs/promises';
import path from 'path';
import process from 'process';

// --- Configuration ---
const BASE_URL = 'https://registry.npmjs.org';
const SEARCH_PATH = '/-/v1/search';
const QUERY = 'modelcontextprotocol'; // Search term eg. keywords:mcp
const SIZE = 250; // Results per page (max allowed by npm registry API)
const DEFAULT_OUTPUT_FILE = 'npm_mcp_search_results2.json';
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds timeout for each request
const DELAY_BETWEEN_PAGES_MS = 500; // 0.5 second delay between page fetches

// --- Helper Functions ---

/**
 * Fetches a single page of search results from the npm registry.
 * @param {number} from - The starting index for the search results.
 * @returns {Promise<object>} - A promise that resolves with the parsed JSON response.
 */
function fetchPage(from) {
    return new Promise((resolve, reject) => {
        const params = new URLSearchParams({
            text: QUERY,
            size: SIZE.toString(),
            from: from.toString(),
        });
        const url = `${BASE_URL}${SEARCH_PATH}?${params.toString()}`;
        console.error(`Fetching: ${url}`); // Log the URL being fetched

        const request = https.get(url, {
            headers: { 'User-Agent': 'mcpfinder-fetch-script/1.0' } // Good practice to identify the client
        },(res) => {
            let data = '';
            if (res.statusCode !== 200) {
                reject(new Error(`Request Failed. Status Code: ${res.statusCode} for URL: ${url}`));
                res.resume(); // Consume response data to free up memory
                return;
            }

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const jsonData = JSON.parse(data);
                    resolve(jsonData);
                } catch (e) {
                    reject(new Error(`Failed to parse JSON response from ${url}: ${e.message}`));
                }
            });
        }).on('error', (err) => {
            // Reject on request error (e.g., DNS resolution, TCP connection)
            reject(new Error(`HTTPS request error for ${url}: ${err.message}`));
        });

        // Add a timeout to the request
        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
            request.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms for URL: ${url}`));
        });
    });
}

/**
 * Fetches all search results by handling pagination.
 * @returns {Promise<Array<object>>} - A promise that resolves with an array of all package objects.
 */
async function fetchAllResults() {
    let allObjects = [];
    let from = 0;
    let totalResults = -1; // Use -1 to indicate total is unknown initially
    let fetchedCount = 0;
    let pageNum = 1;
    // Track the output file path globally within this function for repeated writes
    const outputFileIndex = process.argv.findIndex(arg => arg === '--output');
    const outputFileName = outputFileIndex !== -1 && process.argv[outputFileIndex + 1]
        ? process.argv[outputFileIndex + 1]
        : DEFAULT_OUTPUT_FILE;
    const resolvedOutputPath = path.resolve(outputFileName);
    console.log(`Output will be saved incrementally to: ${resolvedOutputPath}`);

    console.log(`Starting fetch for query "${QUERY}" with page size ${SIZE}...`);

    try {
        do {
            console.log(`Fetching page ${pageNum} (from index ${from})...`);
            const pageData = await fetchPage(from);

            if (totalResults === -1 && pageData.total !== undefined) {
                totalResults = pageData.total;
                console.log(`Total potential results reported by API: ${totalResults}`);
            }

            const objects = pageData.objects || [];
            fetchedCount = objects.length; // Number of results in the *current* page

            if (fetchedCount > 0) {
                allObjects = allObjects.concat(objects);
                console.log(`Fetched ${fetchedCount} results. Total accumulated: ${allObjects.length}`);
            } else {
                console.log('Fetched 0 results, assuming end of list.');
            }

            from += SIZE; // Prepare for the next page
            pageNum++;

            // Write current results to file after processing the page
            console.log(`Saving ${allObjects.length} accumulated results to ${resolvedOutputPath}...`);
            const outputData = {
                collectionTimestamp: new Date().toISOString(), // Update timestamp on each save
                packages: allObjects.map(pkgResult => ({
                    ...pkgResult, // Spread the original package result
                    processed: 0 // Add the processed status
                }))
            };
            try {
                 await fs.writeFile(resolvedOutputPath, JSON.stringify(outputData, null, 2));
                 console.log("Save successful.");
            } catch (writeError) {
                 console.error(`Error writing intermediate results to ${resolvedOutputPath}: ${writeError.message}`);
                 // Decide if we should stop or continue despite write error
                 // For now, let's log and continue fetching
            }

            // Add a delay before the next fetch
            if (fetchedCount === SIZE) { // Only delay if we expect more pages
                console.log(`Waiting ${DELAY_BETWEEN_PAGES_MS}ms before next page...`);
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_PAGES_MS));
            }

            // Continue if the last page was full (might be more results)
            // Stop if the last fetch returned fewer items than requested size, or if 0 items were returned.
        } while (fetchedCount === SIZE);

        console.log(`
Fetch complete. Total results fetched: ${allObjects.length}`);
        if (totalResults !== -1 && allObjects.length < totalResults) {
             console.warn(`Warning: Fetched ${allObjects.length} results, but API reported ${totalResults} total. There might be discrepancies or API limits.`);
        } else if (totalResults === -1) {
             console.warn("Warning: API did not report a total number of results.");
        }

    } catch (error) {
        console.error(`Error during fetch process: ${error.message}`);
        // Optionally re-throw or handle differently depending on desired behavior on error
        throw error; // Re-throw to stop the script if a page fails
    }

    return allObjects;
}

// --- Main Execution ---

async function main() {
    // Output path determination is now handled within fetchAllResults for incremental saves
    // We just need to call it.

    try {
        const allResults = await fetchAllResults(); // This function now handles incremental saving

        // Final log message after loop completion
        if (allResults.length > 0) {
            console.log(`
Fetch and incremental saving process complete. Final results (${allResults.length} packages) saved.`);
        } else {
            console.log("\nFetch complete. No results found or fetched.");
        }

    } catch (error) {
        console.error(`\nScript failed: ${error.message}`);
        process.exit(1);
    }
}

main(); 