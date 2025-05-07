#!/usr/bin/env node
import https from 'https';
import fs from 'fs/promises';
import path from 'path';
import process from 'process';

// --- Configuration ---
const BASE_URL = 'https://glama.ai/api/mcp';
const SERVERS_PATH = '/v1/servers';
const PAGE_SIZE = 100; // Results per page (max allowed by Glama API for 'first' parameter)
const DEFAULT_OUTPUT_FILE = 'glama_mcp_servers.json';
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds timeout for each request
const DELAY_BETWEEN_PAGES_MS = 500; // 0.5 second delay between page fetches

// --- Helper Functions ---

/**
 * Fetches a single page of server data from the Glama MCP API.
 * @param {string | null} afterCursor - The cursor for the next page of results. Null for the first page.
 * @returns {Promise<object>} - A promise that resolves with the parsed JSON response.
 */
function fetchPage(afterCursor) {
    return new Promise((resolve, reject) => {
        const params = new URLSearchParams({
            first: PAGE_SIZE.toString(),
        });
        if (afterCursor) {
            params.append('after', afterCursor);
        }
        const url = `${BASE_URL}${SERVERS_PATH}?${params.toString()}`;
        console.error(`Fetching: ${url}`); // Log the URL being fetched

        const request = https.get(url, {
            headers: { 'User-Agent': 'mcpfinder-glama-fetch-script/1.0' } // Good practice to identify the client
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
 * Fetches all server results by handling pagination.
 * @returns {Promise<Array<object>>} - A promise that resolves with an array of all server objects.
 */
async function fetchAllResults() {
    let allServers = [];
    let currentCursor = null;
    let hasNextPage = true;
    let pageNum = 1;

    // Determine output file path
    const outputFileIndex = process.argv.findIndex(arg => arg === '--output');
    const outputFileName = outputFileIndex !== -1 && process.argv[outputFileIndex + 1]
        ? process.argv[outputFileIndex + 1]
        : DEFAULT_OUTPUT_FILE;
    const resolvedOutputPath = path.resolve(outputFileName);
    console.log(`Output will be saved incrementally to: ${resolvedOutputPath}`);

    console.log(`Starting fetch for Glama MCP servers with page size ${PAGE_SIZE}...`);

    try {
        do {
            console.log(`Fetching page ${pageNum} (cursor: ${currentCursor || 'initial'})...`);
            const pageData = await fetchPage(currentCursor);

            const serversOnPage = pageData.servers || [];
            const fetchedCount = serversOnPage.length;

            if (fetchedCount > 0) {
                allServers = allServers.concat(serversOnPage);
                console.log(`Fetched ${fetchedCount} servers. Total accumulated: ${allServers.length}`);
            } else {
                console.log('Fetched 0 servers on this page.');
            }

            if (pageData.pageInfo) {
                currentCursor = pageData.pageInfo.endCursor;
                hasNextPage = pageData.pageInfo.hasNextPage;
            } else {
                console.warn('PageInfo not found in response, assuming no more pages.');
                hasNextPage = false;
            }

            pageNum++;

            // Write current results to file after processing the page
            console.log(`Saving ${allServers.length} accumulated servers to ${resolvedOutputPath}...`);
            const outputData = {
                collectionTimestamp: new Date().toISOString(), // Update timestamp on each save
                servers: allServers // Store the raw server objects
            };
            try {
                 await fs.writeFile(resolvedOutputPath, JSON.stringify(outputData, null, 2));
                 console.log("Save successful.");
            } catch (writeError) {
                 console.error(`Error writing intermediate results to ${resolvedOutputPath}: ${writeError.message}`);
                 // Log and continue fetching
            }

            if (hasNextPage && fetchedCount > 0) { // Only delay if there are more pages and we got results
                console.log(`Waiting ${DELAY_BETWEEN_PAGES_MS}ms before next page...`);
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_PAGES_MS));
            }

        } while (hasNextPage);

        console.log(`
Fetch complete. Total servers fetched: ${allServers.length}`);

    } catch (error) {
        console.error(`Error during fetch process: ${error.message}`);
        throw error; // Re-throw to stop the script if a page fails
    }

    return allServers;
}

// --- Main Execution ---

async function main() {
    try {
        const allResults = await fetchAllResults(); // This function now handles incremental saving

        if (allResults.length > 0) {
            console.log(`
Fetch and incremental saving process complete. Final results (${allResults.length} servers) saved to ${DEFAULT_OUTPUT_FILE}.`);
        } else {
            console.log("\nFetch complete. No servers found or fetched.");
        }

    } catch (error) {
        console.error(`\nScript failed: ${error.message}`);
        process.exit(1);
    }
}

main(); 