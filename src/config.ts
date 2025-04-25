import fs from 'fs-extra';
import minimist from 'minimist';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define the configuration interface
export interface Config {
  // Directory to include in the package (for static docs)
  includeDir: string | null;

  // Git repository URL (for dynamic docs)
  gitUrl: string;

  // Git branch or tag to checkout
  gitRef: string;

  // Auto-update interval in minutes (0 to disable)
  autoUpdateInterval: number;

  // Data directory for searching
  dataDir: string;

  // MCP Tool configuration
  toolName: string;
  toolDescription: string;

  // Ignore patterns
  ignorePatterns: string[];

  // Enable cleanup of large/binary files after build (default: true)
  enableBuildCleanup: boolean;

  // Amplify documentation generation to include: "gen1", "gen2", or "both"
  amplifyGeneration: string;
}

// Default configuration
const defaultConfig: Config = {
  // Directory to include in the package (for static docs)
  includeDir: null,

  // Git repository URL (for dynamic docs)
  gitUrl: 'https://github.com/aws-amplify/docs.git',

  // Git branch or tag to checkout
  gitRef: 'main',

  // Auto-update interval in minutes (0 to disable)
  autoUpdateInterval: 60, // Default to 60 minutes

  // Data directory for searching
  dataDir: path.resolve(__dirname, '..', 'data'),

  // MCP Tool configuration
  toolName: 'search_amplify_docs',
  toolDescription:
    'Search AWS Amplify documentation using the probe search engine.',

  // Ignore patterns
  ignorePatterns: [
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '.vitepress/cache',
    '*.jpg',
    '*.jpeg',
    '*.png',
    '*.gif',
    '*.svg',
    '*.mp4',
    '*.webm',
  ],
  // Enable cleanup of large/binary files after build (default: true)
  enableBuildCleanup: true,

  // Amplify documentation generation to include (default: gen2)
  amplifyGeneration: 'gen2',
};

/**
 * Load configuration from config file and environment variables
 * @returns {Config} Configuration object
 */
export function loadConfig(): Config {
  // Parse command line arguments
  const args = minimist(process.argv.slice(2));

  // Check for config file path in arguments
  const configPath =
    args.config || path.resolve(__dirname, '..', 'docs-mcp.config.json');

  let config: Config = { ...defaultConfig };

  // Load configuration from file if it exists
  if (fs.existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      config = { ...config, ...fileConfig };
      console.log(`Loaded configuration from ${configPath}`);
    } catch (error) {
      console.error(`Error loading configuration from ${configPath}:`, error);
    }
  } else {
    console.log(`No configuration file found at ${configPath}, using defaults`);
  }

  // Override with environment variables
  if (process.env.INCLUDE_DIR) config.includeDir = process.env.INCLUDE_DIR;
  if (process.env.GIT_URL) config.gitUrl = process.env.GIT_URL;
  if (process.env.GIT_REF) config.gitRef = process.env.GIT_REF;
  if (process.env.AUTO_UPDATE_INTERVAL)
    config.autoUpdateInterval = parseInt(process.env.AUTO_UPDATE_INTERVAL, 10);
  if (process.env.DATA_DIR) config.dataDir = process.env.DATA_DIR;
  if (process.env.TOOL_NAME) config.toolName = process.env.TOOL_NAME;
  if (process.env.TOOL_DESCRIPTION)
    config.toolDescription = process.env.TOOL_DESCRIPTION;
  if (process.env.AMPLIFY_GENERATION)
    config.amplifyGeneration = process.env.AMPLIFY_GENERATION;

  // Override with command line arguments
  if (args.includeDir) config.includeDir = args.includeDir;
  if (args.gitUrl) config.gitUrl = args.gitUrl;
  if (args.gitRef) config.gitRef = args.gitRef;
  if (args.autoUpdateInterval !== undefined)
    config.autoUpdateInterval = parseInt(args.autoUpdateInterval, 10);
  if (args.dataDir) config.dataDir = args.dataDir;
  if (args.toolName) config.toolName = args.toolName;
  if (args.toolDescription) config.toolDescription = args.toolDescription;
  if (args.enableBuildCleanup !== undefined)
    config.enableBuildCleanup =
      args.enableBuildCleanup === true || args.enableBuildCleanup === 'true';
  if (args.amplifyGeneration) config.amplifyGeneration = args.amplifyGeneration;

  // Ensure dataDir is an absolute path
  if (!path.isAbsolute(config.dataDir)) {
    config.dataDir = path.resolve(process.cwd(), config.dataDir);
  }

  // Ensure includeDir is an absolute path if provided
  if (config.includeDir && !path.isAbsolute(config.includeDir)) {
    config.includeDir = path.resolve(process.cwd(), config.includeDir);
  }

  return config;
}
