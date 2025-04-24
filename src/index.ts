#!/usr/bin/env node

import { search } from "@buger/probe";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequest,
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
import { DirectoryManager } from "./directory.js";
import { setupGitRepo } from "./git.js";

// Define interfaces for MCP types and search functionality
interface HeadingInfo {
  path: string;
  heading: string;
  level: number;
  content: string;
}

interface HeadingIndex {
  [keyword: string]: HeadingInfo[];
}

interface SessionCache {
  headingIndex: HeadingIndex;
  lastUpdated: number;
}

interface ListToolsResponse {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: {
      type: "object";
      properties?: { [key: string]: unknown };
      required?: string[];
    };
  }>;
  [key: string]: unknown; // Index signature for additional properties
}

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
let updateTimer: NodeJS.Timeout | null = null;

// Define the search arguments interface
interface SearchArgs {
  query: string;
  page?: number;
  includeContent?: boolean;
  maxResults?: number;
  filesOnly?: boolean;
  useJson?: boolean;
  sessionId?: string;
  fullContent?: boolean;
  filePath?: string;
}

class AmplifyDocsMcpServer {
  private server: Server;
  private cache: SearchCache;
  private sessionCaches: Map<string, SessionCache> = new Map();
  private probeSessionCache: { [key: string]: any } = {};
  private headingIndex: HeadingIndex = {};
  private lastHeadingIndexUpdate: number = 0;
  private directoryManager: DirectoryManager;

  constructor() {
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

    // Initialize the directory manager
    this.directoryManager = new DirectoryManager(config.dataDir);
  }

