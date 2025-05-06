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
const NpmResultsInputFile = path.resolve(process.cwd(), '../npm_mcp_search_results2.json'); // Ensure absolute path
// const TempManifestFile = path.resolve(process.cwd(), 'temp_mcp_manifest.json'); // Ensure absolute path, potentially move to os.tmpdir()? <-- REMOVE THIS
const connectionTimeoutMs = 15000; // 15 seconds to connect and initialize
const requestTimeoutMs = 30000; // 30 seconds for list requests
const CliScriptPath = path.resolve(process.cwd(), './bin/mcp-cli.js'); // Corrected path relative to cli/ dir
const CONCURRENCY_LIMIT = 1; // Max concurrent introspection tasks <-- SET TO 1 FOR DEBUGGING

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
        console.error(`Warning: Errors occurred during concurrent processing: ${errors.map(e => e.message).join(', ')}`);
        // Decide if this should throw or just log
        // throw new Error(`Errors occurred during concurrent processing: ${errors.map(e => e.message).join(', ')}`);
    }
}

// --- Concurrency Helpers --- END

// Processed Status Codes:
// 0: Not processed
// 1: Processed, determined not an MCP server (e.g., connection/initial listTools failed, or other introspection issue)
// 2: Processed, introspection succeeded, but a subsequent step failed (e.g., manifest generation or API registration)
// 3: Processed, introspection and API registration successful

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
        // console.log(`Successfully updated results in ${filePath}`); // Reduced verbosity on save
    } catch (writeError) {
        console.error(`Error writing results to file ${filePath}: ${writeError.message}`);
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

    const capabilitiesArray = [];
    (results.tools || []).forEach(tool => {
        capabilitiesArray.push({
            name: tool.name,
            type: 'tool',
            description: tool.description || `${tool.name} tool`
        });
    });
    (results.resources || []).forEach(resource => {
        capabilitiesArray.push({
            name: resource.name,
            type: 'resource',
            description: resource.description || `${resource.name} resource`
        });
    });
    (results.prompts || []).forEach(prompt => {
        capabilitiesArray.push({
            name: prompt.name,
            type: 'prompt',
            description: prompt.description || `${prompt.name} prompt`
        });
    });

    if (capabilitiesArray.length === 0) {
         console.warn(`Warning: No capabilities found for ${packageName}. Manifest might be rejected if capabilities array cannot be empty.`);
    }

    const manifest = {
        name: results?.serverInfo?.name || packageName,
        description: results?.serverInfo?.description || `${packageName} MCP Server`,
        url: packageName, // Using package name as URL signals stdio transport usage
        protocol_version: "MCP/1.0", // Placeholder
        capabilities: capabilitiesArray,
        installation: { // Default installation assumes npx execution
            command: 'npx',
            args: ['-y', packageName],
            env: {},
        },
    };

    // Add optional fields if available from introspection
    if (results?.serverInfo?.auth) {
        manifest.auth = results.serverInfo.auth;
    }
    if (results?.serverInfo?.tags && Array.isArray(results.serverInfo.tags)) {
         manifest.tags = results.serverInfo.tags;
    }

    return manifest;
}


/**
 * Registers a manifest using the mcp-cli.js script.
 * @param {object} manifestJson - The manifest object to register.
 * @param {string} packageTempDir - The temporary directory for this package's manifest file.
 * @param {string} [apiUrl="https://mcpfinder.dev"] - The API URL for the MCP Finder registry.
 * @returns {Promise<{success: boolean, error?: string}>} - Object indicating success and optional error message.
 */
