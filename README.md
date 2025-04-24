# AWS Amplify Documentation MCP Server

A Model Context Protocol (MCP) server that provides powerful search functionality for AWS Amplify documentation. This server clones the official AWS Amplify documentation repository and makes it searchable through a simple MCP tool interface.

## Features

- **Powerful Search**: Search AWS Amplify documentation using natural language queries
- **Advanced Search Syntax**: Support for boolean operators, wildcards, field-specific search, and more
- **Smart Results Ranking**: Intelligent ranking of search results based on relevance to query
- **Pagination**: Navigate through large result sets with pagination support
- **Performance Caching**: Caching of search results for improved performance
- **Auto-Updates**: Automatic updates of documentation from the official AWS Amplify repository
- **Generation Selection**: Choose between Gen 1, Gen 2, or both documentation sets to optimize disk usage and search radius.
- **TypeScript Implementation**: Built with TypeScript for better type safety and developer experience

> **Disclaimer**: This is a personal project and is not affiliated with, endorsed by, or officially connected to AWS Amplify or Amazon Web Services. This tool is provided as-is without any guarantees or warranty.

## Installation

1. Clone this repository:

```bash
git clone https://github.com/ykethan/amplify-doc-mcp.git
cd amplify-doc-mcp
```

1. Install dependencies:

```bash
npm install
```

1. Build the TypeScript code:

```bash
npm run build
```

## Configuration

The server is configured using the `docs-mcp.config.json` file:

```json
{
  "gitUrl": "https://github.com/aws-amplify/docs.git",
  "gitRef": "main",
  "autoUpdateInterval": 60,
  "toolName": "search_amplify_docs",
  "toolDescription": "Search AWS Amplify documentation using the probe search engine.",
  "ignorePatterns": [
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".vitepress/cache",
    "*.jpg",
    "*.jpeg",
    "*.png",
    "*.gif",
    "*.svg",
    "*.mp4",
    "*.webm"
  ],
  "amplifyGeneration": "gen2"
}
```

### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `gitUrl` | URL of the Git repository to clone for documentation | `"https://github.com/aws-amplify/docs.git"` |
| `gitRef` | Git branch or tag to checkout | `"main"` |
| `autoUpdateInterval` | Interval in minutes to check for updates (0 to disable) | `60` |
| `dataDir` | Directory to store documentation data | `"./data"` |
| `toolName` | Name of the search tool | `"search_amplify_docs"` |
| `toolDescription` | Description of the search tool | `"Search AWS Amplify documentation using the probe search engine."` |
| `ignorePatterns` | Array of patterns to ignore when searching | `["node_modules", ".git", ...]` |
| `amplifyGeneration` | Which Amplify documentation generation to include | `"gen2"` |

### Auto-Update Mechanism

The server includes an automatic update mechanism that keeps the documentation up-to-date:

1. When the server starts, it clones the documentation repository specified in `gitUrl`.
2. If `autoUpdateInterval` is set to a value greater than 0, the server will periodically check for updates.
3. Every `autoUpdateInterval` minutes, the server:
   - Fetches the latest changes from the remote repository
   - Checks if the local branch is behind the remote branch
   - If updates are available, pulls the changes automatically
   - If no updates are needed, continues with the current documentation

This ensures that your documentation search results always include the latest information without requiring a server restart.

## Usage

### Starting the Server

```bash
npm start
```

Or use the provided start script with options:

```bash
./start-server.sh [--gen1|--gen2] [--rebuild]
```

#### Options

- `--gen1`: Include only Gen 1 documentation (reduces disk space usage)
- `--gen2`: Include only Gen 2 documentation (reduces disk space usage)
- `--rebuild`: Force rebuild of data directory

#### Examples

```bash
# Start with both Gen 1 and Gen 2 documentation
./start-server.sh

# Start with only Gen 1 documentation
./start-server.sh --gen1

# Start with only Gen 2 documentation and force rebuild
./start-server.sh --gen2 --rebuild
```

### MCP Tool: search_amplify_docs

