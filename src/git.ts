import fs from 'fs-extra';
import path from 'path';
import * as simpleGitLib from 'simple-git';
import * as tar from 'tar';
import { Config } from './config.js';
import { Readable } from 'stream';

// Create a simpleGit function
const simpleGit = simpleGitLib.simpleGit;
type SimpleGit = simpleGitLib.SimpleGit;

/**
 * Sets up the Git repository for the MCP server
 * @param {Config} config - Configuration object
 * @param {boolean} isUpdate - Whether this is an update check
 * @returns {Promise<void>}
 */
export async function setupGitRepo(
  config: Config,
  isUpdate = false
): Promise<void> {
  if (!config.gitUrl) {
    console.log('No Git URL specified. Skipping Git setup.');
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
    console.error('Error setting up Git repository:', error);
    throw error;
  }
}

/**
 * Checks if a directory is empty
 * @param {string} dir - Directory to check
 * @returns {Promise<boolean>} - True if the directory is empty or doesn't exist
 */
async function isDirectoryEmpty(dir: string): Promise<boolean> {
  try {
    // Check if directory exists
    const exists = await fs.pathExists(dir);
    if (!exists) {
      return true; // Directory doesn't exist, consider it empty
    }

    const files = await fs.readdir(dir);
    return files.length === 0;
  } catch (error) {
    // If there's an error reading the directory, assume it's not empty
    return false;
  }
}

/**
 * Sets up the repository using Git clone/pull
 * @param {Config} config - Configuration object
 * @param {boolean} isUpdate - Whether this is an update check
 * @returns {Promise<void>}
 */
