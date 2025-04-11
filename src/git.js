import axios from "axios";
import fs from "fs-extra";
import simpleGit from "simple-git";
import * as tar from "tar";

/**
 * Sets up the Git repository for the MCP server
 * @param {Object} config - Configuration object
 * @param {boolean} isUpdate - Whether this is an update check
 * @returns {Promise<void>}
 */
export async function setupGitRepo(config, isUpdate = false) {
  if (!config.gitUrl) {
    console.log("No Git URL specified. Skipping Git setup.");
    return;
  }

  try {
    // If auto-update is enabled, use Git clone/pull
    if (config.autoUpdateInterval > 0) {
      await setupWithGit(config, isUpdate);
    } else {
      // Otherwise, use tarball download for faster setup
      await setupWithTarball(config);
    }
  } catch (error) {
    console.error("Error setting up Git repository:", error);
    throw error;
  }
}

/**
 * Sets up the repository using Git clone/pull
 * @param {Object} config - Configuration object
 * @param {boolean} isUpdate - Whether this is an update check
 * @returns {Promise<void>}
 */
async function setupWithGit(config, isUpdate) {
  try {
    // Configure simple-git to use stderr for logging instead of stdout
    const git = simpleGit(config.dataDir, {
      binary: "git",
      maxConcurrentProcesses: 1,
    });

    // Disable console logging during Git operations to avoid EPIPE errors
    const originalConsoleLog = console.log;
    const safeLog = (message) => {
      try {
        originalConsoleLog(message);
      } catch (err) {
        // Ignore EPIPE errors
        if (err.code !== "EPIPE") {
          // Log to stderr which is less likely to cause EPIPE
          console.error(`[Git] ${message}`);
        }
      }
    };

    // Replace console.log temporarily
    console.log = safeLog;

    const isRepo = await git.checkIsRepo().catch(() => false);

    if (!isRepo) {
      if (isUpdate) {
        safeLog(
          `Directory ${config.dataDir} is not a Git repository. Cannot update.`
        );
        console.log = originalConsoleLog; // Restore console.log
        return;
      }

      safeLog(
        `Cloning ${config.gitUrl} (ref: ${config.gitRef}) to ${config.dataDir}...`
      );

      // Ensure directory is empty before cloning
      await fs.emptyDir(config.dataDir);

      try {
        // Clone the repository with reduced output
        await simpleGit({ baseDir: ".", binary: "git" }).clone(
          config.gitUrl,
          config.dataDir,
          [
            "--branch",
            config.gitRef,
            "--depth",
            "1",
            "--quiet", // Reduce output
          ]
        );
        safeLog(`Successfully cloned ${config.gitUrl} to ${config.dataDir}`);
      } catch (cloneError) {
        console.error(`Clone error: ${cloneError.message}`);
        // If clone fails, create an empty directory to allow the server to continue
        await fs.ensureDir(config.dataDir);
      }
    } else if (isUpdate) {
      safeLog(`Checking for updates in ${config.dataDir}...`);

      try {
        // Fetch updates quietly
        await git.fetch(["--quiet"]);

        // Check status
        const status = await git.status();

        if (status.behind > 0) {
          safeLog(
            `Local branch is ${status.behind} commits behind origin/${status.tracking}. Pulling updates...`
          );
          await git.pull("origin", config.gitRef, ["--quiet"]);
          safeLog("Documentation updated successfully.");
        } else {
          safeLog("Documentation is up-to-date.");
        }
      } catch (gitError) {
        console.error(`Git operation error: ${gitError.message}`);
      }
    } else {
      safeLog(
        `Directory ${config.dataDir} is already a Git repository. Skipping clone.`
      );
    }

    // Restore original console.log
    console.log = originalConsoleLog;
  } catch (error) {
    // Restore original console.log in case of error
    console.log = console.log || console.error;
    console.error(`Error in setupWithGit: ${error.message}`);
  }
}

/**
 * Sets up the repository using tarball download
 * @param {Object} config - Configuration object
 * @returns {Promise<void>}
 */
async function setupWithTarball(config) {
  // Basic parsing for GitHub URLs
  const match = config.gitUrl.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);
  if (!match) {
    console.error(
      `Cannot determine tarball URL from gitUrl: ${config.gitUrl}. Falling back to Git clone.`
    );
    await setupWithGit(config, false);
    return;
  }

  const owner = match[1];
  const repo = match[2];
  let ref = config.gitRef || "main";

  const downloadAttempt = async (currentRef) => {
    const tarballUrl = `https://github.com/${owner}/${repo}/archive/${currentRef}.tar.gz`;
    console.log(
      `Downloading archive from ${tarballUrl} to ${config.dataDir}...`
    );

    // Clear directory before extracting
    await fs.emptyDir(config.dataDir);

    const response = await axios({
      method: "get",
      url: tarballUrl,
      responseType: "stream",
      validateStatus: (status) => status >= 200 && status < 300,
    });

    // Pipe the download stream directly to tar extractor
    await new Promise((resolve, reject) => {
      response.data
        .pipe(
          tar.x({
            strip: 1, // Remove the top-level directory
            C: config.dataDir, // Extract to dataDir
          })
        )
        .on("finish", resolve)
        .on("error", reject);
    });
    console.log(
      `Successfully downloaded and extracted archive to ${config.dataDir}`
    );
  };

  try {
    await downloadAttempt(ref);
  } catch (error) {
    // Check if it was a 404 error and we tried 'main'
    if (ref === "main" && error.response && error.response.status === 404) {
      console.warn(
        `Download failed for ref 'main' (404). Retrying with 'master'...`
      );
      ref = "master";
      try {
        await downloadAttempt(ref);
      } catch (retryError) {
        console.error(`Retry with 'master' also failed: ${retryError.message}`);
        console.error("Falling back to Git clone...");
        await setupWithGit(config, false);
      }
    } else {
      console.error(
        `Error downloading or extracting tarball: ${error.message}`
      );
      console.error("Falling back to Git clone...");
      await setupWithGit(config, false);
    }
  }
}