  /**
   * Set up the tool handlers for the MCP server
   * @private
   */
  private setupToolHandlers(): void {
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async (): Promise<ListToolsResponse> => ({
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
                includeContent: {
                  type: "boolean",
                  description:
                    "Include content snippets in the results. Default is false.",
                  default: false,
                },
                maxResults: {
                  type: "number",
                  description:
                    "Maximum number of results to return. Default is 10.",
                  default: 10,
                },
                filesOnly: {
                  type: "boolean",
                  description:
                    "Only return file paths without content. Useful for initial broad searches. Default is false.",
                  default: false,
                },
                useJson: {
                  type: "boolean",
                  description:
                    "Return results in JSON format for programmatic processing. Default is false.",
                  default: false,
                },
                sessionId: {
                  type: "string",
                  description:
                    "Session ID for related searches to avoid duplicate results. Use the same ID for related searches.",
                },
                fullContent: {
                  type: "boolean",
                  description:
                    "Get full content of a specific file. Use with filePath parameter. Default is false.",
                  default: false,
                },
                filePath: {
                  type: "string",
                  description:
                    "Path to a specific file to get full content. Use with fullContent parameter.",
                },
              },
              required: ["query"],
            },
          },
        ],
      })
    );

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: CallToolRequest) => {
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

          // Cast to unknown first, then to SearchArgs
          const args = request.params.arguments as unknown as SearchArgs;

          // Validate required fields
          if (!args || !args.query) {
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
      }
    );
  }

  /**
   * Execute a documentation search
   * @param {SearchArgs} args - Search arguments
   * @returns {Promise<string>} Search results
   * @private
   */
  private async executeDocsSearch(args: SearchArgs): Promise<string> {
    try {
      // Check if we're getting full content of a specific file
      if (args.fullContent && args.filePath) {
        console.log(`Getting full content of file: ${args.filePath}`);
        try {
          if (!fs.existsSync(args.filePath)) {
            return `File not found: ${args.filePath}`;
          }

          const fileContent = await fs.readFile(args.filePath, "utf-8");

          // Format the result
          let result = `Full content of file: ${args.filePath}\n\n`;
          result += "```\n";
          result += fileContent;
          result += "\n```\n";

          return result;
        } catch (error) {
          console.error(`Error reading file ${args.filePath}:`, error);
          return `Error reading file ${args.filePath}: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }

      // Find relevant headings for the query
      if (args.sessionId) {
        console.log(`Finding relevant headings for query: ${args.query}`);
        try {
          const relevantHeadings = await this.findRelevantHeadings(
            args.query,
            args.sessionId
          );

          if (relevantHeadings.length > 0) {
            console.log(`Found ${relevantHeadings.length} relevant headings`);

            // Add heading information to the search results
            let headingResults = `# Relevant Headings for "${args.query}"\n\n`;

            // Group headings by file
            const headingsByFile: { [key: string]: HeadingInfo[] } = {};
            for (const heading of relevantHeadings) {
              if (!headingsByFile[heading.path]) {
                headingsByFile[heading.path] = [];
              }
              headingsByFile[heading.path].push(heading);
            }

            // Sort headings by level within each file
            for (const filePath in headingsByFile) {
              headingsByFile[filePath].sort((a, b) => a.level - b.level);
            }

            // Format the results
            for (const filePath in headingsByFile) {
              const fileHeadings = headingsByFile[filePath];
              const relativePath = filePath.replace(config.dataDir, "");

              headingResults += `## File: ${relativePath}\n\n`;

              for (const heading of fileHeadings) {
                const headingPrefix = "#".repeat(heading.level);
                headingResults += `${headingPrefix} ${heading.heading}\n\n`;

                // Include a snippet of the content
                const contentSnippet =
                  heading.content.length > 200
                    ? heading.content.substring(0, 200) + "..."
                    : heading.content;

                headingResults += `${contentSnippet}\n\n`;
              }
            }

            // If we're only looking for headings, return the results
            if (args.filesOnly) {
              return headingResults;
            }

            // Otherwise, continue with the regular search
          }
        } catch (error) {
          console.error(`Error finding relevant headings:`, error);
          // Continue with regular search
        }
      }

      // Always use the configured data directory
      let searchPath = config.dataDir;

      // Get pagination parameters
      const page = args.page || 1;
      const pageSize = 25000; // Maximum tokens per page
      const skipTokens = (page - 1) * pageSize;

      // Process the query for advanced search features
      const processedQuery = this.processAdvancedQuery(args.query);

      // Create options object with ranking
      const options: any = {
        path: searchPath,
        query: processedQuery,
        maxTokens: pageSize,
        skipTokens: skipTokens,
        maxResults: args.maxResults || 10,
      };

      // Use directory structure to optimize search if available
      if (this.directoryManager && this.directoryManager.getDirectory()) {
        console.log("Using directory structure to optimize search");

        // Check if the query mentions a specific generation
        const queryLower = args.query.toLowerCase();
        const mentionsGen1 =
          queryLower.includes("gen1") || queryLower.includes("gen 1");
        const mentionsGen2 =
          queryLower.includes("gen2") || queryLower.includes("gen 2");

        // Determine which generation to search
        let generation = "both";
        if (mentionsGen1 && !mentionsGen2) {
          generation = "gen1";
          console.log("Query mentions Gen1, searching only Gen1 documentation");
        } else if (mentionsGen2 && !mentionsGen1) {
          generation = "gen2";
          console.log("Query mentions Gen2, searching only Gen2 documentation");
        } else if (config.amplifyGeneration !== "both") {
          generation = config.amplifyGeneration;
          console.log(`Using configured generation: ${generation}`);
        }

        // Get matching paths from the directory structure
        const matchingPaths = this.directoryManager.getMatchingPaths(
          args.query,
          generation
        );
        if (matchingPaths.length > 0) {
          console.log(
            `Found ${matchingPaths.length} matching paths in directory structure`
          );

          // Instead of creating symlinks, we'll create a filter function
          // to pass to the search function that checks if a file path
          // matches any of our matching paths
          console.log("Creating path filter function for search");

          // Create a set of matching paths for faster lookup
          const matchingPathsSet = new Set(matchingPaths);

          // Create a filter function
          const filterFunction = (filePath: string): boolean => {
            // Check if the file path matches any of our matching paths
            for (const matchingPath of matchingPathsSet) {
              if (filePath.includes(matchingPath)) {
                return true;
              }
            }
            return false;
          };

          // Store the filter function to use later
          options.filterFunction = filterFunction;
        }
      }

      // Add ranking options to the options object
      options.rankingFunction = (
        a: { path: string; matchCount: number },
        b: { path: string; matchCount: number }
      ) => {
        // Helper function to determine if a path is from the main platform documentation
        const isMainPlatformDoc = (path: string): boolean => {
          const lowerPath = path.toLowerCase();
          // Main platform patterns (highest priority)
          return lowerPath.includes("/src/pages/[platform]/");
        };

        // Helper function to determine if a path contains project setup information
        const isSetupDoc = (path: string): boolean => {
          const lowerPath = path.toLowerCase();
          // Setup documentation patterns
          return (
            lowerPath.includes("/start/") ||
            lowerPath.includes("/getting-started/") ||
            lowerPath.includes("/setup/") ||
            lowerPath.includes("/installation/") ||
            lowerPath.includes("/quickstart/") ||
            lowerPath.includes("/project-setup/") ||
            lowerPath.includes("/prerequisites/") ||
            lowerPath.includes("/init/") ||
            lowerPath.includes("/create-new-app/")
          );
        };

        // Helper function to identify Gen 2 CLI command documentation
        const isGen2CliDoc = (path: string): boolean => {
          const lowerPath = path.toLowerCase();
          return lowerPath.includes("[platform]/reference/cli-commands/");
        };

        // Helper function to identify Gen 1 CLI command documentation
        const isGen1CliDoc = (path: string): boolean => {
          const lowerPath = path.toLowerCase();
          return (
            lowerPath.includes("/gen1/") &&
            lowerPath.includes("/tools/cli/commands/")
          );
        };

        // Helper function to determine if a path is likely Gen 2 documentation
        const isGen2Doc = (path: string): boolean => {
          const lowerPath = path.toLowerCase();
          // Gen 2 patterns
          return (
            // Check for Gen 2 specific paths
            lowerPath.includes("/gen2/") ||
            // Check for TypeScript/CDK patterns
            (lowerPath.includes(".ts") && !lowerPath.includes("/fragments/")) ||
            lowerPath.includes("backend") ||
            lowerPath.includes("/data/") ||
            lowerPath.includes("/auth/") ||
            lowerPath.includes("/storage/") ||
            lowerPath.includes("/function/") ||
            lowerPath.includes("cdk") ||
            // Code-first approach indicators
            lowerPath.includes("typescript") ||
            lowerPath.includes("code-first")
          );
        };

        // Helper function to determine if a path is likely Gen 1 documentation
        const isGen1Doc = (path: string): boolean => {
          const lowerPath = path.toLowerCase();
          // Gen 1 patterns
          return (
            lowerPath.includes("/gen1/") ||
            lowerPath.includes("/fragments/") ||
            lowerPath.includes("cli") ||
            lowerPath.includes(".schema") ||
            lowerPath.includes("lib-v1")
          );
        };

        // Check if the query is related to project setup or installation
        const isSetupQuery = processedQuery
          .toLowerCase()
          .match(
            /(setup|install|create|start|init|begin|new project|getting started|quickstart|prerequisites)/
          );

        // Check if the query is related to CLI commands
        const isCliQuery = processedQuery
          .toLowerCase()
          .match(/(cli|command|commands|amplify\s+\w+|cdk\s+\w+)/);

        // Check if the query is related to creating resources
        const isResourceCreationQuery = processedQuery
          .toLowerCase()
          .match(
            /(create|add|define|implement|build|configure)\s+(resource|api|auth|storage|function|database|model)/
          );

        // Check if query explicitly mentions Gen 2
        const queryMentionsGen2 =
          processedQuery.toLowerCase().includes("gen2") ||
          processedQuery.toLowerCase().includes("gen 2");

        // Check if query explicitly mentions Gen 1
        const queryMentionsGen1 =
          processedQuery.toLowerCase().includes("gen1") ||
          processedQuery.toLowerCase().includes("gen 1");

        // Check if paths contain setup documentation
        const aIsSetup = isSetupDoc(a.path);
        const bIsSetup = isSetupDoc(b.path);

        // Check if paths contain CLI documentation
        const aIsGen2Cli = isGen2CliDoc(a.path);
        const bIsGen2Cli = isGen2CliDoc(b.path);
        const aIsGen1Cli = isGen1CliDoc(a.path);
        const bIsGen1Cli = isGen1CliDoc(b.path);

        // Helper function to determine if a path contains TypeScript code examples
        const hasTypeScriptExamples = (path: string): boolean => {
          const lowerPath = path.toLowerCase();
          return (
            lowerPath.includes("typescript") ||
            lowerPath.includes("code-first") ||
            lowerPath.includes("cdk") ||
            (lowerPath.includes(".ts") && !lowerPath.includes("/fragments/"))
          );
        };

        // Helper function to determine if a path contains CLI command examples
        const hasCliExamples = (path: string): boolean => {
          const lowerPath = path.toLowerCase();
          return (
            lowerPath.includes("/cli/") ||
            lowerPath.includes("command") ||
            lowerPath.includes("commands")
          );
        };

        // Check if paths contain TypeScript or CLI examples
        const aHasTypeScript = hasTypeScriptExamples(a.path);
        const bHasTypeScript = hasTypeScriptExamples(b.path);
        const aHasCli = hasCliExamples(a.path);
        const bHasCli = hasCliExamples(b.path);

        // If query is about CLI commands, prioritize the appropriate CLI docs
        if (isCliQuery) {
          if (queryMentionsGen2) {
            // Prioritize Gen 2 CLI docs for Gen 2 CLI queries
            if (aIsGen2Cli && !bIsGen2Cli) return -1;
            if (!aIsGen2Cli && bIsGen2Cli) return 1;
          } else if (queryMentionsGen1) {
            // Prioritize Gen 1 CLI docs for Gen 1 CLI queries
            if (aIsGen1Cli && !bIsGen1Cli) return -1;
            if (!aIsGen1Cli && bIsGen1Cli) return 1;
          } else if (config.amplifyGeneration === "gen2") {
            // Default to Gen 2 CLI docs if configured for Gen 2
            if (aIsGen2Cli && !bIsGen2Cli) return -1;
            if (!aIsGen2Cli && bIsGen2Cli) return 1;
          } else if (config.amplifyGeneration === "gen1") {
            // Default to Gen 1 CLI docs if configured for Gen 1
            if (aIsGen1Cli && !bIsGen1Cli) return -1;
            if (!aIsGen1Cli && bIsGen1Cli) return 1;
          }
        }

        // If query is about creating resources, prioritize based on generation
        if (isResourceCreationQuery) {
          if (queryMentionsGen2) {
            // For Gen 2, prioritize TypeScript/code-first examples
            if (aHasTypeScript && !bHasTypeScript) return -1;
            if (!aHasTypeScript && bHasTypeScript) return 1;
          } else if (queryMentionsGen1) {
            // For Gen 1, prioritize CLI examples
            if (aHasCli && !bHasCli) return -1;
            if (!aHasCli && bHasCli) return 1;
          } else if (config.amplifyGeneration === "gen2") {
            // Default to TypeScript examples if configured for Gen 2
            if (aHasTypeScript && !bHasTypeScript) return -1;
            if (!aHasTypeScript && bHasTypeScript) return 1;
          } else if (config.amplifyGeneration === "gen1") {
            // Default to CLI examples if configured for Gen 1
            if (aHasCli && !bHasCli) return -1;
            if (!aHasCli && bHasCli) return 1;
          }
        }

        // If query is about setup and one path is a setup doc, prioritize it
        if (isSetupQuery) {
          if (aIsSetup && !bIsSetup) return -1;
          if (!aIsSetup && bIsSetup) return 1;
        }

        // Check if paths are from main platform docs
        const aIsMainPlatform = isMainPlatformDoc(a.path);
        const bIsMainPlatform = isMainPlatformDoc(b.path);

        // Prioritize main platform docs over everything else
        if (aIsMainPlatform && !bIsMainPlatform) return -1;
        if (!aIsMainPlatform && bIsMainPlatform) return 1;

        // Check if one is Gen 2 and the other is Gen 1
        const aIsGen2 = isGen2Doc(a.path);
        const bIsGen2 = isGen2Doc(b.path);
        const aIsGen1 = isGen1Doc(a.path);
        const bIsGen1 = isGen1Doc(b.path);

        // If query mentions Gen 1, prioritize Gen 1 docs
        if (queryMentionsGen1) {
          if (aIsGen1 && !bIsGen1) return -1;
          if (!aIsGen1 && bIsGen1) return 1;
        } else {
          // Otherwise prioritize Gen 2 over Gen 1
          if (aIsGen2 && bIsGen1) return -1;
          if (aIsGen1 && bIsGen2) return 1;
        }

        // Prioritize exact matches in titles
        const aTitleMatch = a.path
          .toLowerCase()
          .includes(processedQuery.toLowerCase());
        const bTitleMatch = b.path
          .toLowerCase()
          .includes(processedQuery.toLowerCase());

        if (aTitleMatch && !bTitleMatch) return -1;
        if (!aTitleMatch && bTitleMatch) return 1;

        // Then prioritize by match count
        return b.matchCount - a.matchCount;
      };

      // Apply best practices from Probe documentation

      // Include content details if requested
      if (args.includeContent) {
        options.includeMatchDetails = true;
        options.includeContent = true;
      }

      // Use filesOnly for initial broad searches
      if (args.filesOnly) {
        options.filesOnly = true;
      }

      // Use JSON format for programmatic processing
      if (args.useJson) {
        options.json = true;
      }

      // Use session ID for related searches
      if (args.sessionId) {
        options.session = args.sessionId;
      }

      console.log("Using custom ranking function for search");

      console.log(
        "Executing search with options:",
        JSON.stringify(options, null, 2)
      );

      // Check cache first, but bypass cache if we need accurate byte and token counts
      if (!args.includeContent) {
        const cachedResults = await this.cache.get(processedQuery, options);
        if (cachedResults) {
          console.log("Returning cached results");
          return this.formatResults(cachedResults, args);
        }
      } else {
        console.log("Bypassing cache for accurate byte and token counts");
      }

      try {
        // Call search with the options object
        if (args.sessionId) {
          if (!this.probeSessionCache[args.sessionId]) {
            this.probeSessionCache[args.sessionId] = {};
          }
          options.session = this.probeSessionCache[args.sessionId];
        }
        const result = await search(options);
        console.log("Search results type:", typeof result);
        console.log(
          "Search results sample:",
          typeof result === "string"
            ? result.substring(0, 200)
            : JSON.stringify(result).substring(0, 200)
        );

        // Cache the results
        await this.cache.set(processedQuery, options, result);

        // Format the results
        return this.formatResults(result, args);
      } catch (searchError) {
        console.error("Error during search:", searchError);
        return `Error during search: ${
          searchError instanceof Error
            ? searchError.message
            : String(searchError)
        }`;
      }
    } catch (error) {
      console.error("Error executing docs search:", error);
      throw new McpError(
        ErrorCode.InternalError,
        `Error executing docs search: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Format search results for display
   * @param {string} results - Search results
   * @param {SearchArgs} args - Search arguments
   * @returns {string} Formatted results
   */
  private formatResults(
    results: string | object | any,
    args: SearchArgs
  ): string {
    try {
      // Debug log to see what we're getting
      console.log("formatResults received type:", typeof results);

      // Handle JSON results if useJson is true and results is an object
      if (args.useJson && typeof results === "object") {
        console.log("Formatting as JSON");
        return JSON.stringify(results, null, 2);
      }

      // If results is already a string that looks like JSON, try to parse it
      if (typeof results === "string" && results.trim().startsWith("{")) {
        try {
          console.log("Trying to parse JSON string");
          const jsonObj = JSON.parse(results);
          if (args.useJson) {
            return JSON.stringify(jsonObj, null, 2);
          }
          // If we successfully parsed JSON but useJson is false,
          // we'll format it as text below
          results = jsonObj;
        } catch (e) {
          console.log("Failed to parse as JSON, treating as string");
          // Not valid JSON, continue treating as string
        }
      }

      // Convert results to string if it's not already
      const resultStr =
        typeof results === "string"
          ? results
          : typeof results === "object"
          ? JSON.stringify(results)
          : String(results);

      // Extract key information
      const matchCount = resultStr.match(/Found (\d+) search results/);
      const bytesReturned = resultStr.match(/Total bytes returned: (\d+)/);
      const tokensReturned = resultStr.match(/Total tokens returned: (\d+)/);
      const skippedFiles = resultStr.match(
        /Skipped files due to limits: (\d+)/
      );

      // Log the extracted values for debugging
      console.log(
        "Extracted match count:",
        matchCount ? matchCount[1] : "unknown"
      );
      console.log(
        "Extracted bytes returned:",
        bytesReturned ? bytesReturned[1] : "unknown"
      );
      console.log(
        "Extracted tokens returned:",
        tokensReturned ? tokensReturned[1] : "unknown"
      );
      console.log(
        "Extracted skipped files:",
        skippedFiles ? skippedFiles[1] : "unknown"
      );

      // Format results in a more user-friendly way
      let finalResult = "Search Results Summary:\n";
      finalResult += `- Query: "${args.query}"\n`;
      finalResult += `- Matches found: ${
        matchCount ? matchCount[1] : "unknown"
      }\n`;
      finalResult += `- Bytes returned: ${
        bytesReturned ? bytesReturned[1] : args.filesOnly ? "0" : "unknown"
      }\n`;
      finalResult += `- Tokens returned: ${
        tokensReturned ? tokensReturned[1] : args.filesOnly ? "0" : "unknown"
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

      // Debug: Log the raw results to help diagnose content extraction issues
      console.log("Raw search results:", resultStr.substring(0, 500) + "...");

      if (fileMatches) {
        finalResult += `\nFound ${fileMatches.length} file matches.\n`;

        // Determine how many matches to show
        const maxResults = args.maxResults || 10;

        // Use "Top X matches" instead of "First X matches" when maxResults is specified
        if (args.maxResults) {
          finalResult += `Top ${Math.min(
            maxResults,
            fileMatches.length
          )} matches:\n`;
        } else {
          finalResult += `First ${Math.min(
            maxResults,
            fileMatches.length
          )} matches:\n`;
        }

        // Extract content sections more aggressively
        const contentSections: { [key: string]: string } = {};

        // First, try to extract content sections using file paths as anchors
        for (let i = 0; i < fileMatches.length; i++) {
          const filePath = fileMatches[i].replace("File: ", "");
          const filePathEscaped = filePath.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
          );

          // Look for content between this file and the next file (or end of string)
          const nextFileIndex = resultStr.indexOf(
            "File:",
            resultStr.indexOf(filePath) + filePath.length
          );

          let fileSection = "";
          if (nextFileIndex !== -1) {
            fileSection = resultStr.substring(
              resultStr.indexOf(filePath) + filePath.length,
              nextFileIndex
            );
          } else {
            fileSection = resultStr.substring(
              resultStr.indexOf(filePath) + filePath.length
            );
          }

          // Extract content from the file section
          const contentMatch = fileSection.match(
            /Content:\s*([\s\S]*?)(?=\n\s*\n|$)/
          );
          if (contentMatch && contentMatch[1]) {
            contentSections[filePath] = contentMatch[1].trim();
          } else {
            // Try alternative patterns
            const matchMatch = fileSection.match(
              /Match:\s*([\s\S]*?)(?=\n\s*\n|$)/
            );
            if (matchMatch && matchMatch[1]) {
              contentSections[filePath] = matchMatch[1].trim();
            }
          }
        }

        // Show matches with content snippets
        for (let i = 0; i < Math.min(maxResults, fileMatches.length); i++) {
          const filePath = fileMatches[i].replace("File: ", "");
          finalResult += `${i + 1}. ${filePath}\n`;

          // Include content snippets if requested
          if (args.includeContent) {
            const content = contentSections[filePath] || "";

            // Format content as a code block
            finalResult += "```\n";
            if (content) {
              // Limit content length for readability
              const maxContentLength = 500;
              if (content.length > maxContentLength) {
                finalResult += content.substring(0, maxContentLength) + "...\n";
              } else {
                finalResult += content + "\n";
              }
            } else {
              // If we couldn't extract content, try to read the file directly
              try {
                const fullPath = filePath;
                if (fs.existsSync(fullPath)) {
                  const fileContent = fs.readFileSync(fullPath, "utf-8");
                  const excerpt =
                    fileContent.substring(0, 500) +
                    (fileContent.length > 500 ? "..." : "");
                  finalResult += excerpt + "\n";
                } else {
                  finalResult += "(Content not available)\n";
                }
              } catch (err) {
                finalResult += "(Content not available)\n";
                console.error(`Error reading file ${filePath}:`, err);
              }
            }
            finalResult += "```\n";

            // Add a note about getting full content
            finalResult += `To see the full content of this file, use: search_amplify_docs(query: "${args.query}", fullContent: true, filePath: "${filePath}")\n`;
          }
        }

        if (fileMatches.length > maxResults) {
          finalResult += `... and ${
            fileMatches.length - maxResults
          } more files\n`;
        }

        // Add pagination information
        const page = args.page || 1;
        if (skippedFiles && parseInt(skippedFiles[1]) > 0) {
          finalResult += `\nTo see more results, use: search_amplify_docs(query: "${
            args.query
          }", page: ${page + 1})\n`;
        }

        // Add content viewing tip
        if (!args.includeContent) {
          finalResult +=
            '\nTo see content snippets in the results, use: search_amplify_docs(query: "' +
            args.query +
            '", includeContent: true)\n';
        }

        finalResult +=
          "\nTo see the full content of the search results, try refining your search query.\n";
      } else {
        finalResult += "\nNo file matches found.\n";
      }

      return finalResult;
    } catch (error) {
      console.error("Error formatting results:", error);
      return `Error formatting results: ${
        error instanceof Error ? error.message : String(error)
      }\n\nRaw results:\n${results}`;
    }
  }

  /**
   * Process advanced query syntax
   * @param {string} query - The original query
   * @returns {string} - Processed query
   * @private
   */
  private processAdvancedQuery(query: string): string {
    // Already supports:
    // - Boolean operators: AND, OR, NOT
    // - Grouping with parentheses: (term1 OR term2)
    // - Field-specific search: title:term

    // No additional processing needed as the underlying search engine
    // already supports these advanced features
    return query;
  }

  /**
   * Extract headings from markdown content
   * @param {string} content - Markdown content
   * @param {string} filePath - Path to the file
   * @returns {HeadingInfo[]} Array of heading information
   * @private
   */
  private extractHeadings(content: string, filePath: string): HeadingInfo[] {
    const headings: HeadingInfo[] = [];
    const headingRegex = /^(#{1,6})\s+(.+)$/gm;

    let match;
    while ((match = headingRegex.exec(content)) !== null) {
      const level = match[1].length;
      const heading = match[2].trim();

      // Get the content under this heading (until the next heading or end of file)
      const startPos = match.index + match[0].length;
      const nextHeadingMatch = content.slice(startPos).match(/^#{1,6}\s+.+$/m);
      const endPos =
        nextHeadingMatch && nextHeadingMatch.index !== undefined
          ? startPos + nextHeadingMatch.index
          : content.length;

      const headingContent = content.slice(startPos, endPos).trim();

      headings.push({
        path: filePath,
        heading,
        level,
        content: headingContent,
      });
    }

    return headings;
  }

  /**
   * Build an index of headings from markdown files
   * @returns {Promise<HeadingIndex>} Index of headings
   * @private
   */
  private async buildHeadingIndex(): Promise<HeadingIndex> {
    console.log("Building heading index...");
    const index: HeadingIndex = {};

    try {
      // Find all markdown files in the data directory
      const files = await fs.readdir(config.dataDir, { recursive: true });
      const markdownFiles = files.filter(
        (file) =>
          typeof file === "string" &&
          (file.endsWith(".md") || file.endsWith(".mdx"))
      );

      console.log(`Found ${markdownFiles.length} markdown files`);

      // Process each file
      for (const file of markdownFiles) {
        try {
          // Ensure file is a string
          if (typeof file !== "string") {
            console.error(`Skipping non-string file: ${file}`);
            continue;
          }

          const filePath = path.join(config.dataDir, file);
          // Use readFileSync with utf-8 encoding and explicitly cast to string
          const content = fs.readFileSync(filePath, "utf-8").toString();

          // Extract headings from the file
          const headings = this.extractHeadings(content, filePath);

          // Add headings to the index
          for (const heading of headings) {
            // Split heading into keywords
            const keywords = heading.heading
              .toLowerCase()
              .split(/\s+/)
              .filter((word) => word.length > 2); // Filter out short words

            // Add heading to index for each keyword
            for (const keyword of keywords) {
              if (!index[keyword]) {
                index[keyword] = [];
              }
              index[keyword].push(heading);
            }
          }
        } catch (error) {
          console.error(`Error processing file ${file}:`, error);
        }
      }

      console.log(
        `Built heading index with ${Object.keys(index).length} keywords`
      );
      return index;
    } catch (error) {
      console.error("Error building heading index:", error);
      return {};
    }
  }

  /**
   * Get the heading index, building it if necessary
   * @param {string} sessionId - Session ID for caching
   * @returns {Promise<HeadingIndex>} Heading index
   * @private
   */
  private async getHeadingIndex(sessionId?: string): Promise<HeadingIndex> {
    // Check if we have a session cache
    if (sessionId && this.sessionCaches.has(sessionId)) {
      const sessionCache = this.sessionCaches.get(sessionId)!;

      // Check if the cache is still valid (less than 1 hour old)
      if (Date.now() - sessionCache.lastUpdated < 3600000) {
        console.log(
          `Using session cache for heading index (session: ${sessionId})`
        );
        return sessionCache.headingIndex;
      }
    }

    // Check if we need to rebuild the global index
    if (
      Object.keys(this.headingIndex).length === 0 ||
      Date.now() - this.lastHeadingIndexUpdate > 3600000
    ) {
      console.log("Building global heading index...");
      this.headingIndex = await this.buildHeadingIndex();
      this.lastHeadingIndexUpdate = Date.now();
    }

    // Update session cache if we have a session ID
    if (sessionId) {
      console.log(
        `Updating session cache for heading index (session: ${sessionId})`
      );
      this.sessionCaches.set(sessionId, {
        headingIndex: this.headingIndex,
        lastUpdated: Date.now(),
      });
    }

    return this.headingIndex;
  }

  /**
   * Find relevant headings for a query
   * @param {string} query - Search query
   * @param {string} sessionId - Session ID for caching
   * @returns {Promise<HeadingInfo[]>} Array of relevant headings
   * @private
   */
  private async findRelevantHeadings(
    query: string,
    sessionId?: string
  ): Promise<HeadingInfo[]> {
    const headingIndex = await this.getHeadingIndex(sessionId);

    // Split query into keywords
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 2); // Filter out short words

    // Find headings that match the keywords
    const headingMatches: { [key: string]: HeadingInfo } = {};

    for (const keyword of keywords) {
      const matchingHeadings = headingIndex[keyword] || [];

      for (const heading of matchingHeadings) {
        // Use the path and heading as a unique key
        const key = `${heading.path}#${heading.heading}`;

        if (!headingMatches[key]) {
          headingMatches[key] = heading;
        }
      }
    }

    // Check if query is related to setup or resource creation
    const isSetupQuery = query
      .toLowerCase()
      .match(
        /(setup|install|create|start|init|begin|new project|getting started)/
      );

    const isResourceCreationQuery = query
      .toLowerCase()
      .match(
        /(create|add|define|implement|build|configure)\s+(resource|api|auth|storage|function|database|model)/
      );

    // Check if query mentions specific generation
    const mentionsGen1 =
      query.toLowerCase().includes("gen1") ||
      query.toLowerCase().includes("gen 1");
    const mentionsGen2 =
      query.toLowerCase().includes("gen2") ||
      query.toLowerCase().includes("gen 2");

    // Convert to array for sorting
    let headings = Object.values(headingMatches);

    // Apply custom sorting based on query context
    if (isSetupQuery || isResourceCreationQuery) {
      headings.sort((a, b) => {
        const aPath = a.path.toLowerCase();
        const bPath = b.path.toLowerCase();
        const aHeading = a.heading.toLowerCase();
        const bHeading = b.heading.toLowerCase();

        // Helper functions to identify content type
        const isTypeScriptContent = (
          path: string,
          heading: string
        ): boolean => {
          return (
            path.includes("typescript") ||
            path.includes("code-first") ||
            path.includes("cdk") ||
            heading.includes("typescript") ||
            heading.includes("code-first")
          );
        };

        const isCliContent = (path: string, heading: string): boolean => {
          return (
            path.includes("/cli/") ||
            path.includes("command") ||
            heading.includes("cli") ||
            heading.includes("command")
          );
        };

        // Check content types
        const aIsTypeScript = isTypeScriptContent(aPath, aHeading);
        const bIsTypeScript = isTypeScriptContent(bPath, bHeading);
        const aIsCli = isCliContent(aPath, aHeading);
        const bIsCli = isCliContent(bPath, bHeading);

        // Prioritize based on generation
        if (mentionsGen2) {
          // For Gen 2, prioritize TypeScript/code-first content
          if (aIsTypeScript && !bIsTypeScript) return -1;
          if (!aIsTypeScript && bIsTypeScript) return 1;
        } else if (mentionsGen1) {
          // For Gen 1, prioritize CLI content
          if (aIsCli && !bIsCli) return -1;
          if (!aIsCli && bIsCli) return 1;
        } else if (config.amplifyGeneration === "gen2") {
          // Default to TypeScript content if configured for Gen 2
          if (aIsTypeScript && !bIsTypeScript) return -1;
          if (!aIsTypeScript && bIsTypeScript) return 1;
        } else if (config.amplifyGeneration === "gen1") {
          // Default to CLI content if configured for Gen 1
          if (aIsCli && !bIsCli) return -1;
          if (!aIsCli && bIsCli) return 1;
        }

        // Fall back to heading level sorting
        return a.level - b.level;
      });

      return headings;
    }

    // Default sorting by heading level (lower levels first)
    return headings.sort((a, b) => a.level - b.level);
  }

  async run(): Promise<void> {
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

      // Load the directory structure
      console.log("Loading directory structure...");
      const directoryLoaded = await this.directoryManager.load();
      if (directoryLoaded) {
        console.log("Directory structure loaded successfully");
      } else {
        console.log(
          "Failed to load directory structure, continuing without it"
        );
      }

      // Build initial heading index
      console.log("Building initial heading index...");
      this.headingIndex = await this.buildHeadingIndex();
      this.lastHeadingIndexUpdate = Date.now();

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