The server provides a tool called `search_amplify_docs` that can be used to search the Amplify documentation.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | - | Elasticsearch query string |
| `page` | number | No | 1 | Page number for pagination |
| `includeContent` | boolean | No | false | Include content snippets in results |
| `maxResults` | number | No | 10 | Maximum number of results to return |
| `filesOnly` | boolean | No | false | Only return file paths without content |
| `useJson` | boolean | No | false | Return results in JSON format |
| `sessionId` | string | No | - | Session ID for related searches |
| `fullContent` | boolean | No | false | Get full content of a specific file |
| `filePath` | string | No | - | Path to a specific file to get full content |

#### Example Request

```json
{
  "query": "authentication react",
  "page": 1,
  "includeContent": true,
  "maxResults": 15
}
```

### Advanced Search Syntax

The search tool supports advanced search syntax:

- **Exact phrases**: `"authentication flow"`
- **Exclude terms**: `authentication -flutter`
- **Field-specific search**: `title:authentication`
- **Wildcards**: `auth*`
- **Boolean operators**: `authentication AND (react OR javascript) NOT flutter`

### How the Query Process Works

When you submit a search query, the server processes it through several steps:

1. **Query Processing**: The server parses your query to understand advanced syntax like boolean operators and wildcards.

2. **Directory Optimization**: The server uses the directory structure to narrow down which files to search based on your query terms and the selected Amplify generation (Gen 1, Gen 2, or both).

3. **Smart Ranking**: Results are ranked using a sophisticated algorithm that considers:
   - Whether the query mentions specific generations (Gen 1 or Gen 2)
   - If the query is about setup, CLI commands, or resource creation
   - The relevance of the document to the query context
   - Exact matches in document titles
   - Match count and document importance

4. **Content Extraction**: For each matching file, relevant content is extracted and formatted for display.

5. **Caching**: Search results are cached to improve performance for repeated queries.

This intelligent processing ensures that the most relevant documentation appears at the top of your search results, saving you time and effort.

## Generation Selection

The server supports three modes for Amplify documentation generation:

### 1. Both Generations (Default)

```json
"amplifyGeneration": "both"
```

- **Pros**: Complete documentation coverage
- **Cons**: Lot more search area, can cause incorrect information as Gen 1 and Gen 2 nearly have same resources.
- **Recommendation**: Use Gen 1 or Gen 2 only for better results

### 2. Gen 1 Only

```json
"amplifyGeneration": "gen1"
```

- **Pros**: Reduced disk space, focused on classic Amplify implementation
- **Cons**: Missing newer Gen 2 documentation
- **Recommended for**: Projects specifically using Amplify Gen 1 features

### 3. Gen 2 Only

```json
"amplifyGeneration": "gen2"
```

- **Pros**: Reduced disk space, focused on modern Amplify implementation
- **Cons**: Missing legacy Gen 1 documentation
- **Recommended for**: New projects using Amplify Gen 2 features

## Project Structure

- `src/index.ts`: Main server implementation
- `src/config.ts`: Configuration loading and processing
- `src/git.ts`: Git repository management
- `src/cache.ts`: Search result caching
- `src/directory.ts`: Directory structure management
- `src/types/`: TypeScript type definitions
- `scripts/build.js`: Build script for preparing documentation
- `bin/mcp`: Executable script for running the server

## Recommendations for Usage

1. **Optimize for Your Environment**:
   - For best search results, use `"amplifyGeneration"` as `"gen1"` or `"gen2"` only

2. **Search Optimization**:
   - Use specific technical terms rather than general phrases
   - Include category names to narrow results (e.g., "storage owner access" instead of just "access")
   - Use quotes for exact phrase matching
   - Include abbreviations and alternative terms to improve results

3. **Performance Considerations**:
   - Set an appropriate `autoUpdateInterval` based on your needs (higher values reduce server load)
   - Use the caching system for frequently accessed queries
   - Consider using `filesOnly: true` for initial broad searches to improve performance

## Contributing and Feedback

We welcome contributions and feedback to improve this MCP server. If you have suggestions for:

- Improving search query results
- Enhancing the ranking algorithm
- Adding new features or parameters
- Optimizing performance

Please open an issue or submit a pull request on GitHub. Your feedback helps make this tool more effective for everyone. Along the way learn something new.

## System Requirements

- Node.js 18.x or higher (tested with Node.js 20.18.2)
- npm 8.x or higher (tested with npm 10.8.2)

## License

This project is licensed under the MIT License.
