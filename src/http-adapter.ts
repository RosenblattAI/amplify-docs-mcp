#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import { search } from "@buger/probe";
import { loadConfig } from "./config.js";
import { setupGitRepo } from "./git.js";
import { SearchCache } from "./cache.js";
import { DirectoryManager } from "./directory.js";
import fs from "fs-extra";
import path from "path";

// Load configuration
const config = loadConfig();

// Initialize components
const cache = new SearchCache(path.join(config.dataDir, ".cache"));
const directoryManager = new DirectoryManager(config.dataDir);

/**
 * HTTP adapter for the MCP Amplify Docs server
 * Provides REST API endpoints that wrap the MCP functionality
 */
class HttpAdapter {
  private app: express.Application;
  private headingIndex: any = {};
  private lastHeadingIndexUpdate: number = 0;

  constructor() {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // Enable CORS for all routes
    this.app.use(cors({
      origin: '*',
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));

    // Parse JSON bodies
    this.app.use(express.json({ limit: '10mb' }));
    
    // Parse URL-encoded bodies
    this.app.use(express.urlencoded({ extended: true }));

    // Request logging
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
      next();
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        config: {
          dataDir: config.dataDir,
          amplifyGeneration: config.amplifyGeneration,
          autoUpdateInterval: config.autoUpdateInterval
        }
      });
    });

    // API documentation
    this.app.get('/', (req, res) => {
      res.json({
        name: 'AWS Amplify Documentation Search API',
        version: '1.0.0',
        endpoints: {
          'GET /health': 'Health check',
          'POST /api/search': 'Search documentation (MCP format)',
          'GET /search': 'Search documentation (REST format)',
          'POST /search': 'Search documentation (REST format)'
        },
        mcp_tool: config.toolName
      });
    });

    // MCP-compatible search endpoint (for Cloudflare Worker)
    this.app.post('/api/search', async (req, res) => {
      try {
        const { tool, arguments: args } = req.body;
        
        if (tool !== config.toolName) {
          return res.status(400).json({
            error: `Unknown tool: ${tool}. Expected: ${config.toolName}`
          });
        }

        if (!args || !args.query) {
          return res.status(400).json({
            error: 'Missing required field: query in arguments'
          });
        }

        const result = await this.executeSearch(args);
        
        res.json({
          content: [{
            type: 'text',
            text: result
          }]
        });

      } catch (error) {
        console.error('MCP search error:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });

    // REST-style search endpoints
    this.app.get('/search', async (req, res) => {
      try {
        const query = req.query.query as string;
        
        if (!query) {
          return res.status(400).json({
            error: 'Missing required parameter: query'
          });
        }

        const searchArgs = {
          query,
          page: parseInt(req.query.page as string || '1'),
          includeContent: req.query.includeContent === 'true',
          maxResults: parseInt(req.query.maxResults as string || '10'),
          filesOnly: req.query.filesOnly === 'true',
          useJson: req.query.useJson === 'true',
          sessionId: req.query.sessionId as string,
        };

        const result = await this.executeSearch(searchArgs);
        
        res.json({
          query: searchArgs.query,
          results: result,
          metadata: {
            timestamp: new Date().toISOString(),
            cached: false // TODO: Implement proper cache detection
          }
        });

      } catch (error) {
        console.error('REST search error:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });

    this.app.post('/search', async (req, res) => {
      try {
        const searchArgs = req.body;
        
        if (!searchArgs.query) {
          return res.status(400).json({
            error: 'Missing required field: query'
          });
        }

        const result = await this.executeSearch(searchArgs);
        
        res.json({
          query: searchArgs.query,
          results: result,
          metadata: {
            timestamp: new Date().toISOString(),
            cached: false
          }
        });

      } catch (error) {
        console.error('REST POST search error:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'Not found',
        available_endpoints: ['/health', '/api/search', '/search']
      });
    });
  }

  /**
   * Execute search using the same logic as the MCP server
   */
  private async executeSearch(args: any): Promise<string> {
    try {
      // Use the configured data directory
      let searchPath = config.dataDir;

      // Get pagination parameters
      const page = args.page || 1;
      const pageSize = 25000;
      const skipTokens = (page - 1) * pageSize;

      // Create options object
      const options: any = {
        path: searchPath,
        query: args.query,
        maxTokens: pageSize,
        skipTokens: skipTokens,
        maxResults: args.maxResults || 10,
      };

      // Use directory structure to optimize search if available
      if (directoryManager && directoryManager.getDirectory()) {
        console.log("Using directory structure to optimize search");

        const queryLower = args.query.toLowerCase();
        const mentionsGen1 = queryLower.includes("gen1") || queryLower.includes("gen 1");
        const mentionsGen2 = queryLower.includes("gen2") || queryLower.includes("gen 2");

        let generation = "both";
        if (mentionsGen1 && !mentionsGen2) {
          generation = "gen1";
        } else if (mentionsGen2 && !mentionsGen1) {
          generation = "gen2";
        } else if (config.amplifyGeneration !== "both") {
          generation = config.amplifyGeneration;
        }

        const matchingPaths = directoryManager.getMatchingPaths(args.query, generation);
        if (matchingPaths.length > 0) {
          const matchingPathsSet = new Set(matchingPaths);
          const filterFunction = (filePath: string): boolean => {
            for (const matchingPath of matchingPathsSet) {
              if (filePath.includes(matchingPath)) {
                return true;
              }
            }
            return false;
          };
          options.filterFunction = filterFunction;
        }
      }

      // Include content details if requested
      if (args.includeContent) {
        options.includeMatchDetails = true;
        options.includeContent = true;
      }

      if (args.filesOnly) {
        options.filesOnly = true;
      }

      if (args.useJson) {
        options.json = true;
      }

      if (args.sessionId) {
        options.session = args.sessionId;
      }

      // Check cache first
      const cachedResults = await cache.get(args.query, options);
      if (cachedResults && !args.includeContent) {
        console.log("Returning cached results");
        return this.formatResults(cachedResults, args);
      }

      // Execute search
      const result = await search(options);
      
      // Cache the results
      await cache.set(args.query, options, result);

      // Format and return results
      return this.formatResults(result, args);

    } catch (error) {
      console.error("Error executing search:", error);
      throw new Error(`Search execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Format search results (simplified version of the MCP server logic)
   */
  private formatResults(results: any, args: any): string {
    try {
      if (args.useJson && typeof results === "object") {
        return JSON.stringify(results, null, 2);
      }

      const resultStr = typeof results === "string" ? results : JSON.stringify(results);

      // Extract key information
      const matchCount = resultStr.match(/Found (\d+) search results/);
      const fileMatches = resultStr.match(/File: ([^\n]+)/g) || [];

      let finalResult = "Search Results Summary:\n";
      finalResult += `- Query: "${args.query}"\n`;
      finalResult += `- Matches found: ${matchCount ? matchCount[1] : fileMatches.length}\n`;

      if (fileMatches.length > 0) {
        const maxResults = args.maxResults || 10;
        finalResult += `\nTop ${Math.min(maxResults, fileMatches.length)} matches:\n`;

        for (let i = 0; i < Math.min(maxResults, fileMatches.length); i++) {
          const filePath = fileMatches[i].replace("File: ", "");
          finalResult += `${i + 1}. ${filePath}\n`;
        }

        if (fileMatches.length > maxResults) {
          finalResult += `... and ${fileMatches.length - maxResults} more files\n`;
        }
      } else {
        finalResult += "\nNo file matches found.\n";
      }

      return finalResult;

    } catch (error) {
      console.error("Error formatting results:", error);
      return `Error formatting results: ${error instanceof Error ? error.message : String(error)}\n\nRaw results:\n${results}`;
    }
  }

  async start(port: number = 3000): Promise<void> {
    try {
      console.log("Starting HTTP adapter for MCP Amplify Docs server...");
      console.log(`Using data directory: ${config.dataDir}`);

      // Setup Git repository if needed
      if (config.gitUrl) {
        console.log(`Setting up Git repository: ${config.gitUrl}`);
        await setupGitRepo(config);

        // Schedule auto-updates if enabled
        if (config.autoUpdateInterval > 0) {
          setInterval(() => {
            setupGitRepo(config, true);
          }, config.autoUpdateInterval * 60 * 1000);
        }
      }

      // Load directory structure
      console.log("Loading directory structure...");
      const directoryLoaded = await directoryManager.load();
      if (directoryLoaded) {
        console.log("Directory structure loaded successfully");
      } else {
        console.log("Failed to load directory structure, continuing without it");
      }

      // Start the server
      this.app.listen(port, '0.0.0.0', () => {
        console.log(`HTTP adapter listening on port ${port}`);
        console.log(`Health check: http://localhost:${port}/health`);
        console.log(`Search endpoint: http://localhost:${port}/search`);
        console.log(`MCP endpoint: http://localhost:${port}/api/search`);
      });

    } catch (error) {
      console.error("Error starting HTTP adapter:", error);
      process.exit(1);
    }
  }
}

// Start the server if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.PORT || '3000');
  const adapter = new HttpAdapter();
  adapter.start(port);
}

export { HttpAdapter };