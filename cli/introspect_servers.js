#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs/promises';
import path from 'path';
import process from 'process';
import { exec } from 'child_process'; // Added for running CLI
import util from 'util'; // Added for promisify
import os from 'os'; // For potential future CPU count based concurrency

// --- Configuration ---
const NpmResultsInputFile = path.resolve(process.cwd(), '../npm_mcp_search_results.json'); // Ensure absolute path
const TempManifestFile = path.resolve(process.cwd(), 'temp_mcp_manifest.json'); // Ensure absolute path, potentially move to os.tmpdir()?
const connectionTimeoutMs = 15000; // 15 seconds to connect and initialize
const requestTimeoutMs = 30000; // 30 seconds for list requests
const initialRequestTimeoutMs = 20000; // Increased timeout for the *first* request (was requestTimeoutMs / 2)
const CliScriptPath = path.resolve(process.cwd(), './cli/bin/mcp-cli.js'); // Ensure absolute path
const CONCURRENCY_LIMIT = 32; // Max concurrent introspection tasks

const execPromise = util.promisify(exec); // Promisify exec

// --- Concurrency Helpers --- START

/**
 * A simple asynchronous lock.
 */
class Lock {
    constructor() {
        this._locked = false;
        this._waiting = [];
    }

    acquire() {
        return new Promise(resolve => {
            if (!this._locked) {
                this._locked = true;
                resolve();
            } else {
                this._waiting.push(resolve);
            }
        });
    }

    release() {
        if (this._waiting.length > 0) {
            const nextResolve = this._waiting.shift();
            nextResolve(); // Let the next waiting acquire the lock
        } else {
            this._locked = false;
        }
    }
}

/**
 * Runs async tasks from an iterable with a concurrency limit.
 * @template T
 * @param {number} concurrencyLimit Max number of tasks to run at once.
 * @param {Iterable<T>} iterable Input items to process.
 * @param {(item: T) => Promise<void>} iteratorFn Async function to process each item.
 */
async function asyncPool(concurrencyLimit, iterable, iteratorFn) {
    const executing = new Set();
    const errors = [];
    for (const item of iterable) {
        const p = Promise.resolve().then(() => iteratorFn(item)).catch(err => errors.push(err));
        executing.add(p);
        const clean = () => executing.delete(p);
        p.then(clean).catch(clean);
        if (executing.size >= concurrencyLimit) {
            await Promise.race(executing);
        }
    }
    await Promise.all(executing);
    if (errors.length > 0) {
        // Optionally, re-throw the first error or an aggregate error
        throw new Error(`Errors occurred during concurrent processing: ${errors.map(e => e.message).join(', ')}`);
    }
}

// --- Concurrency Helpers --- END

// Processed Status Codes:
// 0: Not processed
// 1: Processed, determined not an MCP server
// 2: Processed, introspection or registration failed
// 3: Processed, introspection and registration successful

// --- Helper Functions ---

function timeoutPromise(ms, promise, errorMsg) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(errorMsg)), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

/**
 * Saves the entire data structure back to the JSON file.
 * @param {object} data The full data object (including timestamp and packages array).
 * @param {string} filePath The path to save the file.
 */
async function saveResults(data, filePath) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        console.log(`Successfully updated results in ${filePath}`);
    } catch (writeError) {
        console.error(`Error writing results to file ${filePath}: ${writeError.message}`);
        // Depending on desired behavior, we might want to exit or retry
    }
}

/**
 * Generates an MCP manifest object from introspection results.
 * @param {object} results - The results object from introspectServer.
 * @returns {object|null} - The generated manifest object or null if essential info is missing.
 */
