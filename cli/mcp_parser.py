import json
import re
import requests # Make sure to install this: pip install requests
from urllib.parse import urlparse, urlunparse # Added urlunparse
from urlextract import URLExtract # Added for robust URL extraction
from bs4 import BeautifulSoup # Added for HTML to text conversion
import importlib

# --- Helper to robustly parse JSON, allowing comments via json5 if available ---

def _try_parse_json(json_str):
    """
    Attempt to parse a JSON string. First with the built-in json module, then
    after stripping line comments (// ...), and finally with json5 if the
    library is installed. Returns the parsed object on success or None on
    failure.
    """
    # First attempt: strict JSON
    try:
        return json.loads(json_str)
    except json.JSONDecodeError:
        pass

    # Second attempt: strip // line comments and /* */ block comments and retry
    no_comments = re.sub(r"//.*?$", "", json_str, flags=re.MULTILINE)
    no_comments = re.sub(r"/\*.*?\*/", "", no_comments, flags=re.DOTALL)
    # Remove standalone ellipsis lines or in-line ellipsis
    no_comments = re.sub(r"\.{3}", "", no_comments)
    # Remove trailing commas before } or ]
    no_comments = re.sub(r",\s*(\}|\])", r"\1", no_comments)

    try:
        return json.loads(no_comments)
    except json.JSONDecodeError:
        pass

    # Third attempt: use json5 if available
    json5_spec = importlib.util.find_spec("json5")
    if json5_spec is not None:
        json5 = importlib.import_module("json5")
        try:
            return json5.loads(json_str)
        except Exception:
            pass
    return None

def trim_data_recursively(data):
    """
    Recursively trims whitespace from string values and string keys in nested data structures.
    """
    if isinstance(data, dict):
        new_dict = {}
        for k, v in data.items():
            trimmed_key = k.strip() if isinstance(k, str) else k
            new_dict[trimmed_key] = trim_data_recursively(v)
        return new_dict
    elif isinstance(data, list):
        return [trim_data_recursively(item) for item in data]
    elif isinstance(data, str):
        return data.strip()
    else:
        return data

# --- Configuration ---
INPUT_URL_FILE = "mcp_urls.txt"
OUTPUT_JSON_FILE = "urls_mcp_servers.json"
REQUEST_TIMEOUT = 10 # seconds for HTTP requests
IGNORED_EXTENSIONS = {
    # Images
    ".ico", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg",
    # Stylesheets
    ".css",
    # Scripts
    ".js"
}
# ---

def _find_balanced_structure(text_content, start_char_idx, open_char, close_char):
    """
    Tries to find a balanced structure (e.g., JSON object or array) in text_content,
    beginning the search for open_char at or after start_char_idx.
    Returns the substring of the balanced structure, or None if not found or unbalanced.
    """
    # Find the first opening character at or after start_char_idx, skipping leading whitespace
    search_text = text_content[start_char_idx:]
    # We need to escape the open_char if it's a special regex character, e.g., '{', '['.
    # For simplicity here, assuming open_char is not a character that needs complex regex escaping beyond basic literal match.
    # A robust solution might use re.escape(open_char).
    match = re.search(r"\s*" + re.escape(open_char), search_text)
    if not match:
        return None # No open_char found
    
    # struct_open_idx is the index of open_char relative to the original text_content
    struct_open_idx = start_char_idx + search_text.find(open_char, match.start())

    counter = 0
    for i in range(struct_open_idx, len(text_content)):
        char = text_content[i]
        if char == open_char:
            counter += 1
        elif char == close_char:
            counter -= 1
            if counter == 0:
                return text_content[struct_open_idx : i + 1]
    return None

