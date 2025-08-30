# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an **MCP (Model Context Protocol) server** that provides powerful search functionality for AWS Amplify documentation. The server clones the official AWS Amplify documentation repository and makes it searchable through a simple MCP tool interface using the `@buger/probe` search engine.

Key capabilities:
- Searches AWS Amplify documentation using natural language queries
- Supports Gen 1, Gen 2, or both documentation sets
- Auto-updates documentation from the official AWS repository
- Advanced search syntax with boolean operators, wildcards, and field-specific search
- Smart results ranking based on query context and generation preferences
- Performance caching for improved response times

## Common Development Commands

### Building and Running
```bash
# Build TypeScript files
npm run build

# Start the MCP server (stdio transport)
npm start

# Start the HTTP adapter (REST API)
npm run start:http

# Development mode with TypeScript watch
npm run dev          # MCP server
npm run dev:http     # HTTP adapter

# Run build script to setup/update documentation
npm run build:js

# Deploy Cloudflare Worker wrapper
npm run deploy:worker
```

### Server Management
```bash
# Start with specific generation (recommended for development)
./start-server.sh --gen 2 --rebuild

# Start with Gen 1 only
./start-server.sh --gen 1

# Start with both generations (larger disk usage)
./start-server.sh --gen both

# Force rebuild of documentation
./start-server.sh --rebuild
```

## High-Level Architecture

### Core Components

**`src/index.ts`** - Main MCP server implementation
- Implements the MCP protocol using `@modelcontextprotocol/sdk`
- Handles search requests via the `search_amplify_docs` tool
- Includes sophisticated ranking algorithm that prioritizes results based on:
  - Query context (setup, CLI commands, resource creation)
  - Generation preferences (Gen 1 vs Gen 2)
  - Main platform documentation vs fragments
  - Exact title matches and match counts

**`src/config.ts`** - Configuration management
- Loads configuration from multiple sources (file, environment variables, command line)
- Supports flexible configuration for different deployment scenarios
- Key settings: `gitUrl`, `amplifyGeneration`, `autoUpdateInterval`, `dataDir`

**`src/git.ts`** - Git repository management
- Handles cloning and updating the AWS Amplify docs repository
- Supports both Git clone (for auto-updates) and tarball download (for static setups)
- Implements generation-specific cleanup (removes Gen 1 or Gen 2 files based on config)
- Includes fallback mechanisms and error handling for disk space issues

**`src/cache.ts`** - Search result caching
- Simple file-based cache with 24-hour expiration
- Improves performance for repeated queries
- Cache keys generated from query + search options hash

**`src/directory.ts`** - Directory structure optimization
- Manages directory structure knowledge for search optimization
- Helps narrow down search scope based on query terms and generation

**`src/http-adapter.ts`** - HTTP/REST API wrapper
- Express.js server that wraps MCP functionality for HTTP access
- Provides REST endpoints (`/search`, `/health`) alongside MCP protocol
- Enables deployment to traditional hosting platforms (Railway, Render, ECS)
- Used in conjunction with Cloudflare Worker for global edge caching

**`worker-wrapper.js`** - Cloudflare Worker proxy
- Global edge proxy that forwards HTTP requests to HTTP adapter
- Provides caching, CORS handling, and global distribution
- Converts between public HTTP API and internal MCP server communication
- Deployed to Cloudflare's edge network for <50ms worldwide response times

### Build and Setup Process

**`scripts/build.js`** - Documentation setup and maintenance
- Clones or downloads AWS Amplify documentation
- Supports sparse checkout for generation-specific documentation
- Performs cleanup of large/binary files to optimize search performance
- Handles various error scenarios (disk space, network issues)

### Configuration System

The server uses a hierarchical configuration system:
1. Default configuration in `src/config.ts`
2. File-based configuration (`docs-mcp.config.json`)
3. Environment variables (prefixed with config key names)
4. Command-line arguments (highest priority)

Critical configuration options:
- `amplifyGeneration`: "gen1", "gen2", or "both" (affects which docs are included)
- `autoUpdateInterval`: Minutes between auto-updates (0 to disable)
- `dataDir`: Where documentation files are stored (default: `./data`)

### Search Architecture

The search system uses several layers:
1. **Query Processing**: Handles advanced search syntax (boolean operators, wildcards)
2. **Directory Optimization**: Uses directory structure to narrow search scope
3. **Ranking Algorithm**: Sophisticated multi-factor ranking considering:
   - Generation context from query
   - Content type preferences (TypeScript vs CLI)
   - Document importance (main platform docs vs fragments)
   - Setup/resource creation context
4. **Result Formatting**: User-friendly output with pagination and content snippets

## Development Guidelines

### Working with Search Logic
- Search ranking logic is in `src/index.ts` lines 451-679 (rankingFunction)
- When modifying ranking, test with queries like "setup", "create api", "gen1 cli", "gen2 typescript"
- Search options are passed to the `@buger/probe` library - see their documentation for advanced features

### Configuration Changes
- Always update both the Config interface and defaultConfig object
- Test configuration precedence: CLI args > env vars > config file > defaults
- When adding new config options, update `loadConfig()` function to handle all sources

### Generation-Specific Features
- Gen 1 primarily uses CLI-based workflows and fragments
- Gen 2 uses TypeScript/code-first approach with CDK patterns
- Search ranking adjusts recommendations based on detected generation preferences

### Testing Search Functionality
The server provides a comprehensive MCP tool interface. Test with queries that cover:
- Setup scenarios: "install amplify", "create new project"  
- CLI commands: "amplify add auth", "cdk deploy"
- Resource creation: "create api", "configure storage"
- Generation-specific: "gen1 authentication", "gen2 typescript"

### Error Handling
The codebase includes robust error handling for:
- Network failures during documentation download
- Disk space issues during cloning
- Git repository corruption or access issues
- Search engine errors and fallbacks

When working on error handling, ensure graceful degradation and clear user messaging.

## Deployment Architecture Options

### Option 1: MCP-Only (Original)
```
MCP Client → MCP Server (stdio) → AWS Amplify Docs
```
- Direct MCP protocol communication
- Deploy to: Railway, Render, ECS, VPS
- Best for: MCP clients like Claude Desktop

### Option 2: HTTP + Cloudflare Worker (Recommended)
```
HTTP Client → Cloudflare Worker → HTTP Adapter → MCP Server → AWS Amplify Docs
```
- Global edge caching and distribution
- HTTP Adapter: Deploy to Railway, Render, ECS
- Cloudflare Worker: `npm run deploy:worker`
- Best for: Web applications, APIs, global access

### Option 3: HTTP-Only
```
HTTP Client → HTTP Adapter → AWS Amplify Docs
```
- Direct HTTP access without edge caching
- Deploy HTTP adapter to any Node.js hosting
- Best for: Simple deployments, internal tools

### Option 4: AWS ECS Fargate (Enterprise)
```
Internet → ALB → ECS Fargate (HTTP + MCP) → EFS → AWS Amplify Docs
```
- Auto-scaling containers with persistent storage
- Both MCP and HTTP protocols available
- Production-ready with monitoring and security
- Best for: Enterprise deployments, high availability

## Quick Deployment Commands

```bash
# Railway (simple)
railway up

# AWS ECS Fargate (enterprise)
npm run deploy:aws

# Cloudflare Worker (global edge)
npm run deploy:worker
```

See `DEPLOYMENT.md` for Cloudflare Worker + Railway setup.  
See `AWS-DEPLOYMENT.md` for comprehensive AWS ECS Fargate deployment.