function generateManifest(results) {
    const packageName = results?.connectionParams?.packageName;
    if (!packageName) {
        console.error("Cannot generate manifest: Missing connectionParams.packageName in results.");
        return null;
    }

    // --- Construct Capabilities Array (Schema Compliant) --- START
    const capabilitiesArray = [];
    // Add tools
    (results.tools || []).forEach(tool => {
        capabilitiesArray.push({
            name: tool.name, // Assuming tool object has a name
            type: 'tool',
            description: tool.description || `${tool.name} tool` // Use tool description or generate default
        });
    });
    // Add resources (if any)
    (results.resources || []).forEach(resource => {
        capabilitiesArray.push({
            name: resource.name, // Assuming resource object has a name
            type: 'resource',
            description: resource.description || `${resource.name} resource`
        });
    });
    // Add prompts (if any)
    (results.prompts || []).forEach(prompt => {
        capabilitiesArray.push({
            name: prompt.name, // Assuming prompt object has a name
            type: 'prompt',
            description: prompt.description || `${prompt.name} prompt`
        });
    });

    // Ensure capabilities is not empty if required by schema (minItems: 1)
    if (capabilitiesArray.length === 0) {
         console.warn(`Warning: No capabilities found for ${packageName}. Manifest might be rejected if capabilities array cannot be empty.`);
         // Depending on strictness, might need to add a placeholder or return null
         // For now, allow empty array based on assumption it might be permissible despite minItems: 1
         // Or add a placeholder capability?
         // capabilitiesArray.push({ name: "placeholder", type: "tool", description: "Placeholder capability" });
    }
    // --- Construct Capabilities Array --- END

    // --- Generate Manifest (Schema Compliant) --- START
    const manifest = {
        // Required fields from schema
        name: results?.serverInfo?.name || packageName, // Prefer serverInfo name if available, else package name
        description: results?.serverInfo?.description || `${packageName} MCP Server`, // Prefer serverInfo description
        url: packageName, // Use package name directly as instruction for stdio
        protocol_version: "MCP/1.0", // Placeholder protocol version
        capabilities: capabilitiesArray,

        // Optional fields from schema (if available)
        // tags: [], // Not available from introspection
        // auth: { type: "none" } // Assume none if not introspected

        // --- Fields NOT in schema (REMOVED) ---
        // manifestVersion: "1.0",
        // server: { ... },
        // connection: { ... },
        // tools: results.tools || [],
        // resources: results.resources || [],
        // prompts: results.prompts || [],
    };
    // --- Generate Manifest (Schema Compliant) --- END


    // --- Add Optional Fields --- START
    // Add auth if available in serverInfo (unlikely but possible in future SDK versions)
    if (results?.serverInfo?.auth) {
        manifest.auth = results.serverInfo.auth; // Assuming structure matches schema
    }
    // Add tags if available
    if (results?.serverInfo?.tags && Array.isArray(results.serverInfo.tags)) {
         manifest.tags = results.serverInfo.tags;
    }
    // --- Add Optional Fields --- END


    return manifest;
}


/**
 * Registers a manifest using the mcp-cli.js script.
 * @param {object} manifestJson - The manifest object to register.
 * @returns {Promise<boolean>} - True if registration was successful, false otherwise.
 */
async function registerViaCli(manifestJson) {
    if (!process.env.MCPFINDER_REGISTRY_SECRET) {
        console.error("Registration skipped: MCPFINDER_REGISTRY_SECRET is not set.");
        return false;
    }
    if (!manifestJson) {
         console.error("Registration skipped: Manifest JSON is null or undefined.");
         return false;
    }

    const manifestString = JSON.stringify(manifestJson, null, 2);
    const tempFilePath = TempManifestFile;

    // --- Add Logging --- START
    console.log("--- Generated Manifest Content (for debugging validation) ---");
    console.log(manifestString);
    console.log("-------------------------------------------------------------");
    // --- Add Logging --- END

    try {
        console.log(`Writing temporary manifest to ${tempFilePath}...`);
        await fs.writeFile(tempFilePath, manifestString);

        const command = `node ${CliScriptPath} register ${tempFilePath}`;
        console.log(`Executing CLI registration: ${command} (Paths are absolute)`);

        // Execute the command, inheriting the environment (including the secret)
        const { stdout, stderr } = await execPromise(command, { env: process.env });

        console.log('CLI stdout:', stdout);
        if (stderr) {
            console.error('CLI stderr:', stderr);
        }

        // Check exit code (implicit in execPromise not throwing) and stdout message
        if (stdout.includes('Registration successful!')) {
            console.log('Registration via CLI reported success.');
            return true;
        } else {
            console.error('Registration via CLI did not report success.');
            return false;
        }

    } catch (error) {
        console.error(`Error during CLI registration process: ${error.message}`);
        if (error.stdout) console.error('CLI stdout (on error):', error.stdout);
        if (error.stderr) console.error('CLI stderr (on error):', error.stderr);
        return false;
    } finally {
        // Clean up the temporary file
        try {
            await fs.unlink(tempFilePath);
            console.log(`Deleted temporary manifest file: ${tempFilePath}`);
        } catch (unlinkError) {
            // Log error but don't fail the registration outcome
            console.error(`Warning: Could not delete temporary manifest file ${tempFilePath}: ${unlinkError.message}`);
        }
    }
}


