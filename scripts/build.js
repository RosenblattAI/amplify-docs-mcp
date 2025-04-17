#!/usr/bin/env node
import axios from "axios"; // Import axios
import fs from "fs-extra";
import { glob } from "glob";
import path from "path";
import simpleGit from "simple-git";
import * as tar from "tar"; // Import tar using namespace
import { fileURLToPath } from "url";
import { loadConfig } from "../dist/config.js";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

// Load configuration
const config = loadConfig();

// Directory to store documentation files
const dataDir = config.dataDir; // Use configured data directory

/**
 * Check if a directory is empty
 * @param {string} dir - Directory to check
 * @returns {Promise<boolean>} - True if the directory is empty
 */
async function isDirectoryEmpty(dir) {
  try {
    const files = await fs.readdir(dir);
    return files.length === 0;
  } catch (error) {
    // If there's an error reading the directory, assume it's not empty
    return false;
  }
}

/**
 * Prepare the data directory by either copying static files or cloning a Git repo.
 */
async function prepareDataDir() {
  console.log("Building docs-mcp package...");

  // Create data directory if it doesn't exist
  await fs.ensureDir(dataDir);

  // Check if the data directory is empty
  const isEmpty = await isDirectoryEmpty(dataDir);

  // Check if the data directory is already a Git repository
  const isGitRepo = await isGitRepository(dataDir);

  if (config.gitUrl) {
    // Check if we should use Git clone or download tarball
    if (config.autoUpdateInterval > 0) {
      console.log(
        `Auto-update enabled (interval: ${config.autoUpdateInterval} mins). Using git clone.`
      );

      if (isGitRepo && !isEmpty) {
        // If it's already a Git repository and not empty, just pull the latest changes
        await updateGitRepo();
      } else {
        // If not a Git repository or the directory is empty, clear the directory and clone
        console.log(
          `Data directory ${
            isEmpty ? "is empty" : "is not a Git repository"
          }. Cloning repository...`
        );
        await fs.emptyDir(dataDir);
        await cloneGitRepo();
      }
    } else {
      console.log(
        "Auto-update disabled. Attempting to download tarball archive."
      );
      // For tarball download, we still need to clear the directory
      await fs.emptyDir(dataDir);
      await downloadAndExtractTarball();
    }
  } else if (config.includeDir) {
    // For copying included directory, clear the target directory first
    await fs.emptyDir(dataDir);
    await copyIncludedDir();
  } else {
    console.log(
      "No includeDir or gitUrl specified. Created empty data directory."
    );
  }

  // Note: Build completion message moved to the main build function after cleanup
}

/**
 * Check if a directory is a Git repository
 * @param {string} dir - Directory to check
 * @returns {Promise<boolean>} - True if the directory is a Git repository
 */
async function isGitRepository(dir) {
  try {
    // Check if directory exists first
    if (!(await fs.pathExists(dir))) {
      return false;
    }

    // Check if .git directory exists
    const gitDir = path.join(dir, ".git");
    if (!(await fs.pathExists(gitDir))) {
      return false;
    }

    // Double-check with git command
    const git = simpleGit(dir);
    return await git.checkIsRepo();
  } catch (error) {
    return false;
  }
}

/**
 * Update an existing Git repository
 */
async function updateGitRepo() {
  console.log(`Git repository already exists at ${dataDir}. Updating...`);
  const git = simpleGit(dataDir);

  try {
    // Fetch updates
    await git.fetch();

    // Check status
    const status = await git.status();

    if (status.behind > 0) {
      console.log(
        `Local branch is ${status.behind} commits behind. Pulling updates...`
      );
      await git.pull("origin", config.gitRef);
      console.log("Repository updated successfully.");
    } else {
      console.log("Repository is already up-to-date. Skipping clone.");
    }
  } catch (error) {
    console.error(`Error updating Git repository:`, error);
    throw error;
  }
}

/**
 * Clone the Git repository to the data directory.
 */