def parse_page_content_for_data(response):
    """
    Parses page content from HTTP response for mcpServers JSON or npx commands.
    Returns a dictionary with extracted data.
    """
    discovered_data = {}
    page_content = response.text
    content_type = response.headers.get('Content-Type', '').lower()

    # Attempt 1: Direct JSON parse (if content type is application/json)
    if 'application/json' in content_type:
        try:
            potential_json_data = json.loads(page_content)
            if (isinstance(potential_json_data, dict) and
                "mcpServers" in potential_json_data and
                isinstance(potential_json_data.get("mcpServers"), dict)):
                discovered_data.update(trim_data_recursively(potential_json_data["mcpServers"]))
                if discovered_data:
                    print("  Data found via Attempt 1 (direct JSON parse of mcpServers)")
                    return discovered_data
        except json.JSONDecodeError:
            print("  Content-Type was application/json but failed to parse as a whole or find mcpServers key directly.")
        # If Attempt 1 fails or doesn't find mcpServers, fall through

    # Attempt 1.5: Look for JSON in <script type="application/json"> tags
    if not discovered_data: # Only run if Attempt 1 didn't succeed
        try:
            soup_for_scripts = BeautifulSoup(page_content, "html.parser")
            script_tags = soup_for_scripts.find_all('script', type='application/json')
            if script_tags:
                print(f"  Attempt 1.5: Found {len(script_tags)} <script type=\"application/json\"> tag(s).")
            for tag_idx, script_tag in enumerate(script_tags):
                script_content = script_tag.string
                if script_content:
                    script_content_stripped = script_content.strip()
                    # print(f"  Attempt 1.5: Processing script #{tag_idx + 1}. Snippet: {script_content_stripped[:100]}...")
                    try:
                        parsed_script_json = json.loads(script_content_stripped)
                        # Log the parsed JSON before applying heuristics
                        print(f"  Log (Attempt 1.5): Successfully parsed JSON from <script> tag #{tag_idx + 1}. Content type: {type(parsed_script_json)}. Preview (first 200 chars): {str(parsed_script_json)[:200]}")
                        
                        if isinstance(parsed_script_json, dict):
                            # Heuristic 1: Direct "mcpServers" key
                            if "mcpServers" in parsed_script_json and isinstance(parsed_script_json.get("mcpServers"), dict):
                                discovered_data.update(trim_data_recursively(parsed_script_json["mcpServers"]))
                                print("  Data found via Attempt 1.5 (mcpServers in <script>)")
                                return discovered_data
                            # Heuristic 2: The entire script content IS the mcpServers object
                            # Check if all values in the dict are themselves dicts and look like server definitions
                            elif all(isinstance(val, dict) and (isinstance(val.get("command"), (str, list)) or isinstance(val.get("args"), list)) for val in parsed_script_json.values()):
                                discovered_data.update(trim_data_recursively(parsed_script_json))
                                print("  Data found via Attempt 1.5 (entire <script> is mcpServers-like object)")
                                return discovered_data
                    except json.JSONDecodeError as e_script:
                        print(f"  Warning (Attempt 1.5): Failed to parse JSON from <script> tag #{tag_idx + 1}. Error: {e_script}. Snippet: {script_content_stripped[:100]}...")
                    except Exception as e_generic_script:
                         # Simplified print statement to avoid potential f-string parsing issues with linter
                         print("  Warning (Attempt 1.5): Generic error processing script tag #" + str(tag_idx + 1) + ". Error: " + str(e_generic_script))
        except Exception as e_bs_script:
            print(f"  Warning (Attempt 1.5): BeautifulSoup parsing or script tag processing failed: {e_bs_script}")

    if discovered_data: # If Attempt 1.5 was successful
        return discovered_data

    # --- Attempts for HTML or other text-based content ---
    plain_text_content = None # Will be populated if we parse HTML

    # Attempt 2a: JSON in Markdown-style code blocks (```json ... ```)
    # This is tried before full HTML stripping for potentially cleaner JSON extraction.
    json_code_block_pattern = r"```json\s*\n(.*?)\n\s*```"
    for match in re.finditer(json_code_block_pattern, page_content, re.DOTALL):
        json_block_content = match.group(1).strip()
        try:
            parsed_json_from_block = json.loads(json_block_content)
            if isinstance(parsed_json_from_block, dict):
                # Check if this block itself is the mcpServers object or contains it
                if "mcpServers" in parsed_json_from_block and isinstance(parsed_json_from_block.get("mcpServers"), dict):
                    discovered_data.update(trim_data_recursively(parsed_json_from_block["mcpServers"]))
                    print("  Data found via Attempt 2a (mcpServers within ```json block)")
                    return discovered_data # Prioritize this find
                elif all(isinstance(val, dict) and "command" in val for val in parsed_json_from_block.values()):
                    # Heuristic: If all top-level values look like server definitions (e.g. the block *is* the mcpServers content)
                    is_potential_mcp_servers_object = True
                    for key_check in parsed_json_from_block.keys():
                        if not isinstance(parsed_json_from_block[key_check].get("command"), (str, list)) and not isinstance(parsed_json_from_block[key_check].get("args"), list):
                            is_potential_mcp_servers_object = False; break
                    if is_potential_mcp_servers_object:
                        discovered_data.update(trim_data_recursively(parsed_json_from_block))
                        print("  Data found via Attempt 2a (entire ```json block is mcpServers like)")
                        return discovered_data # Prioritize this find
        except json.JSONDecodeError:
            print(f"  Warning (Attempt 2a): Found a ```json block that failed to parse: {json_block_content[:100]}...")
            continue # Try next json block if current one fails
    
    if discovered_data: # If 2a was successful
        return discovered_data

    # Prepare plain_text using BeautifulSoup for subsequent attempts if not already an application/json type handled by Attempt 1
    if 'application/json' not in content_type:
        try:
            soup = BeautifulSoup(page_content, "html.parser")
            plain_text_content = soup.get_text(separator=" ")
        except Exception as e:
            print(f"  Warning: BeautifulSoup failed to parse HTML: {e}. Falling back to raw page_content for attempts 2b/3.")
            plain_text_content = page_content # Fallback to raw content if BS fails
    else:
        # If it was application/json but Attempt 1 (and 1.5) didn't return,
        # it means it wasn't the specific mcpServers structure we wanted.
        # For Attempts 2b/3 on such a file, treat the original page_content as plain_text.
        plain_text_content = page_content

    if not plain_text_content and page_content: # Ensure plain_text_content is at least page_content if it's somehow None
        plain_text_content = page_content
        
    # User requested debug output for plain_text_content
    # if plain_text_content:
    #     print(f"  DEBUG: Plain text content for further parsing (first 500 chars):\\n'''{plain_text_content[:500].replace("'''", "\\\'\'\'")}'''\\n")
    # else:
    #     print(f"  DEBUG: plain_text_content is None or empty. page_content (first 200 chars): '''{page_content[:200].replace("'''", "\\\'\'\'")}'''")

    # Attempt 2b: Find "mcpServers" key in plain_text_content (derived from HTML or original if non-HTML)
    mcp_servers_key_str = '"mcpServers"'
    current_search_idx = 0
    while True:
        key_occurrence_idx = plain_text_content.find(mcp_servers_key_str, current_search_idx)
        if key_occurrence_idx == -1:
            break
        after_key_str_idx = key_occurrence_idx + len(mcp_servers_key_str)
        colon_match = re.search(r"\s*:", plain_text_content[after_key_str_idx:])
        if not colon_match:
            current_search_idx = after_key_str_idx
            continue
        start_of_value_idx = after_key_str_idx + colon_match.end()
        json_object_str = _find_balanced_structure(plain_text_content, start_of_value_idx, '{', '}')
        if json_object_str:
            # print(f"  Log (Attempt 2b): Potential JSON string found by _find_balanced_structure (full): {json_object_str}") # Log full string
            parsed_mcp_servers_obj = _try_parse_json(json_object_str)
            if parsed_mcp_servers_obj is not None:
                if isinstance(parsed_mcp_servers_obj, dict):
                    discovered_data.update(trim_data_recursively(parsed_mcp_servers_obj))
                    if discovered_data:
                        print("  Data found via Attempt 2b (mcpServers JSON in plain text)")
                        return discovered_data
            else:
                print(f"  Warning (Attempt 2b): Found potential mcpServers in plain text that failed to parse: {json_object_str[:100]}...")
        current_search_idx = after_key_str_idx
    
    if discovered_data: # If 2b was successful
        return discovered_data

    # Attempt 3: Search for npx command phrase in plain_text_content
    npx_command_pattern = r'npx\s+-y\s+([@\w.-]+(?:/[@\w.-]+)?)\s+(?:mcp\s+)?([^\n\r<]+)' # Made mcp optional and allowed '@'
    matches = list(re.finditer(npx_command_pattern, plain_text_content))
    if not matches:
        print("  DEBUG: NPX regex found 0 matches in Attempt 3 for this page.")
    else:
        print(f"  DEBUG: NPX regex matched {len(matches)} command(s).")
    
    npx_found_on_page = False
    for command_match in matches:
        package_name = command_match.group(1).strip() # Group 1 is package
        api_or_argument_part = command_match.group(2).strip() # Group 2 is the rest
        print(f"  DEBUG (Attempt 3): Raw package_name: '{command_match.group(1)}', api_or_arg: '{command_match.group(2)}'")
        
        # Clean trailing punctuation from the api_or_argument_part
        api_or_argument_part = re.sub(r'[.,;!?()*\'"]+$', '', api_or_argument_part).strip()
        
        command_parts_list = ["npx", "-y", package_name, "mcp", api_or_argument_part]
        
        # Overwrite if same package_name found again; last one wins for npx for simplicity.
        # The package_name (key) and all parts in command_parts_list (values) are trimmed.
        discovered_data[package_name.strip()] = trim_data_recursively(command_parts_list)
        npx_found_on_page = True
    
    if npx_found_on_page:
        print(f"  Data found via Attempt 3 (npx command(s)): {list(discovered_data.keys())}")
        # If npx was found, and previous attempts for mcpServers JSON failed, return npx data.
        return discovered_data

    return discovered_data # Return empty if nothing found by any attempt