/**
 * Attempts to introspect a single server package.
 * @param {object} npmPackage - The package object from npm_mcp_search_results.json.
 * @returns {Promise<{status: string, results: object}>} - Status ('NOT_MCP', 'SUCCESS', 'FAILURE') and results.
 */
async function introspectServer(npmPackage) {
    const packageName = npmPackage?.package?.name;
    if (!packageName) {
        return { status: 'FAILURE', results: { error: 'Invalid package data, missing name.' } };
    }

    console.error(`\n--- Introspecting ${packageName} ---`);
    let client = null;
    let transport = null;
    let stderrOutput = ''; // Variable to store stderr output
    let tempDir = null; // Variable to store the temporary directory path

    const results = {
        connectionParams: {
            command: 'npx',
            packageName: packageName,
            args: [],
            env: {}
        },
        serverInfo: null,
        capabilities: null,
        tools: [],
        resources: [],
        prompts: [],
        error: null
    };

    try {
        // --- 0. Create Temporary Directory ---
        const tempDirPrefix = path.join(os.tmpdir(), `mcp-introspect-${packageName.replace(/[^a-zA-Z0-9]/g, '_')}-`);
        tempDir = await fs.mkdtemp(tempDirPrefix);
        console.error(`Created temporary directory for ${packageName}: ${tempDir}`);


        // --- 1. Create Transport ---
        const spawnArgs = [packageName];
        const transportEnv = { ...process.env };
        const defaultEnv = getDefaultEnvironment();
        const finalEnv = { ...transportEnv, ...defaultEnv };

        console.error(`Attempting to launch '${packageName}' via npx...`);
        transport = new StdioClientTransport({
            command: 'npx',
            args: spawnArgs,
            env: finalEnv,
            stderr: 'pipe',
            cwd: tempDir // <--- Run npx in the temporary directory
        });

        // --- 2. Attach stderr Listener ---
        // Use optional chaining and check if stderr is readable
        if (transport.process?.stderr && typeof transport.process.stderr.on === 'function') {
            console.error("Attaching stderr listener...");
            transport.process.stderr.on('data', (data) => {
                const str = data.toString();
                // console.error(`[${packageName} stderr DATA]: ${str}`); // Verbose logging
                stderrOutput += str;
            });
             transport.process.stderr.on('error', (err) => {
                  console.error(`[${packageName} stderr ERR]: ${err.message}`);
                  stderrOutput += `[STDERR_ERROR: ${err.message}]`;
             });
             transport.process.stderr.on('end', () => {
                 // console.error(`[${packageName} stderr END]`); // Verbose logging
             });
             transport.process.on('error', (err) => { // Also listen for errors on the process itself
                 console.error(`[${packageName} process ERROR]: ${err.message}`);
                 stderrOutput += `[PROCESS_ERROR: ${err.message}]`;
             });
             transport.process.on('exit', (code, signal) => { // Log unexpected exits
                 // We expect the process to stay alive until client.close()
                 console.error(`[${packageName} process EXIT unexpectedly]: code=${code}, signal=${signal}`);
                 stderrOutput += `[PROCESS_EXIT code=${code} signal=${signal}]`;
             });

        } else {
            // Log warning but continue, connection attempt will likely fail if process didn't start
            console.error("Warning: Could not attach stderr listener (transport.process or stderr might be null/undefined, or process exited too fast).");
        }

        // --- 3. Connect Client ---
        client = new Client({ name: 'mcp-introspector', version: '1.0.0' });
        console.error(`Connecting to ${packageName}...`);
        await timeoutPromise(
            connectionTimeoutMs,
            client.connect(transport),
            `Connection timeout for ${packageName}`
        );
        console.error(`Connected to ${packageName}.`);

        // --- 4. Attempt Initial listTools (Primary Check) ---
        console.error("Attempting initial listTools() to potentially initialize connection and check viability...");
        let listToolsSucceeded = false;
        try {
             const initialToolsResult = await timeoutPromise(
                 requestTimeoutMs,
                 client.listTools(),
                 `Initial listTools timeout for ${packageName}`
             );
             results.tools = initialToolsResult.tools || [];
             listToolsSucceeded = true; // Mark success
             console.error(`Initial listTools call succeeded. Found ${results.tools.length} tools.`);
        } catch (initialToolError) {
             console.error(`Initial listTools call failed: ${initialToolError.message}. Assuming not a viable MCP server.`);
             results.error = `Failed initial listTools: ${initialToolError.message}`; // Record the error
             // Throw specific error to be caught below and marked as NOT_MCP
             throw new Error(`LIST_TOOLS_FAILED`);
        }

        // --- 5. Capture ServerInfo & Capabilities (Best Effort) ---
        // Try to capture these after the successful listTools call, but don't fail if unavailable
        console.error("Attempting to capture ServerInfo and Capabilities (best effort)...");
        results.serverInfo = client.serverInfo;
        results.capabilities = client.serverCapabilities;
        if (results.serverInfo?.name) {
             console.error(`Server Info captured: ${results.serverInfo.name} (Version: ${results.serverInfo.version || 'unknown'})`);
        } else {
             console.warn(`Warning: ServerInfo was not available after listTools succeeded.`);
        }
        if (results.capabilities) {
             console.error(`Capabilities captured:`, JSON.stringify(results.capabilities, null, 2));
        } else {
             console.warn(`Warning: ServerCapabilities were not available after listTools succeeded.`);
        }

        // --- 6. Full Introspection (Resources/Prompts) ---
        console.error("Proceeding with further introspection (resources/prompts)...");

        // Resources (Check captured capabilities)
        if (results.capabilities?.resources) {
             try {
                 console.error("Attempting listResources..."); // Added log
                 const resourcesResult = await timeoutPromise(
                     requestTimeoutMs,
                     client.listResources(),
                     `listResources timeout for ${packageName}`
                 );
                 results.resources = resourcesResult.resources || [];
                 console.error(`Found ${results.resources.length} resources.`);
             } catch (resourceError) {
                 console.error(`Error during listResources for ${packageName}:`, resourceError.message);
                  if (!results.error) results.error = `Failed listResources: ${resourceError.message}`;
             }
         }

        // Prompts
        if (results.capabilities?.prompts) {
             try {
                 const promptsResult = await timeoutPromise(
                     requestTimeoutMs,
                     client.listPrompts(),
                     `listPrompts timeout for ${packageName}`
                 );
                 results.prompts = promptsResult.prompts || [];
                 console.error(`Found ${results.prompts.length} prompts.`);
             } catch (promptError) {
                 console.error(`Error during listPrompts for ${packageName}:`, promptError.message);
                  if (!results.error) results.error = `Failed listPrompts: ${promptError.message}`;
             }
         }

        // If we reach here, introspection is considered successful
        console.error(`--- Finished ${packageName} (Success) ---`);
        // Close client gracefully on success path
        await client.close().catch(closeErr => console.error(`Error closing client on success: ${closeErr.message}`));
        return { status: 'SUCCESS', results };

    } catch (error) {
        // --- 7. Handle Errors ---
        console.error(`Error during introspection process for ${packageName}:`, error.message);
        // Append stderr snippet, limit length
        const stderrSnippet = stderrOutput.substring(0, 300) + (stderrOutput.length > 300 ? '...' : '');
        results.error = `${error.message}. Stderr: ${stderrSnippet}`;

        // Determine final status based on error type or stderr content
        let finalStatus = 'FAILURE'; // Default to failure

        // Check for specific connection/startup issues indicated by stderr or error type
        if (stderrOutput.includes('command not found') || stderrOutput.includes('Not found') || stderrOutput.includes('Cannot find module') || error.code === 'ENOENT') {
             console.error(`[${packageName}] stderr or error suggests package not found or failed execution. Assuming NOT_MCP.`);
             finalStatus = 'NOT_MCP';
        }
        // Check if the error was the specific "LIST_TOOLS_FAILED" error we threw
        else if (error.message === 'LIST_TOOLS_FAILED') {
             console.error(`[${packageName}] Initial listTools failed. Assuming NOT_MCP.`);
             finalStatus = 'NOT_MCP';
             // Keep the error message from the listTools failure
        }
        // Connection timeout or other specific errors might indicate it's not an MCP server or just slow/unresponsive
        else if (error.message.includes("timeout for") || error.message.includes("closed before handshake")) {
             console.error(`[${packageName}] Connection timed out or closed early. Assuming NOT_MCP.`);
             finalStatus = 'NOT_MCP';
        }
        // Add more specific checks if needed based on observed errors

        console.error(`--- Finished ${packageName} (${finalStatus}) ---`);
        // Attempt to close client if it exists, even in error paths
        if (client && client.isConnected) {
             await client.close().catch(closeErr => console.error(`[${packageName}] Error closing client during error handling: ${closeErr.message}`));
        } else if (transport?.process) {
            // If client didn't connect but process might still be running, try killing it
            console.error(`[${packageName}] Attempting to terminate lingering process...`);
            transport.process.kill('SIGTERM'); // or 'SIGKILL' if necessary
        }

        return { status: finalStatus, results };
    } finally {
        // --- 8. Cleanup Temporary Directory ---
        if (tempDir) {
            console.error(`[${packageName}] Cleaning up temporary directory: ${tempDir}`);
            try {
                await fs.rm(tempDir, { recursive: true, force: true });
                console.error(`[${packageName}] Successfully removed temporary directory: ${tempDir}`);
            } catch (cleanupError) {
                console.error(`[${packageName}] Warning: Failed to remove temporary directory ${tempDir}: ${cleanupError.message}`);
                // Log the error but don't let it affect the function's return value
            }
        }
    }
}

