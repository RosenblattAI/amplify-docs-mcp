#!/usr/bin/env node

import { search } from "@buger/probe";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { SearchCache } from "./cache.js";
import { loadConfig } from "./config.js";
import { setupGitRepo } from "./git.js";

// Get the package.json to determine the version
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.resolve(__dirname, "..", "package.json");

// Get version from package.json
let packageVersion = "0.1.0";
try {
  if (fs.existsSync(packageJsonPath)) {
    console.log(`Found package.json at: ${packageJsonPath}`);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    if (packageJson.version) {
      packageVersion = packageJson.version;
      console.log(`Using version from package.json: ${packageVersion}`);
    }
  }
} catch (error) {
  console.error(`Error reading package.json:`, error);
}

// Load configuration (handles defaults, file, env, args precedence)
const config = loadConfig();

// Ensure the data directory exists (might be empty initially)
try {
  fs.ensureDirSync(config.dataDir);
  console.log(`Ensured data directory exists: ${config.dataDir}`);
} catch (err) {
  console.error(
    `Failed to ensure data directory exists: ${config.dataDir}`,
    err
  );
  process.exit(1);
}

// Auto-update timer
let updateTimer = null;

class AmplifyDocsMcpServer {
  constructor() {
    /**
     * @type {Server}
     * @private
     */
    this.server = new Server(
      {
        name: "amplify-docs-mcp",
        version: packageVersion,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      if (updateTimer) clearTimeout(updateTimer);
      await this.server.close();
      process.exit(0);
    });

    this.cache = new SearchCache(path.join(config.dataDir, ".cache"));
  }