async function registerViaCli(manifestJson, packageTempDir, apiUrl = "https://mcpfinder.dev") {
    if (!manifestJson) {
         console.error("Registration skipped: Manifest JSON is null or undefined.");
         return { success: false, error: "Manifest JSON is null or undefined." };
    }
    if (!packageTempDir) {
        console.error("Registration skipped: packageTempDir is required for temporary manifest file.");
        return { success: false, error: "packageTempDir is missing for registerViaCli." };
    }

    const manifestString = JSON.stringify(manifestJson, null, 2);
    const tempFilePath = path.join(packageTempDir, 'temp_mcp_manifest.json'); // Use package-specific temp dir

    // console.log("--- Generated Manifest Content (for debugging validation) ---");
    // console.log(manifestString); // Disable verbose manifest logging unless needed
    // console.log("-------------------------------------------------------------");

    try {
        // console.log(`Writing temporary manifest to ${tempFilePath}...`); // Reduced verbosity
        await fs.writeFile(tempFilePath, manifestString);

        // Ensure apiUrl is properly escaped if it could contain special shell characters
        // For simple URLs like https://mcpfinder.dev, quotes are usually sufficient.
        const command = `node ${CliScriptPath} register ${tempFilePath} --api-url "${apiUrl}"`;
        console.log(`Executing CLI registration: node ${CliScriptPath} register ... --api-url "${apiUrl}"`);

        // Inherit environment for MCPFINDER_REGISTRY_SECRET
        const { stdout, stderr } = await execPromise(command, { env: process.env });

        // console.log('CLI stdout:', stdout); // Disable verbose stdout unless needed
        if (stderr) {
            console.error('CLI stderr:', stderr); // Log stderr for debugging failures
        }

        if (stdout.includes('Registration successful!')) {
            // console.log('Registration via CLI reported success.'); // Reduced verbosity
            return { success: true };
        } else {
            const errorMessage = 'Registration via CLI did not report success in stdout.';
            console.error(errorMessage);
            // Return potentially useful info from stdout/stderr in the error message
            return { success: false, error: `${errorMessage} | Stdout: ${stdout.substring(0, 200)} | Stderr: ${stderr.substring(0, 200)}`.trim() };
        }

    } catch (error) {
        const errorMessage = `Error executing CLI registration command: ${error.message}`;
        console.error(errorMessage);
        if (error.stdout) console.error('CLI stdout (on exec error):', error.stdout);
        if (error.stderr) console.error('CLI stderr (on exec error):', error.stderr);
        // Return potentially useful info from stdout/stderr in the error message
        return { success: false, error: `${errorMessage} | Stdout: ${error.stdout?.substring(0, 200) || ''} | Stderr: ${error.stderr?.substring(0, 200) || ''}`.trim() };
    } finally {
        try {
            await fs.unlink(tempFilePath);
            // console.log(`Deleted temporary manifest file: ${tempFilePath}`); // Reduced verbosity
        } catch (unlinkError) {
            // This is minor, don't let it mask the primary outcome
            console.warn(`Warning: Could not delete temporary manifest file ${tempFilePath}: ${unlinkError.message}`);
        }
    }
}


/**
 * Attempts to introspect a single server package.
 * @param {object} npmPackage - The package object from npm_mcp_search_results.json.
 * @returns {Promise<{status: 'SUCCESS'|'FAILURE'|'NOT_MCP', results: object}>} - Status and results object including potential error.
 */
