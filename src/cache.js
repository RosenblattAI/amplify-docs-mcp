import crypto from "crypto";
import fs from "fs-extra";
import path from "path";

/**
 * Simple file-based cache for search results
 */
export class SearchCache {
  /**
   * Create a new SearchCache
   * @param {string} cacheDir - Directory to store cache files
   */
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    fs.ensureDirSync(cacheDir);
  }

  /**
   * Generate a cache key from query and options
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {string} Cache key
   * @private
   */
  _generateKey(query, options) {
    // Create a deterministic string representation of the query and relevant options
    const keyObj = {
      query,
      path: options.path,
      maxTokens: options.maxTokens,
      skipTokens: options.skipTokens,
      semanticSearch: options.semanticSearch,
      fuzzyMatch: options.fuzzyMatch,
      includeCodeSnippets: options.includeCodeSnippets,
    };

    // Hash the key object to create a filename-safe key
    return crypto
      .createHash("md5")
      .update(JSON.stringify(keyObj))
      .digest("hex");
  }

  /**
   * Get cached search results
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Promise<string|null>} Cached results or null if not found
   */
  async get(query, options) {
    const key = this._generateKey(query, options);
    const cacheFile = path.join(this.cacheDir, `${key}.json`);

    try {
      if (fs.existsSync(cacheFile)) {
        const stats = fs.statSync(cacheFile);
        const ageInMinutes = (Date.now() - stats.mtime.getTime()) / (1000 * 60);

        // Cache expires after 24 hours
        if (ageInMinutes < 24 * 60) {
          const data = await fs.readFile(cacheFile, "utf-8");
          return data;
        }
      }
    } catch (error) {
      console.error(`Cache read error for ${key}:`, error);
    }

    return null;
  }

  /**
   * Store search results in cache
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @param {string} results - Search results
   * @returns {Promise<void>}
   */
  async set(query, options, results) {
    const key = this._generateKey(query, options);
    const cacheFile = path.join(this.cacheDir, `${key}.json`);

    try {
      await fs.writeFile(cacheFile, results);
    } catch (error) {
      console.error(`Cache write error for ${key}:`, error);
    }
  }

  /**
   * Clear the cache
   * @returns {Promise<void>}
   */
  async clear() {
    try {
      await fs.emptyDir(this.cacheDir);
    } catch (error) {
      console.error("Error clearing cache:", error);
    }
  }
}