// --- Main Execution ---

async function main() {
    // Check for required environment variable
    if (!process.env.MCPFINDER_REGISTRY_SECRET) {
        console.warn('Warning: MCPFINDER_REGISTRY_SECRET environment variable is not set.');
        console.warn('Introspection will proceed, but registration attempts will be skipped.');
        // Allow script to continue for introspection-only runs, but registration will fail later if attempted.
    }

    let npmResultsData;
    let fileContent = ''; // Variable to store raw file content
    try {
        console.log(`Current working directory: ${process.cwd()}`); // Debug log
        console.log(`Attempting to read npm search results from: ${NpmResultsInputFile}`); // Debug log
        fileContent = await fs.readFile(NpmResultsInputFile, 'utf-8');
        console.log(`Successfully read file. First 500 chars:\n---\n${fileContent.substring(0, 500)}
---`); // Debug log
        npmResultsData = JSON.parse(fileContent);
        if (!npmResultsData || !Array.isArray(npmResultsData.packages)) {
            throw new Error("Invalid input file format. Expected object with 'packages' array.");
        }
        console.log(`Found ${npmResultsData.packages.length} total packages in the input file.`);
    } catch (readError) {
        console.error(`Error processing input file ${NpmResultsInputFile}:`); // General error message
        if (readError.code === 'ENOENT') {
            console.error(`Reason: File not found.`);
        } else if (readError instanceof SyntaxError) {
            console.error(`Reason: Could not parse JSON.`);
            console.error(`Specific JSON Parse Error: ${readError.message}`);
            console.error(`First 500 chars of content that failed parsing:\n---\n${fileContent.substring(0, 500)}
---`); // Log content again on parse error
        } else {
            console.error(`Reason: Other read/parse error:`, readError.message);
        }
        process.exit(1);
    }

    // --- Re-enable filter --- START
    const allPackages = npmResultsData.packages;
    const packagesToProcess = allPackages.filter(p => p.processed === 0);
    console.log(`Found ${allPackages.length} total packages. Filtered to ${packagesToProcess.length} packages where processed === 0.`);
    // --- Re-enable filter --- END

    // const packagesToProcess = npmResultsData.packages; // Process ALL packages - DISABLED
    // console.log(`Found ${packagesToProcess.length} packages. Filter for processed === 0 is DISABLED.`); - DISABLED

    if (packagesToProcess.length === 0) {
        console.log("No packages require processing.");
        return;
    }

    console.log(`Starting processing for ${packagesToProcess.length} packages with concurrency ${CONCURRENCY_LIMIT}...`);

    let processedCount = 0;
    let successCount = 0;
    let notMcpCount = 0;
    let failureCount = 0;
    const totalPackages = packagesToProcess.length;
    const saveLock = new Lock(); // Lock for saving the results file

    const processPackage = async (npmPackage) => {
        const index = allPackages.indexOf(npmPackage); // Find index in original array for saving
        const currentCount = ++processedCount; // Increment processed count atomically (within this task)
        const packageName = npmPackage?.package?.name || `unknown_package_${index}`;

        console.log(`[${currentCount}/${totalPackages}] Starting: ${packageName}`);

        const { status: introspectionStatus, results: introspectionResults } = await introspectServer(npmPackage);

        let finalStatus = 0; // Default to unprocessed
        let registrationAttempted = false;
        let registrationSuccess = false;

        if (introspectionStatus === 'NOT_MCP') {
            console.log(`[${packageName}] Result: NOT_MCP`);
            finalStatus = 1;
            notMcpCount++;
        } else if (introspectionStatus === 'FAILURE') {
            console.log(`[${packageName}] Result: FAILED Introspection. Error: ${introspectionResults.error}`);
            finalStatus = 2;
            failureCount++;
        } else if (introspectionStatus === 'SUCCESS') {
            console.log(`[${packageName}] Result: SUCCESS Introspection. Attempting registration...`);
            const manifest = generateManifest(introspectionResults);
            if (manifest) {
                registrationAttempted = true;
                registrationSuccess = await registerViaCli(manifest);
                if (registrationSuccess) {
                    console.log(`[${packageName}] Result: SUCCEEDED Registration.`);
                    finalStatus = 3;
                    successCount++;
                } else {
                    console.log(`[${packageName}] Result: FAILED Registration.`);
                    finalStatus = 2;
                    failureCount++;
                }
            } else {
                 console.log(`[${packageName}] Result: FAILED Manifest Generation (introspection was SUCCESS).`);
                 finalStatus = 2; // Treat as failure if manifest can't be generated
                 failureCount++;
            }
        }

        // Acquire lock before updating shared data and writing file
        await saveLock.acquire();
        try {
            // Update the status and error in the original package object within npmResultsData
            const packageInGlobalArray = npmResultsData.packages[index]; // Access via index
            if (packageInGlobalArray) { // Safety check
                packageInGlobalArray.processed = finalStatus;
                 // Add introspection error details (if any) to the package data for reference
                 if (introspectionResults?.error) {
                      packageInGlobalArray.introspectionError = introspectionResults.error;
                 } else {
                     // Clear previous error if successful now
                     delete packageInGlobalArray.introspectionError;
                 }
                 // Optionally add registration info
                 if (registrationAttempted) {
                      packageInGlobalArray.registrationAttempted = true;
                      packageInGlobalArray.registrationSuccess = registrationSuccess;
                 }
            } else {
                 console.error(`Error: Could not find package at index ${index} to update status.`);
            }


            // Update the timestamp on each save as well
            npmResultsData.collectionTimestamp = new Date().toISOString();
            await saveResults(npmResultsData, NpmResultsInputFile); // saveResults writes the whole file

            console.log(`[${currentCount}/${totalPackages}] Saved: ${packageName} (Status: ${finalStatus}). Counts: Success=${successCount}, NotMCP=${notMcpCount}, Failed=${failureCount}`);

        } catch (saveError) {
            console.error(`[${packageName}] CRITICAL: Failed to save results after processing: ${saveError.message}`);
            // Decide how to handle save errors - potentially stop the pool?
        } finally {
            saveLock.release();
        }

    }; // End of processPackage function

    try {
        await asyncPool(CONCURRENCY_LIMIT, packagesToProcess, processPackage);
    } catch (poolError) {
        console.error(`Error occurred during concurrent processing pool: ${poolError.message}`);
        // Pool errors likely indicate issues within processPackage (like save errors)
    }


    // --- Removed the old sequential loop ---

    console.log(`Processing complete.`);
    // Recalculate final counts from the data for accuracy, as increments might not be perfectly atomic across async tasks
    let finalSuccess = npmResultsData.packages.filter(p => p.processed === 3).length;
    let finalNotMcp = npmResultsData.packages.filter(p => p.processed === 1).length;
    let finalFailed = npmResultsData.packages.filter(p => p.processed === 2).length;
    let finalUnprocessed = npmResultsData.packages.filter(p => p.processed === 0).length; // Should be 0 if pool completed fully


    console.log(`Final Counts: Success=${finalSuccess}, NotMCP=${finalNotMcp}, Failed=${finalFailed}, Unprocessed=${finalUnprocessed}`);
    console.log(`Results saved in ${NpmResultsInputFile}`);
}

main().catch(err => {
    console.error("\nUnhandled error in main execution:", err);
    // Attempt to save final state even on unhandled error? Could be risky if data is corrupt.
    process.exit(1);
});