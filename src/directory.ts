import fs from "fs-extra";
import path from "path";

/**
 * Interface for a node in the directory structure
 */
export interface PageNode {
  path: string;
  children?: PageNode[];
  isExternal?: boolean;
  route?: string;
  title?: string;
  description?: string;
  platforms?: string[];
}

/**
 * Class to handle the directory structure
 */
export class DirectoryManager {
  private directory: PageNode | null = null;
  private directoryPath: string;
  private flattenedPaths: Map<string, PageNode> = new Map();
  private platformPaths: Map<string, PageNode[]> = new Map();
  private gen1Paths: string[] = [];
  private gen2Paths: string[] = [];

  /**
   * Create a new DirectoryManager
   * @param {string} dataDir - Data directory
   */
  constructor(dataDir: string) {
    this.directoryPath = path.join(
      dataDir,
      "src",
      "directory",
      "directory.mjs"
    );
  }

  /**
   * Load the directory structure
   * @returns {Promise<boolean>} True if successful
   */
  async load(): Promise<boolean> {
    try {
      if (!fs.existsSync(this.directoryPath)) {
        console.log(`Directory file not found: ${this.directoryPath}`);
        return false;
      }

      // Read the directory file
      const content = await fs.readFile(this.directoryPath, "utf-8");

      // Extract the directory object using regex
      const directoryMatch = content.match(
        /export const directory = ({[\s\S]*});/
      );
      if (!directoryMatch || !directoryMatch[1]) {
        console.log("Could not extract directory object from file");
        return false;
      }

      // Parse the directory object
      try {
        // Instead of trying to parse the complex structure as JSON,
        // we'll use a simpler approach to extract the paths
        console.log(
          "Using regex-based path extraction instead of JSON parsing"
        );

        // Extract all paths using regex
        const pathRegex = /path:\s*['"]([^'"]+)['"]/g;
        let match;
        const paths: string[] = [];

        while ((match = pathRegex.exec(content)) !== null) {
          paths.push(match[1]);
        }

        console.log(`Extracted ${paths.length} paths from directory structure`);

        // Create a simplified directory structure
        this.directory = {
          path: "src/pages/index.tsx",
          children: paths.map((p) => ({ path: p })),
        };

        // Process the directory structure
        this.processDirectory();
        return true;
      } catch (parseError) {
        console.error("Error parsing directory object:", parseError);
        return false;
      }
    } catch (error) {
      console.error("Error loading directory structure:", error);
      return false;
    }
  }

  /**
   * Process the directory structure to build lookup maps
   * @private
   */
  private processDirectory(): void {
    if (!this.directory) return;

    // Flatten the directory structure
    this.flattenDirectory(this.directory);

    // Identify Gen1 and Gen2 paths
    this.categorizeGenPaths();

    console.log(
      `Processed ${this.flattenedPaths.size} paths in directory structure`
    );
    console.log(
      `Found ${this.gen1Paths.length} Gen1 paths and ${this.gen2Paths.length} Gen2 paths`
    );
  }

  /**
   * Flatten the directory structure
   * @param {PageNode} node - Current node
   * @param {string[]} parentPlatforms - Parent platforms
   * @private
   */
  private flattenDirectory(
    node: PageNode,
    parentPlatforms: string[] = []
  ): void {
    // Add the node to the flattened paths
    this.flattenedPaths.set(node.path, node);

    // Add the node to the platform paths
    const platforms = node.platforms || parentPlatforms;
    if (platforms && platforms.length > 0) {
      for (const platform of platforms) {
        if (!this.platformPaths.has(platform)) {
          this.platformPaths.set(platform, []);
        }
        this.platformPaths.get(platform)!.push(node);
      }
    }

    // Process children
    if (node.children) {
      for (const child of node.children) {
        this.flattenDirectory(child, platforms);
      }
    }
  }