async function cloneGitRepo() {
  console.log(
    `Cloning Git repository ${config.gitUrl} (ref: ${config.gitRef}) to ${dataDir}...`
  );
  const git = simpleGit();

  try {
    // Check if we need to use sparse checkout based on amplifyGeneration setting
    if (config.amplifyGeneration !== "both") {
      console.log(
        `Using sparse checkout for Amplify ${config.amplifyGeneration} documentation only.`
      );

      // Clone the full repository
      await git.clone(config.gitUrl, dataDir, [
        "--branch",
        config.gitRef,
        "--depth",
        "1",
      ]);

      // Set up sparse checkout patterns based on the selected generation
      const sparseGit = simpleGit(dataDir);

      // Create sparse checkout pattern file
      let sparseCheckoutContent = "";

      // Common files to include regardless of generation
      sparseCheckoutContent += "README.md\n";
      sparseCheckoutContent += "package.json\n";
      sparseCheckoutContent += "tsconfig.json\n";
      sparseCheckoutContent += ".vitepress/config.ts\n";
      sparseCheckoutContent += "src/components/\n";
      sparseCheckoutContent += "src/utils/\n";

      // Generation-specific patterns
      if (config.amplifyGeneration === "gen1") {
        console.log("Including only Gen 1 documentation files");
        sparseCheckoutContent += "src/pages/gen1/\n";
        sparseCheckoutContent += "src/fragments/gen1/\n";

        // Clean up Gen 2 paths if they exist
        const platformDir = path.join(dataDir, "src", "pages", "[platform]");
        if (fs.existsSync(platformDir)) {
          console.log(`Cleaning up Gen 2 documentation path: ${platformDir}`);
          fs.removeSync(platformDir);
        }

        // Clean up Gen 2 fragments if they exist
        const gen2FragmentsDir = path.join(dataDir, "src", "fragments", "gen2");
        if (fs.existsSync(gen2FragmentsDir)) {
          console.log(
            `Removing Gen 2 fragments directory: ${gen2FragmentsDir}`
          );
          fs.removeSync(gen2FragmentsDir);
        }
      } else if (config.amplifyGeneration === "gen2") {
        console.log("Including only Gen 2 documentation files");
        // Use a wildcard pattern to match the [platform] directory
        sparseCheckoutContent += "src/pages/*/\n";
        sparseCheckoutContent += "src/fragments/gen2/\n";

        // Clean up Gen 1 paths if they exist
        const gen1Dir = path.join(dataDir, "src", "pages", "gen1");
        if (fs.existsSync(gen1Dir)) {
          console.log(`Cleaning up Gen 1 documentation path: ${gen1Dir}`);
          fs.removeSync(gen1Dir);
        }

        // For Gen 2, we need to keep only the gen2 fragments directory and remove all others
        const fragmentsDir = path.join(dataDir, "src", "fragments");
        if (fs.existsSync(fragmentsDir)) {
          // Get all directories in the fragments directory
          const fragmentDirs = fs.readdirSync(fragmentsDir);

          // Keep only the gen2 directory and remove all others
          for (const dir of fragmentDirs) {
            if (dir !== "gen2") {
              const dirPath = path.join(fragmentsDir, dir);
              const isDirectory = fs.statSync(dirPath).isDirectory();
              if (isDirectory) {
                console.log(`Removing fragments directory: ${dirPath}`);
                fs.removeSync(dirPath);
              }
            }
          }
        }
      }

      // Write the sparse checkout patterns to the git config
      await sparseGit.raw(["sparse-checkout", "init"]);
      const sparseCheckoutPath = path.join(
        dataDir,
        ".git",
        "info",
        "sparse-checkout"
      );
      await fs.writeFile(sparseCheckoutPath, sparseCheckoutContent);
      await sparseGit.raw(["checkout"]);

      console.log(
        `Successfully cloned repository with ${config.amplifyGeneration} documentation to ${dataDir}`
      );
    } else {
      // Clone the full repository
      await git.clone(config.gitUrl, dataDir, [
        "--branch",
        config.gitRef,
        "--depth",
        "1",
      ]);
      console.log(`Successfully cloned repository to ${dataDir}`);
    }
  } catch (error) {
    console.error(`Error cloning Git repository:`, error);

    // Check if it's a disk space error
    const errorMessage = error.toString().toLowerCase();
    if (errorMessage.includes("no space left on device")) {
      console.error("ERROR: Not enough disk space to clone the repository.");
      console.error("Please free up some disk space and try again.");
      console.error(
        "Attempting to download a minimal subset of documentation..."
      );

      try {
        // Try to download just the markdown files which are typically smaller
        await git.clone(config.gitUrl, dataDir, [
          "--branch",
          config.gitRef,
          "--depth",
          "1",
          "--filter=blob:none", // Don't download blob objects (binary files)
          "--sparse", // Enable sparse checkout
        ]);

        // Set up sparse checkout to only get markdown files
        const sparseGit = simpleGit(dataDir);
        await sparseGit.raw(["sparse-checkout", "set", "**/*.md", "**/*.mdx"]);
        await sparseGit.raw(["checkout"]);

        console.log("Successfully downloaded minimal documentation subset.");
      } catch (sparseError) {
        console.error("Failed to download minimal documentation:", sparseError);
        console.error(
          "Creating empty data directory to allow server to start."
        );
        // Create an empty README to indicate the issue
        await fs.ensureDir(dataDir);
        await fs.writeFile(
          path.join(dataDir, "README.md"),
          "# Documentation Download Failed\n\nFailed to download documentation due to disk space issues.\nPlease free up disk space and run the build again."
        );
      }
    } else {
      // For other errors, create an empty directory with a README
      console.error("Creating empty data directory to allow server to start.");
      await fs.ensureDir(dataDir);
      await fs.writeFile(
        path.join(dataDir, "README.md"),
        "# Documentation Download Failed\n\nFailed to download documentation.\nError: " +
          error.message
      );

      // Don't re-throw the error to allow the server to start with minimal docs
    }
  }
}