  /**
   * Set up the tool handlers for the MCP server
   * @private
   */
  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: config.toolName,
          description: config.toolDescription,
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  'Elasticsearch query string. Focus on keywords and use ES syntax (e.g., "install AND guide", "configure OR setup", "api NOT internal").',
              },
              page: {
                type: "number",
                description:
                  "Optional page number for pagination of results (e.g., 1, 2, 3...). Default is 1.",
                default: 1,
              },
            },
            required: ["query"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Check against the configured tool name
      if (request.params.name !== config.toolName) {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}. Expected: ${config.toolName}`
        );
      }

      try {
        // Log the incoming request for debugging
        console.log(`Received request for tool: ${request.params.name}`);
        console.log(
          `Request arguments: ${JSON.stringify(request.params.arguments)}`
        );

        // Ensure arguments is an object
        if (
          !request.params.arguments ||
          typeof request.params.arguments !== "object"
        ) {
          throw new Error("Arguments must be an object");
        }

        const args = request.params.arguments;

        // Validate required fields
        if (!args.query) {
          throw new Error("Query is required in arguments");
        }

        const result = await this.executeDocsSearch(args);

        return {
          content: [
            {
              type: "text",
              text: result,
            },
          ],
        };
      } catch (error) {
        console.error(`Error executing ${request.params.name}:`, error);
        return {
          content: [
            {
              type: "text",
              text: `Error executing ${request.params.name}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Execute a documentation search
   * @param {Object} args - Search arguments
   * @returns {Promise<string>} Search results
   * @private
   */
  async executeDocsSearch(args) {
    try {
      // Always use the configured data directory
      const searchPath = config.dataDir;

      // Get pagination parameters
      const page = args.page || 1;
      const pageSize = 25000; // Maximum tokens per page
      const skipTokens = (page - 1) * pageSize;

      // Process the query for advanced search features
      const processedQuery = this.processAdvancedQuery(args.query);

      // Create a minimal options object - disable all custom ranking to avoid errors
      const options = {
        path: searchPath,
        query: processedQuery,
        maxTokens: pageSize,
        skipTokens: skipTokens,
      };

      console.log("Using default search with no custom ranking function");

      console.log(
        "Executing search with options:",
        JSON.stringify(options, null, 2)
      );

      // Check cache first
      const cachedResults = await this.cache.get(processedQuery, options);
      if (cachedResults) {
        console.log("Returning cached results");
        return this.formatResults(cachedResults, args);
      }

      // Call search with the options object
      const result = await search(options);
      console.log("Search results type:", typeof result);

      // Cache the results
      await this.cache.set(processedQuery, options, result);

      // Format the results
      return this.formatResults(result, args);
    } catch (error) {
      console.error("Error executing docs search:", error);
      throw new McpError(
        ErrorCode.InternalError,
        `Error executing docs search: ${error.message || String(error)}`
      );
    }
  }

  /**
   * Format search results for display
   * @param {string} results - Search results
   * @param {Object} args - Search arguments
   * @returns {string} Formatted results
   */
  formatResults(results, args) {
    try {
      // Convert results to string if it's not already
      const resultStr = results.toString();

      // Extract key information
      const matchCount = resultStr.match(/Found (\d+) search results/);
      const bytesReturned = resultStr.match(/Total bytes returned: (\d+)/);
      const tokensReturned = resultStr.match(/Total tokens returned: (\d+)/);
      const skippedFiles = resultStr.match(
        /Skipped files due to limits: (\d+)/
      );

      // Format results in a more user-friendly way
      let finalResult = "Search Results Summary:\n";
      finalResult += `- Query: "${args.query}"\n`;
      finalResult += `- Matches found: ${
        matchCount ? matchCount[1] : "unknown"
      }\n`;
      finalResult += `- Bytes returned: ${
        bytesReturned ? bytesReturned[1] : "unknown"
      }\n`;
      finalResult += `- Tokens returned: ${
        tokensReturned ? tokensReturned[1] : "unknown"
      }\n`;

      if (skippedFiles) {
        finalResult += `- Skipped files: ${skippedFiles[1]}\n`;
        finalResult += `- Pagination available: ${
          parseInt(skippedFiles[1]) > 0 ? "Yes" : "No"
        }\n`;
      }

      // Add search tips
      finalResult += "\nSearch Tips:\n";
      finalResult += '- Use quotes for exact phrases: "authentication flow"\n';
      finalResult += "- Exclude terms with minus: authentication -flutter\n";
      finalResult += "- Use field-specific search: title:authentication\n";
      finalResult += "- Use wildcards: auth*\n";
      finalResult +=
        "- Use boolean operators: authentication AND (react OR javascript) NOT flutter\n";

      // Extract file matches
      const fileMatches = resultStr.match(/File: ([^\n]+)/g);
      if (fileMatches) {
        finalResult += `\nFound ${fileMatches.length} file matches.\n`;
        finalResult += "First 10 matches:\n";

        // Show first 10 matches
        for (let i = 0; i < Math.min(10, fileMatches.length); i++) {
          finalResult += `${i + 1}. ${fileMatches[i].replace("File: ", "")}\n`;
        }

        if (fileMatches.length > 10) {
          finalResult += `... and ${fileMatches.length - 10} more files\n`;
        }

        // Add pagination information
        const page = args.page || 1;
        if (skippedFiles && parseInt(skippedFiles[1]) > 0) {
          finalResult += `\nTo see more results, use: search_amplify_docs(query: "${
            args.query
          }", page: ${page + 1})\n`;
        }

        finalResult +=
          "\nTo see the full content of the search results, try refining your search query.\n";
      } else {
        finalResult += "\nNo file matches found.\n";
      }

      return finalResult;
    } catch (error) {
      console.error("Error formatting results:", error);
      return `Error formatting results: ${error.message}\n\nRaw results:\n${results}`;
    }
  }

  /**
   * Process advanced query syntax
   * @param {string} query - The original query
   * @returns {string} - Processed query
   * @private
   */
  processAdvancedQuery(query) {
    // Already supports:
    // - Boolean operators: AND, OR, NOT
    // - Grouping with parentheses: (term1 OR term2)
    // - Field-specific search: title:term

    // No additional processing needed as the underlying search engine
    // already supports these advanced features
    return query;
  }

  async run() {
    try {
      console.log("Starting Amplify Docs MCP server...");
      console.log(`Using data directory: ${config.dataDir}`);
      console.log(`MCP Tool Name: ${config.toolName}`);
      console.log(`MCP Tool Description: ${config.toolDescription}`);

      if (config.gitUrl) {
        console.log(
          `Using Git repository: ${config.gitUrl} (ref: ${config.gitRef})`
        );
        console.log(
          `Auto-update interval: ${config.autoUpdateInterval} minutes`
        );

        // Initialize Git repository if needed
        await setupGitRepo(config);

        // Schedule auto-updates if enabled
        if (config.autoUpdateInterval > 0) {
          updateTimer = setInterval(() => {
            setupGitRepo(config, true);
          }, config.autoUpdateInterval * 60 * 1000);
        }
      }

      // Connect the server to the transport
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.log("Amplify Docs MCP server running on stdio");
    } catch (error) {
      console.error("Error starting server:", error);
      process.exit(1);
    }
  }
}

const server = new AmplifyDocsMcpServer();
server.run().catch(console.error);