  /**
   * Categorize paths as Gen1 or Gen2
   * @private
   */
  private categorizeGenPaths(): void {
    for (const [nodePath, node] of this.flattenedPaths.entries()) {
      if (nodePath.includes("gen1/") || nodePath.includes("/gen1/")) {
        this.gen1Paths.push(nodePath);
      } else if (
        nodePath.includes("[platform]/") &&
        !nodePath.includes("gen1/") &&
        !nodePath.includes("/gen1/")
      ) {
        this.gen2Paths.push(nodePath);
      }
    }
  }

  /**
   * Get paths that match a query
   * @param {string} query - Search query
   * @param {string} generation - Generation to filter by ("gen1", "gen2", or "both")
   * @returns {string[]} Matching paths
   */
  getMatchingPaths(query: string, generation: string = "both"): string[] {
    if (!this.directory) return [];

    const queryLower = query.toLowerCase();
    const queryTerms = queryLower
      .split(/\s+/)
      .filter((term) => term.length > 2);

    // Filter paths based on generation
    const pathsToSearch =
      generation === "gen1"
        ? this.gen1Paths
        : generation === "gen2"
        ? this.gen2Paths
        : [...this.gen1Paths, ...this.gen2Paths];

    // Find paths that match the query
    const matchingPaths = pathsToSearch.filter((nodePath) => {
      // Check if any query term is in the path
      return queryTerms.some((term) => nodePath.toLowerCase().includes(term));
    });

    return matchingPaths;
  }

  /**
   * Get paths for a specific platform
   * @param {string} platform - Platform to filter by
   * @param {string} generation - Generation to filter by ("gen1", "gen2", or "both")
   * @returns {string[]} Platform paths
   */
  getPlatformPaths(platform: string, generation: string = "both"): string[] {
    if (!this.platformPaths.has(platform)) return [];

    const platformNodes = this.platformPaths.get(platform)!;

    // Filter paths based on generation
    return platformNodes
      .map((node) => node.path)
      .filter((nodePath) => {
        if (generation === "gen1") {
          return nodePath.includes("gen1/") || nodePath.includes("/gen1/");
        } else if (generation === "gen2") {
          return !nodePath.includes("gen1/") && !nodePath.includes("/gen1/");
        }
        return true;
      });
  }

  /**
   * Check if a path is likely to be relevant for a query
   * @param {string} filePath - File path to check
   * @param {string} query - Search query
   * @returns {boolean} True if the path is likely relevant
   */
  isPathRelevantForQuery(filePath: string, query: string): boolean {
    // If we don't have a directory structure, consider all paths relevant
    if (!this.directory) return true;

    const queryLower = query.toLowerCase();
    const queryTerms = queryLower
      .split(/\s+/)
      .filter((term) => term.length > 2);

    // Check if the query mentions a specific generation
    const mentionsGen1 =
      queryLower.includes("gen1") || queryLower.includes("gen 1");
    const mentionsGen2 =
      queryLower.includes("gen2") || queryLower.includes("gen 2");

    // If the query mentions a specific generation, filter accordingly
    if (mentionsGen1 && !mentionsGen2) {
      if (!filePath.includes("gen1/") && !filePath.includes("/gen1/")) {
        return false;
      }
    } else if (mentionsGen2 && !mentionsGen1) {
      if (filePath.includes("gen1/") || filePath.includes("/gen1/")) {
        return false;
      }
    }

    // Check if any query term is in the path
    return queryTerms.some((term) => filePath.toLowerCase().includes(term));
  }

  /**
   * Get the directory structure
   * @returns {PageNode|null} Directory structure
   */
  getDirectory(): PageNode | null {
    return this.directory;
  }

  /**
   * Get all flattened paths
   * @returns {Map<string, PageNode>} Flattened paths
   */
  getFlattenedPaths(): Map<string, PageNode> {
    return this.flattenedPaths;
  }

  /**
   * Get Gen1 paths
   * @returns {string[]} Gen1 paths
   */
  getGen1Paths(): string[] {
    return this.gen1Paths;
  }

  /**
   * Get Gen2 paths
   * @returns {string[]} Gen2 paths
   */
  getGen2Paths(): string[] {
    return this.gen2Paths;
  }
}