async function setupWithGit(config: Config, isUpdate: boolean): Promise<void> {
  try {
    // Configure simple-git to use stderr for logging instead of stdout
    const git: SimpleGit = simpleGit(config.dataDir, {
      binary: 'git',
      maxConcurrentProcesses: 1,
    });

    // Disable console logging during Git operations to avoid EPIPE errors
    const originalConsoleLog = console.log;
    const safeLog = (message: string): void => {
      try {
        originalConsoleLog(message);
      } catch (err: any) {
        // Ignore EPIPE errors
        if (err.code !== 'EPIPE') {
          // Log to stderr which is less likely to cause EPIPE
          console.error(`[Git] ${message}`);
        }
      }
    };

    // Replace console.log temporarily
    console.log = safeLog;

    // Check if directory is empty
    const isEmpty = await isDirectoryEmpty(config.dataDir);

    // Check if it's a git repository
    // First check if the directory exists
    const dirExists = await fs.pathExists(config.dataDir);

    // Then check if .git directory exists
    const gitDirExists =
      dirExists && (await fs.pathExists(path.join(config.dataDir, '.git')));

    // Finally check if it's a valid git repository
    const isRepo = gitDirExists && (await git.checkIsRepo().catch(() => false));

    if (!isRepo || isEmpty) {
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
        // Clone the full repository
        await simpleGit({ baseDir: '.', binary: 'git' }).clone(
          config.gitUrl,
          config.dataDir,
          [
            '--branch',
            config.gitRef,
            '--depth',
            '1',
            '--quiet', // Reduce output
          ]
        );
        safeLog(`Successfully cloned ${config.gitUrl} to ${config.dataDir}`);

        // Clean up directories based on the selected generation
        if (config.amplifyGeneration === 'gen1') {
          safeLog('Cleaning up Gen 2 documentation files');

          // Clean up Gen 2 paths if they exist
          const platformDir = path.join(
            config.dataDir,
            'src',
            'pages',
            '[platform]'
          );
          if (await fs.pathExists(platformDir)) {
            safeLog(`Removing Gen 2 documentation path: ${platformDir}`);
            await fs.remove(platformDir);
          }

          // Clean up Gen 2 fragments if they exist
          const gen2FragmentsDir = path.join(
            config.dataDir,
            'src',
            'fragments',
            'gen2'
          );
          if (await fs.pathExists(gen2FragmentsDir)) {
            safeLog(`Removing Gen 2 fragments directory: ${gen2FragmentsDir}`);
            await fs.remove(gen2FragmentsDir);
          }
        } else if (config.amplifyGeneration === 'gen2') {
          safeLog('Cleaning up Gen 1 documentation files');

          // Clean up Gen 1 paths if they exist
          const gen1Dir = path.join(config.dataDir, 'src', 'pages', 'gen1');
          if (await fs.pathExists(gen1Dir)) {
            safeLog(`Removing Gen 1 documentation path: ${gen1Dir}`);
            await fs.remove(gen1Dir);
          }

          // For Gen 2, we need to keep only the gen2 fragments directory and remove all other fragments
          const fragmentsDir = path.join(config.dataDir, 'src', 'fragments');
          safeLog(`Checking fragments directory: ${fragmentsDir}`);
          if (await fs.pathExists(fragmentsDir)) {
            safeLog(
              `Fragments directory exists, cleaning up non-gen2 directories`
            );
            // Get all directories in the fragments directory
            const fragmentDirs = await fs.readdir(fragmentsDir);
            safeLog(
              `Found ${
                fragmentDirs.length
              } directories in fragments: ${fragmentDirs.join(', ')}`
            );

            // Keep only the gen2 directory and remove all others
            for (const dir of fragmentDirs) {
              if (dir !== 'gen2') {
                const dirPath = path.join(fragmentsDir, dir);
                const isDirectory = (await fs.stat(dirPath)).isDirectory();
                if (isDirectory) {
                  safeLog(`Removing fragments directory: ${dirPath}`);
                  try {
                    await fs.remove(dirPath);
                    safeLog(`Successfully removed: ${dirPath}`);
                  } catch (error: any) {
                    safeLog(
                      `Error removing directory ${dirPath}: ${error.message}`
                    );
                  }
                }
              }
            }

            // Verify the cleanup
            const remainingDirs = await fs.readdir(fragmentsDir);
            safeLog(
              `After cleanup, remaining directories: ${remainingDirs.join(
                ', '
              )}`
            );
          } else {
            safeLog(`Fragments directory does not exist: ${fragmentsDir}`);
          }
        }
      } catch (cloneError) {
        console.error(`Clone error: ${(cloneError as Error).message}`);
        // If clone fails, create an empty directory to allow the server to continue
        await fs.ensureDir(config.dataDir);
      }
    } else if (isUpdate) {
      safeLog(`Checking for updates in ${config.dataDir}...`);

      try {
        // Fetch updates quietly
        await git.fetch(['--quiet']);

        // Check status
        const status = await git.status();

        if (status.behind > 0) {
          safeLog(
            `Local branch is ${status.behind} commits behind origin/${status.tracking}. Pulling updates...`
          );
          await git.pull('origin', config.gitRef, ['--quiet']);
          safeLog('Documentation updated successfully.');
        } else {
          safeLog('Documentation is up-to-date.');
        }
      } catch (gitError) {
        console.error(`Git operation error: ${(gitError as Error).message}`);
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
    console.error(`Error in setupWithGit: ${(error as Error).message}`);
  }
}

/**
 * Sets up the repository using tarball download
 * @param {Config} config - Configuration object
 * @returns {Promise<void>}
 */
async function setupWithTarball(config: Config): Promise<void> {
  // Check if directory is empty
  const isEmpty = await isDirectoryEmpty(config.dataDir);

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
  let ref = config.gitRef || 'main';

  const downloadAttempt = async (currentRef: string): Promise<void> => {
    const tarballUrl = `https://github.com/${owner}/${repo}/archive/${currentRef}.tar.gz`;
    console.log(
      `Downloading archive from ${tarballUrl} to ${config.dataDir}...`
    );

    // Clear directory before extracting
    await fs.emptyDir(config.dataDir);

    try {
      const response = await fetch(tarballUrl);

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      // Convert the ReadableStream to a Node.js Readable stream
      const responseStream = Readable.fromWeb(response.body as any);

      // Pipe the download stream directly to tar extractor
      await new Promise<void>((resolve, reject) => {
        responseStream
          .pipe(
            tar.x({
              strip: 1, // Remove the top-level directory
              C: config.dataDir, // Extract to dataDir
            })
          )
          .on('finish', () => resolve())
          .on('error', reject);
      });
    } catch (error) {
      throw new Error(
        `Failed to download tarball: ${(error as Error).message}`
      );
    }
    console.log(
      `Successfully downloaded and extracted archive to ${config.dataDir}`
    );
  };

  try {
    await downloadAttempt(ref);
  } catch (error: any) {
    // Check if it was a 404 error and we tried 'main'
    if (ref === 'main' && error.message.includes('Status: 404')) {
      console.warn(
        `Download failed for ref 'main' (404). Retrying with 'master'...`
      );
      ref = 'master';
      try {
        await downloadAttempt(ref);
      } catch (retryError: any) {
        console.error(`Retry with 'master' also failed: ${retryError.message}`);
        console.error('Falling back to Git clone...');
        await setupWithGit(config, false);
      }
    } else {
      // Check if it's a disk space error
      const errorMessage = error.message.toLowerCase();
      if (errorMessage.includes('no space left on device')) {
        console.error('ERROR: Not enough disk space to download the tarball.');
        console.error('Please free up some disk space and try again.');
        console.error('Creating a minimal documentation placeholder...');

        // Create an empty README to indicate the issue
        await fs.ensureDir(config.dataDir);
        await fs.writeFile(
          path.join(config.dataDir, 'README.md'),
          '# Documentation Download Failed\n\nFailed to download documentation due to disk space issues.\nPlease free up disk space and run the build again.'
        );
      } else {
        console.error(
          `Error downloading or extracting tarball: ${error.message}`
        );
        console.error('Falling back to Git clone...');
        try {
          await setupWithGit(config, false);
        } catch (gitError: any) {
          // If Git clone also fails, create a placeholder
          console.error(
            'Git clone fallback also failed. Creating placeholder documentation.'
          );
          await fs.ensureDir(config.dataDir);
          await fs.writeFile(
            path.join(config.dataDir, 'README.md'),
            '# Documentation Download Failed\n\nFailed to download documentation.\nError: ' +
              error.message
          );
        }
      }
    }
  }
}