async function introspectServer(npmPackage) {
    const packageName = npmPackage?.package?.name;
    if (!packageName) {
        return { status: 'FAILURE', results: { error: 'Invalid package data, missing name.' } };
    }

    console.error(`--- Introspecting ${packageName} ---`);
    let client = null;
    let transport = null;
    let stderrOutput = '';
    let tempDir = null;

    // Initialize results structure
    const results = {
        connectionParams: { command: 'npx', packageName, args: [], env: {} },
        serverInfo: null,
        capabilities: null,
        tools: [],
        resources: [],
        prompts: [],
        error: null, // Will hold the final error message for this stage
        tempDirUsed: null, // tempDirUsed will be added on success
    };

    try {
        // 1. Setup Temp Directory
        const tempDirPrefix = path.join(os.tmpdir(), `mcp-introspect-${packageName.replace(/[^a-zA-Z0-9]/g, '_')}-`);
        tempDir = await fs.mkdtemp(tempDirPrefix);
        // console.error(`Created temporary directory: ${tempDir}`);

        // 2. Create Transport
        const spawnArgs = ['-y', packageName]; // Use -y to auto-confirm npx install
        const transportEnv = { ...process.env };
        const defaultEnv = getDefaultEnvironment();
        const finalEnv = { ...transportEnv, ...defaultEnv };

        // console.error(`Attempting to launch '${packageName}' via npx...`);
        transport = new StdioClientTransport({
            command: 'npx',
            args: spawnArgs,
            env: finalEnv,
            stderr: 'pipe', // Capture stderr
            cwd: tempDir    // Run npx in the temp directory to avoid CWD conflicts
        });

        // 3. Attach Listeners (stderr, process exit/error)
        // MOVED: Listeners will be attached *after* successful connection,
        // as transport.process might not be available until transport.launch() is called by client.connect().
        // OLD LOGIC WAS HERE.

        // 4. Connect Client with Timeout
        client = new Client({ name: 'mcp-introspector', version: '1.0.0' });
        // console.error(`Connecting to ${packageName}...`);
        await timeoutPromise(
            connectionTimeoutMs,
            client.connect(transport),
            `Connection timeout (${connectionTimeoutMs}ms) for ${packageName}`
        );
        // console.error(`Connected to ${packageName}.`);

        // --- Attach Listeners POST-CONNECT ---
        // Now that client.connect has resolved, transport.process should be available.
        if (transport.process) {
            if (transport.process.stderr && typeof transport.process.stderr.on === 'function') {
                transport.process.stderr.on('data', (data) => { stderrOutput += data.toString(); });
                transport.process.stderr.on('error', (err) => { stderrOutput += `\n[STDERR_ERROR_POST_CONNECT: ${err.message}]`; });
            } else {
                console.warn(`[${packageName}] Warning: transport.process.stderr stream not available post-connect.`);
            }

            if (typeof transport.process.on === 'function') {
                transport.process.on('error', (err) => {
                    // This listener catches errors in the spawned process itself (e.g., 'ENOENT' if command not found, though npx handles that)
                    // It's different from MCP protocol errors.
                    stderrOutput += `\n[PROCESS_EVENT_ERROR_POST_CONNECT: ${err.message}]`;
                });
                transport.process.on('exit', (code, signal) => {
                    // Log unexpected exits if they happen while the client thinks it's connected or during operations.
                    // The client's close method or connection errors should ideally handle expected terminations.
                    stderrOutput += `\n[PROCESS_EVENT_EXIT_POST_CONNECT code=${code} signal=${signal}]`;
                    // Avoid flooding logs if this is a normal exit after client.close()
                    // if (!client || !client.isConnected || (client.isConnected && (code !== 0 && code !== null)) ) {
                    //     console.warn(`[${packageName}] Process exited post-connect (code=${code}, signal=${signal}). Stderr might contain info.`);
                    // }
                });
            } else {
                console.warn(`[${packageName}] Warning: transport.process.on function not available post-connect for error/exit listeners.`);
            }
        } else {
            console.warn(`[${packageName}] Warning: transport.process object not available post-connect. Cannot attach stderr or process event listeners.`);
        }
        // --- End of Listener Attachment ---

        // 5. Initial listTools Check (Primary MCP viability test)
        // console.error("Attempting initial listTools()...");
        try {
             const initialToolsResult = await timeoutPromise(
                 requestTimeoutMs,
                 client.listTools(),
                 `listTools timeout (${requestTimeoutMs}ms) for ${packageName}`
             );
             results.tools = initialToolsResult.tools || [];
             // console.error(`Initial listTools call succeeded. Found ${results.tools.length} tools.`);
        } catch (initialToolError) {
             // If listTools fails, assume it's not a viable/responsive MCP server
             results.error = `Failed initial listTools: ${initialToolError.message}`;
             // Throw specific error to be caught below and classified as NOT_MCP
             throw new Error('LIST_TOOLS_FAILED');
        }

        // 6. Capture ServerInfo & Capabilities (Best Effort)
        // console.error("Attempting to capture ServerInfo and Capabilities...");
        results.serverInfo = client.serverInfo;
        results.capabilities = client.serverCapabilities;
        // Log if info seems missing, but don't fail introspection for this
        // if (!results.serverInfo) console.warn(`Warning: ServerInfo was not available.`);
        // if (!results.capabilities) console.warn(`Warning: ServerCapabilities were not available.`);


        // 7. Further Introspection (Resources/Prompts) if advertised
        // console.error("Proceeding with further introspection (resources/prompts)...");
        if (results.capabilities?.resources) {
             try {
                 const resourcesResult = await timeoutPromise(requestTimeoutMs, client.listResources(), `listResources timeout for ${packageName}`);
                 results.resources = resourcesResult.resources || [];
                 // console.error(`Found ${results.resources.length} resources.`);
             } catch (resourceError) {
                 console.warn(`Warning: Error during listResources for ${packageName}: ${resourceError.message}`);
                 // Record the first error encountered during full introspection if none exists yet
                 if (!results.error) results.error = `Failed listResources: ${resourceError.message}`;
             }
         }
        if (results.capabilities?.prompts) {
             try {
                 const promptsResult = await timeoutPromise(requestTimeoutMs, client.listPrompts(), `listPrompts timeout for ${packageName}`);
                 results.prompts = promptsResult.prompts || [];
                 // console.error(`Found ${results.prompts.length} prompts.`);
             } catch (promptError) {
                 console.warn(`Warning: Error during listPrompts for ${packageName}: ${promptError.message}`);
                 if (!results.error) results.error = `Failed listPrompts: ${promptError.message}`;
             }
         }

        // 8. Success Path Cleanup
        // console.error(`--- Introspection SUCCESS for ${packageName} ---`);
        await client.close().catch(closeErr => console.error(`Error closing client on success path: ${closeErr.message}`));
        client = null; transport = null; // Clear refs
        results.tempDirUsed = tempDir; // Pass tempDir back to caller for its use and cleanup
        return { status: 'SUCCESS', results };

    } catch (error) {
        // 9. Error Handling Path
        const stderrSnippet = stderrOutput.substring(0, 500) + (stderrOutput.length > 500 ? '...' : '');
        // Store the primary error, appending stderr snippet
        results.error = results.error || error.message; // Keep listX error if it happened
        results.error += ` | Stderr: ${stderrSnippet}`;

        // Determine final status based on error type
        let finalStatus = 'FAILURE'; // Default to general failure

        if (error.message === 'LIST_TOOLS_FAILED' ||
            error.message.includes("timeout for") ||
            error.message.includes("closed before handshake") ||
            stderrOutput.includes('command not found') || // Look for execution failures in stderr
            stderrOutput.includes('Not found') ||
            stderrOutput.includes('Cannot find module') ||
            error.code === 'ENOENT')
        {
             // console.error(`[${packageName}] Classified as NOT_MCP due to error/stderr.`);
             finalStatus = 'NOT_MCP';
        } else {
             // console.error(`[${packageName}] Classified as FAILURE due to error.`);
             finalStatus = 'FAILURE'; // Unhandled/unexpected error during introspection steps
        }

        console.error(`--- Introspection ${finalStatus} for ${packageName} --- Error: ${results.error}`);

        // 10. Error Path Cleanup
        if (client && client.isConnected) {
             await client.close().catch(closeErr => console.error(`Error closing client during error handling: ${closeErr.message}`));
        } else if (transport?.process && !transport.process.killed) {
            // If client didn't connect/close but process might still be running
            transport.process.kill('SIGTERM');
        }
        client = null; transport = null; // Clear refs

        // Clean up tempDir on failure path within introspectServer
        if (tempDir) {
            try {
                await fs.rm(tempDir, { recursive: true, force: true });
                // console.error(`Cleaned up temp directory ${tempDir} due to introspection error.`);
            } catch (cleanupError) {
                console.warn(`Warning: Failed to remove temporary directory ${tempDir} during error handling: ${cleanupError.message}`);
            }
            // tempDir = null; // No need to nullify, it's local scope about to end
        }
        return { status: finalStatus, results };
    }
}

