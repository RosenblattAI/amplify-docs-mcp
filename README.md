# Amplify Docs MCP Server

This is a Model Context Protocol (MCP) server that provides search functionality for AWS Amplify documentation. It is implemented in TypeScript for better type safety and developer experience.

## Features

- Search AWS Amplify documentation using natural language queries
- Support for advanced search syntax (boolean operators, wildcards, etc.)
- Pagination of search results
- Caching of search results for improved performance
- Automatic updates of documentation from the official AWS Amplify docs repository
- Selective documentation loading (Gen 1, Gen 2, or both) to reduce disk space usage
- TypeScript implementation for better type safety and developer experience

## Installation

1. Clone this repository:
```bash
git clone https://github.com/yourusername/amplify-docs-mcp.git
cd amplify-docs-mcp
```

2. Install dependencies:
```bash
npm install
```

3. Configure the server by editing `docs-mcp.config.json`:
```json
{
  "gitUrl": "https://github.com/aws-amplify/docs.git",
  "gitRef": "main",
  "autoUpdateInterval": 60,
  "toolName": "search_amplify_docs",
  "toolDescription": "Search AWS Amplify documentation using the probe search engine.",
  "amplifyGeneration": "both"
}
```

4. Build the TypeScript code:
```bash
npm run build
```

## Usage

### Starting the Server

```bash
npm start
```

Or use the provided start script:

```bash
./start-server.sh [--gen1|--gen2] [--rebuild]
```

Options:
- `--gen1`: Include only Gen 1 documentation (reduces disk space usage)
- `--gen2`: Include only Gen 2 documentation (reduces disk space usage)
- `--rebuild`: Force rebuild of data directory

Examples:
```bash
# Start with both Gen 1 and Gen 2 documentation (default)
./start-server.sh

# Start with only Gen 1 documentation
./start-server.sh --gen1

# Start with only Gen 2 documentation and force rebuild
./start-server.sh --gen2 --rebuild
```

The start script will automatically build the TypeScript code if needed.

### Using the Search Tool

The server provides a tool called `search_amplify_docs` that can be used to search the Amplify documentation.

Parameters:
- `query` (required): The search query string
- `page` (optional): Page number for pagination (default: 1)

Example:
```json
{
  "query": "authentication react",
  "page": 1
}
```

### Advanced Search Syntax

The search tool supports advanced search syntax:

- Use quotes for exact phrases: `"authentication flow"`
- Exclude terms with minus: `authentication -flutter`
- Use field-specific search: `title:authentication`
- Use wildcards: `auth*`
- Use boolean operators: `authentication AND (react OR javascript) NOT flutter`

## Configuration Options

The server can be configured using the `docs-mcp.config.json` file:

- `gitUrl`: URL of the Git repository to clone for documentation
- `gitRef`: Git branch or tag to checkout
- `autoUpdateInterval`: Interval in minutes to check for updates (0 to disable)
- `dataDir`: Directory to store documentation data
- `toolName`: Name of the search tool
- `toolDescription`: Description of the search tool
- `ignorePatterns`: Array of patterns to ignore when searching
- `amplifyGeneration`: Which Amplify documentation generation to include:
  - `"both"`: Include both Gen 1 and Gen 2 documentation (default)
  - `"gen1"`: Include only Gen 1 documentation (reduces disk space usage)
  - `"gen2"`: Include only Gen 2 documentation (reduces disk space usage)

## Development

### Project Structure

- `src/index.ts`: Main server implementation
- `src/config.ts`: Configuration loading and processing
- `src/git.ts`: Git repository management
- `src/cache.ts`: Search result caching
- `src/types/`: TypeScript type definitions
- `dist/`: Compiled JavaScript files

### Adding New Features

To add new features to the server:

1. Modify the appropriate file in the `src` directory
2. Test your changes using the test scripts
3. Update the documentation as needed

## License

This project is licensed under the MIT License - see the LICENSE file for details.