/**
 * Copy included directory to the data directory.
 */
async function copyIncludedDir() {
  console.log(`Copying ${config.includeDir} to ${dataDir}...`);

  try {
    // Get all files in the directory, respecting .gitignore
    const files = await glob("**/*", {
      cwd: config.includeDir,
      nodir: true,
      ignore: config.ignorePatterns,
      dot: true,
      gitignore: true, // This will respect .gitignore files
    });

    console.log(
      `Found ${files.length} files in ${config.includeDir} (respecting .gitignore)`
    );

    // Copy each file
    for (const file of files) {
      const sourcePath = path.join(config.includeDir, file);
      const targetPath = path.join(dataDir, file);

      // Ensure the target directory exists
      await fs.ensureDir(path.dirname(targetPath));

      // Copy the file
      await fs.copy(sourcePath, targetPath);
    }

    console.log(`Successfully copied ${files.length} files to ${dataDir}`);
  } catch (error) {
    console.error(`Error copying ${config.includeDir}:`, error);
    throw error; // Re-throw to stop the build
  }
}

/**
 * Downloads and extracts a tarball archive from a Git repository URL.
 * Assumes GitHub URL structure for archive download.
 */
async function downloadAndExtractTarball() {
  // Basic parsing for GitHub URLs (can be made more robust)
  const match = config.gitUrl.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);
  if (!match) {
    console.error(
      `Cannot determine tarball URL from gitUrl: ${config.gitUrl}. Falling back to git clone.`
    );
    // Fallback to clone if URL parsing fails or isn't GitHub
    await cloneGitRepo();
    return;
  }

  const owner = match[1];
  const repo = match[2];
  let ref = config.gitRef || "main"; // Start with configured ref or default 'main'

  const downloadAttempt = async (currentRef) => {
    const tarballUrl = `https://github.com/${owner}/${repo}/archive/${currentRef}.tar.gz`;
    console.log(
      `Attempting to download archive (${currentRef}) from ${tarballUrl} to ${dataDir}...`
    );

    const response = await axios({
      method: "get",
      url: tarballUrl,
      responseType: "stream",
      validateStatus: (status) => status >= 200 && status < 300, // Don't throw for non-2xx
    });

    // Pipe the download stream directly to tar extractor
    await new Promise((resolve, reject) => {
      response.data
        .pipe(
          tar.x({
            strip: 1, // Remove the top-level directory
            C: dataDir, // Extract to dataDir
          })
        )
        .on("finish", resolve)
        .on("error", reject);
    });
    console.log(
      `Successfully downloaded and extracted archive (${currentRef}) to ${dataDir}`
    );
  };

  try {
    // Outer try block (starts line 150 in previous read)
    await downloadAttempt(ref);
  } catch (error) {
    // Check if it was a 404 error and we tried 'main'
    if (ref === "main" && error.response && error.response.status === 404) {
      console.warn(
        `Download failed for ref 'main' (404). Retrying with 'master'...`
      );
      ref = "master"; // Set ref to master for the retry
      try {
        // Inner try block for master retry (starts line 157 in previous read)
        await downloadAttempt(ref);
      } catch (retryError) {
        console.error(`Retry with 'master' also failed: ${retryError.message}`);
        console.error("Falling back to git clone...");
        await fallbackToClone(); // Use a separate function for fallback
      } // End of inner try block for master retry
    } else {
      // This else belongs to the outer try/catch (line 150)
      // Handle other errors (non-404 on 'main', or any error on 'master' or specific ref)
      console.error(
        `Error downloading or extracting tarball (${ref}): ${error.message}`
      );
      console.error("Falling back to git clone...");
      await fallbackToClone(); // Use a separate function for fallback
    }
  } // End of outer try block (starting line 150)
}