def extract_urls_from_text_file(file_path_urls):
    # This function is currently bypassed by hardcoding in main()
    urls_found = []
    try:
        with open(file_path_urls, 'r', encoding='utf-8') as f:
            file_content = f.read()
        extractor = URLExtract()
        potential_urls_raw = extractor.find_urls(file_content)
        filtered_urls = []
        for url_str in potential_urls_raw:
            try:
                parsed_url = urlparse(url_str)
                path_lower = parsed_url.path.lower()
                if not any(path_lower.endswith(ext) for ext in IGNORED_EXTENSIONS):
                    filtered_urls.append(url_str)
                else:
                    print(f"  Ignoring URL (extension): {url_str}")
            except Exception as e:
                print(f"  Could not parse or check extension for URL '{url_str}': {e}. Including it.")
                filtered_urls.append(url_str)
        urls_found = list(set(filtered_urls)) # Keep unique URLs
    except FileNotFoundError:
        print(f"Error: Input URL file not found at '{file_path_urls}'")
    except Exception as e:
        print(f"Error reading URL file '{file_path_urls}': {e}")
    return urls_found

def main():
    # url_extractor = URLExtract() # No longer needed here as we use a fixed list

    # Instead of reading from INPUT_URL_FILE, we use a hardcoded list for now
    urls_to_check = [
        "https://github.com/search?q=mcpServers",
        "https://www.google.com/search?q=mcpServers+json",
        "https://raw.githubusercontent.com/langchain-ai/langchain/master/pyproject.toml", # Example of a raw file
        "https://example.com/nonexistent.json", # Example of a 404
        "https://github.com/danswer-ai/danswer/blob/main/backend/pyproject.toml", # Toml
        "https://pypi.org/project/dbt-core/", # PyPi page
        "https://www.npmjs.com/package/prettier", # NPM page
        "https://github.com/features/copilot", # Github feature page
        "https://raw.githubusercontent.com/YagizV/mcp-server-runner/main/servers/gliner_v0.1.5_mcp_server.json",
        "https://gist.github.com/YagizV/7f4a67b2461df3d488cc1f0b889dcb09", # Gist example
        "https://glama.zip/tools/servers.json",
        "https://raw.githubusercontent.com/YagizV/mcp-server-runner/main/servers/gliner_v0.1.5_mcp_server.json"
    ]
    
    # Ensure OUTPUT_JSON_FILE is initialized as an empty list in a JSON array if it doesn't exist or is empty/invalid
    # This will hold a list of dictionaries, where each dictionary is an entry from an mcpServers object
    # or an npx command.
    # We will now load it at the start and append to it.
    
    all_mcp_servers_list = [] # This will store all individual server entries

    try:
        with open(OUTPUT_JSON_FILE, 'r') as f:
            content = f.read()
            if content.strip(): # Check if file is not empty
                try:
                    all_mcp_servers_list = json.loads(content)
                    if not isinstance(all_mcp_servers_list, list):
                        print(f"Warning: {OUTPUT_JSON_FILE} does not contain a JSON list. Initializing as empty list.")
                        all_mcp_servers_list = []
                except json.JSONDecodeError:
                    print(f"Warning: {OUTPUT_JSON_FILE} contains invalid JSON. Initializing as empty list.")
                    all_mcp_servers_list = []
            else: # File is empty
                 all_mcp_servers_list = []
    except FileNotFoundError:
        # If the file doesn't exist, it's fine, we start with an empty list.
        all_mcp_servers_list = []


    processed_urls = set() # To keep track of URLs we've already successfully processed and added
    # Load previously processed URLs from the existing data if possible
    # This assumes each item in all_mcp_servers_list has a 'source_url' key
    for item in all_mcp_servers_list:
        if isinstance(item, dict) and "source_url" in item:
            processed_urls.add(item["source_url"])

    urls_checked_count = 0
    positive_imports_count = 0 # This will count URLs that yield at least one server/npx entry

    print(f"Starting processing. Initial items in {OUTPUT_JSON_FILE}: {len(all_mcp_servers_list)}")

    for url in urls_to_check:
        if url in processed_urls:
            print(f"Skipping already processed URL: {url}")
            continue

        urls_checked_count += 1
        print(f"Processing URL ({urls_checked_count}/{len(urls_to_check)}): {url}")
        
        current_url_extracted_data_count = 0 # To check if this URL yielded any new data

        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
            response = requests.get(url, timeout=REQUEST_TIMEOUT, headers=headers, allow_redirects=True)
            response.raise_for_status() # Raises an exception for 4XX/5XX errors
            
            # print(f"  Status: {response.status_code}, Content-Type: {response.headers.get('Content-Type', 'N/A')}")
            # page_content = response.text # Store for potential later use if needed, but avoid printing large chunks
            # print(f"  Raw content snippet (first 200): {page_content[:200]}") # Removed as requested

            extracted_data_for_url = parse_page_content_for_data(response) # This returns a dict of servers or npx commands

            if extracted_data_for_url:
                print(f"  Successfully extracted data from {url}")
                new_items_added_for_this_url = 0
                for key, value in extracted_data_for_url.items():
                    # Ensure the value is a dictionary (server definition or npx command info)
                    if isinstance(value, dict):
                        # Create a new dictionary for each server/npx entry
                        # This ensures we don't modify the source `value` if it's referenced elsewhere
                        item_to_add = value.copy() 
                        item_to_add["id"] = key # The server name or generated npx id
                        item_to_add["source_url"] = url # Add source URL for tracking
                        
                        # Basic duplicate check based on id and source_url (or more comprehensive if needed)
                        is_duplicate = False
                        for existing_item in all_mcp_servers_list:
                            if existing_item.get("id") == item_to_add.get("id") and \
                               existing_item.get("source_url") == item_to_add.get("source_url"):
                                # A more robust check might compare more fields if 'id' is not unique enough across different URLs
                                is_duplicate = True
                                break
                        
                        if not is_duplicate:
                            all_mcp_servers_list.append(item_to_add)
                            new_items_added_for_this_url +=1
                            current_url_extracted_data_count +=1
                        else:
                            print(f"    Duplicate item '{key}' from {url} not added.")
                
                if new_items_added_for_this_url > 0:
                    positive_imports_count += 1 # Count this URL as a positive import
                    processed_urls.add(url) # Mark as processed only if new data was added

                # Update JSON file after processing each URL if new data was added
                if new_items_added_for_this_url > 0:
                    try:
                        with open(OUTPUT_JSON_FILE, 'w') as f:
                            json.dump(all_mcp_servers_list, f, indent=4)
                        print(f"  {OUTPUT_JSON_FILE} updated with {new_items_added_for_this_url} new item(s) from {url}. Total items: {len(all_mcp_servers_list)}")
                    except IOError as e:
                        print(f"Error writing to {OUTPUT_JSON_FILE}: {e}")
            else:
                print(f"  No relevant data found or extracted from {url}")

        except requests.exceptions.Timeout:
            print(f"  Request timed out for {url}")
        except requests.exceptions.RequestException as e:
            print(f"  Request failed for {url}: {e}")
        except Exception as e:
            print(f"  An unexpected error occurred processing {url}: {e}")

        print(f"Progress: URLs checked: {urls_checked_count}, Positive imports (URLs with new data): {positive_imports_count}")
        print("-" * 30)


    print("\\nFinal processing complete.")
    print(f"Total URLs checked: {urls_checked_count}")
    print(f"Total positive imports (URLs that yielded new data): {positive_imports_count}")
    print(f"Total unique items in {OUTPUT_JSON_FILE}: {len(all_mcp_servers_list)}")

if __name__ == "__main__":
    main() 