// --- Main Execution ---

async function main() {
    // 1. Check for required secret
    if (!process.env.MCPFINDER_REGISTRY_SECRET) {
        console.error('\nError: MCPFINDER_REGISTRY_SECRET environment variable is not set.');
        console.error('This secret is required to attempt registration of successfully introspected MCP servers.');
        console.error('Please set this environment variable and try running the script again.\n');
        process.exit(1);
    }

    // 2. Load and Validate Input File
    let npmResultsData;
    try {
        const fileContent = await fs.readFile(NpmResultsInputFile, 'utf-8');
        npmResultsData = JSON.parse(fileContent);
        if (!npmResultsData || !Array.isArray(npmResultsData.packages)) {
            throw new Error("Invalid input file format. Expected object with 'packages' array.");
        }
        console.log(`Loaded ${npmResultsData.packages.length} total packages from ${NpmResultsInputFile}`);
    } catch (readError) {
        console.error(`\nError processing input file ${NpmResultsInputFile}:`);
        if (readError.code === 'ENOENT') console.error('Reason: File not found.');
        else if (readError instanceof SyntaxError) console.error(`Reason: Could not parse JSON. Error: ${readError.message}`);
        else console.error(`Reason: Other read/parse error: ${readError.message}`);
        process.exit(1);
    }

    // 3. Filter Packages (Select only rhombus-node-mcp for focused debugging)
    const allPackages = npmResultsData.packages;
    const packagesToProcess = allPackages.filter(p => p.processed === 0);


    if (packagesToProcess.length > 0) {
        console.log(`Found ${packagesToProcess.length} unprocessed packages to process.`); // Less relevant when targeting one
    } else {
        console.log("No unprocessed packages found. Exiting.");
        return; // Exit cleanly if nothing to do
    }

    // 4. Setup for Processing Pool
    console.log(`Starting processing for ${packagesToProcess.length} package(s) with concurrency ${CONCURRENCY_LIMIT}...`);
    let processedCount = 0;
    let successCount = 0;      // Status 3
    let notMcpCount = 0;       // Status 1
    let failureCount = 0;      // Status 2
    const totalToProcess = packagesToProcess.length;
    const saveLock = new Lock(); // Prevent race conditions when saving file

    // 5. Define the Processing Function for Each Package
    const processPackage = async (npmPackage) => {
        // Find index in the *original* full list for saving results
        const originalIndex = allPackages.findIndex(p => p.package.name === npmPackage.package.name);
        const currentPackageNum = ++processedCount;
        const packageName = npmPackage?.package?.name || `unknown_package_at_original_index_${originalIndex}`;

        console.log(`\n[${currentPackageNum}/${totalToProcess}] Starting: ${packageName}`);

        // --- Introspection ---
        const { status: introspectionStatus, results: introspectionResults } = await introspectServer(npmPackage);
        const tempDirUsedByIntrospection = introspectionResults.tempDirUsed; // Path to temp dir if introspection was successful

        let finalStatus = 0; // Default: 0 (should always change)
        let introspectionErrorMsg = introspectionStatus !== 'SUCCESS' ? (introspectionResults.error || "Introspection failed/skipped") : null;
        let registrationErrorMsg = null; // Assume no registration error initially

        try {
            // --- Registration (only if introspection succeeded) ---
            if (introspectionStatus === 'SUCCESS') {
                console.log(`[${packageName}] Introspection Succeeded. Generating manifest...`);
                const manifest = generateManifest(introspectionResults);

                if (manifest) {
                    console.log(`[${packageName}] Manifest generated. Attempting registration...`);
                    if (!tempDirUsedByIntrospection) {
                        // This case should ideally not be reached if introspectionStatus is SUCCESS
                        // as tempDirUsed should have been set.
                        console.error(`[${packageName}] CRITICAL INTERNAL ERROR: Introspection SUCCESS but tempDirUsedByIntrospection is missing for registration.`);
                        registrationErrorMsg = "Internal error: tempDir missing for manifest after successful introspection.";
                        finalStatus = 2; // Introspection OK, Registration failed (due to internal error)
                        failureCount++;
                    } else {
                        const registrationResult = await registerViaCli(manifest, tempDirUsedByIntrospection); // Pass tempDir
                        if (registrationResult.success) {
                            console.log(`[${packageName}] Registration Succeeded.`);
                            finalStatus = 3; // Full success
                            successCount++;
                        } else {
                            registrationErrorMsg = registrationResult.error || "Registration API call failed.";
                            console.log(`[${packageName}] Registration FAILED. Error: ${registrationErrorMsg}`);
                            finalStatus = 2; // Introspection OK, Registration failed
                            failureCount++;
                        }
                    }
                } else {
                    // Manifest generation failed after successful introspection
                    introspectionErrorMsg = introspectionResults.error ? `${introspectionResults.error} | And manifest generation failed.` : "Manifest generation failed after successful introspection.";
                    console.log(`[${packageName}] Manifest Generation FAILED. Error: ${introspectionErrorMsg}`);
                    finalStatus = 2; // Count as failure if manifest cannot be generated
                    failureCount++;
                }
            } else if (introspectionStatus === 'NOT_MCP') {
                console.log(`[${packageName}] Introspection Result: NOT_MCP. Reason: ${introspectionErrorMsg}`);
                finalStatus = 1;
                notMcpCount++;
            } else { // FAILURE case from introspection
                console.log(`[${packageName}] Introspection Result: FAILURE. Reason: ${introspectionErrorMsg}`);
                finalStatus = 2; // General failure
                failureCount++;
            }
        } finally {
            // Clean up the temp directory that was used by introspectServer and passed to registerViaCli
            // This runs after registration attempt (success or fail) or if introspection wasn't SUCCESS.
            if (tempDirUsedByIntrospection) {
                try {
                    await fs.rm(tempDirUsedByIntrospection, { recursive: true, force: true });
                    // console.log(`[${packageName}] Cleaned up temp directory after processing: ${tempDirUsedByIntrospection}`);
                } catch (cleanupError) {
                    console.warn(`[${packageName}] Warning: Failed to clean up temp directory ${tempDirUsedByIntrospection} after processing: ${cleanupError.message}`);
                }
            }
        }

        // --- Save Results ---
        await saveLock.acquire();
        try {
            if (originalIndex !== -1) {
                const packageInGlobalArray = npmResultsData.packages[originalIndex];
                packageInGlobalArray.processed = finalStatus;

                // Set/clear error fields based on outcome
                packageInGlobalArray.introspectionError = introspectionErrorMsg; // Set to null if introspection succeeded
                packageInGlobalArray.registrationError = registrationErrorMsg;   // Set to null if registration succeeded or wasn't attempted

                // Clean up fields explicitly if they are null
                if (!packageInGlobalArray.introspectionError) delete packageInGlobalArray.introspectionError;
                if (!packageInGlobalArray.registrationError) delete packageInGlobalArray.registrationError;

            } else {
                // Should not happen if findIndex worked
                console.error(`Error: Could not find package ${packageName} in original list by name to update status.`);
           }

           npmResultsData.collectionTimestamp = new Date().toISOString();
           await saveResults(npmResultsData, NpmResultsInputFile); // Save the entire structure

           // --- Log Summary for this Package ---
           let statusReason = "Unknown";
           if (finalStatus === 1) statusReason = `Not MCP (${introspectionErrorMsg?.substring(0, 100)})`;
           else if (finalStatus === 2) {
               if (introspectionErrorMsg && !registrationErrorMsg) statusReason = `Introspection Problem (${introspectionErrorMsg.substring(0, 100)})`;
               else if (registrationErrorMsg) statusReason = `Registration Failed (${registrationErrorMsg.substring(0, 100)})`;
               else statusReason = "Processing Problem (Unknown)"; // Should have error detail
           }
           else if (finalStatus === 3) statusReason = "Success";

           console.log(`[${currentPackageNum}/${totalToProcess}] Saved: ${packageName} (Status: ${finalStatus} - ${statusReason})`);
           // console.log(`Current Counts: Success=${successCount}, NotMCP=${notMcpCount}, Failed=${failureCount}`); // Verbose counts per package

       } catch (saveErr) {
           console.error(`[${packageName}] CRITICAL: Failed to save results to ${NpmResultsInputFile}: ${saveErr.message}`);
       } finally {
           saveLock.release();
       }
   }; // End of processPackage async function

   // 6. Run the Processing Pool
   try {
       await asyncPool(CONCURRENCY_LIMIT, packagesToProcess, processPackage);
   } catch (poolError) {
       // Errors from within processPackage should ideally be caught there,
       // but catch potential pool-level errors.
       console.error(`\nError occurred during concurrent processing pool execution: ${poolError.message}`);
   }

   // 7. Final Summary Log
   console.log(`\nProcessing complete for the selected package(s).`);
   console.log(`Final Counts for this Run: Success=${successCount}, NotMCP=${notMcpCount}, Failed=${failureCount}, TotalProcessed=${processedCount}`);
   console.log(`Results saved in ${NpmResultsInputFile}`);
   // Note: Final counts only reflect packages processed *in this specific run*.
}

// --- Script Entry Point ---
main().catch(err => {
   console.error("\nUnhandled error in main execution:", err);
   process.exit(1);
});