// Helper function for fallback logic
async function fallbackToClone() {
  try {
    await cloneGitRepo();
  } catch (cloneError) {
    console.error(`Fallback git clone failed:`, cloneError);
    throw cloneError; // Re-throw the clone error if fallback fails
  }
}

/**
 * Cleans up the data directory by removing large files and common binary/media types.
 * Also removes the .git directory to avoid tracking changes.
 */
async function cleanupDataDir() {
  console.log(`Cleaning up data directory: ${dataDir}...`);

  // Remove .git directory first
  const gitDir = path.join(dataDir, ".git");
  if (fs.existsSync(gitDir)) {
    console.log(`Removing .git directory: ${gitDir}`);
    try {
      await fs.remove(gitDir);
      console.log(`.git directory removed successfully`);
    } catch (error) {
      console.error(`Error removing .git directory: ${error.message}`);
    }
  }

  const files = await glob("**/*", {
    cwd: dataDir,
    nodir: true,
    dot: true,
    absolute: true,
  });
  let removedCount = 0;
  const maxSize = 100 * 1024; // 100 KB
  const forbiddenExtensions = new Set([
    // Images
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".bmp",
    ".tiff",
    ".webp",
    ".svg",
    ".ico",
    // Videos
    ".mp4",
    ".mov",
    ".avi",
    ".wmv",
    ".mkv",
    ".flv",
    ".webm",
    // Audio
    ".mp3",
    ".wav",
    ".ogg",
    ".aac",
    ".flac",
    // Archives
    ".zip",
    ".tar",
    ".gz",
    ".bz2",
    ".rar",
    ".7z",
    // Documents (often large or binary)
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    // Executables / Libraries
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".app",
    // Other potentially large/binary
    ".psd",
    ".ai",
    ".iso",
    ".dmg",
    ".pkg",
    ".deb",
    ".rpm",
  ]);

  for (const file of files) {
    try {
      const stats = await fs.stat(file);
      const ext = path.extname(file).toLowerCase();

      if (forbiddenExtensions.has(ext) || stats.size > maxSize) {
        console.log(
          `Removing: ${file} (Size: ${stats.size} bytes, Ext: ${ext})`
        );
        await fs.remove(file);
        removedCount++;
      }
    } catch (error) {
      // Ignore errors for files that might disappear during iteration (e.g., broken symlinks)
      if (error.code !== "ENOENT") {
        console.warn(
          `Could not process file ${file} during cleanup: ${error.message}`
        );
      }
    }
  }
  console.log(`Cleanup complete. Removed ${removedCount} files.`);
}

/**
 * Create a default configuration file if it doesn't exist.
 */
async function createDefaultConfig() {
  const configPath = path.join(rootDir, "docs-mcp.config.json");

  if (!fs.existsSync(configPath)) {
    const defaultConfig = {
      includeDir: null,
      gitUrl: null,
      gitRef: "main",
      autoUpdateInterval: 0, // Default changed previously
      enableBuildCleanup: true, // Added previously
      ignorePatterns: ["node_modules", ".git", "dist", "build", "coverage"],
    };

    await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));
    console.log(`Created default configuration file at ${configPath}`);
  }
}

// Run the build process
async function build() {
  try {
    await createDefaultConfig();
    await prepareDataDir();

    // Perform cleanup if enabled
    if (config.enableBuildCleanup) {
      await cleanupDataDir();
    } else {
      console.log("Build cleanup is disabled via configuration.");
    }

    // Make the bin script executable
    const binPath = path.join(rootDir, "bin", "mcp");
    await fs.chmod(binPath, 0o755);
    console.log(`Made bin script executable: ${binPath}`);

    console.log("Build process finished successfully!"); // Moved completion message here
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

build();
