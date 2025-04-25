#!/bin/bash

# Start the Amplify Docs MCP server
echo "Starting Amplify Docs MCP server..."

# Parse command line arguments
AMPLIFY_GEN="gen2"  # Default to Gen 2
REBUILD=false

# Process command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --gen)
      shift
      if [[ $1 == "1" || $1 == "gen1" ]]; then
        AMPLIFY_GEN="gen1"
      elif [[ $1 == "2" || $1 == "gen2" ]]; then
        AMPLIFY_GEN="gen2"
      elif [[ $1 == "both" ]]; then
        AMPLIFY_GEN="both"
      else
        echo "Invalid generation: $1"
        echo "Usage: $0 [--gen <1|2|both>] [--rebuild]"
        echo "  --gen 1: Include only Gen 1 documentation"
        echo "  --gen 2: Include only Gen 2 documentation"
        echo "  --gen both: Include both Gen 1 and Gen 2 documentation"
        echo "  --rebuild: Force rebuild of data directory"
        exit 1
      fi
      shift
      ;;
    --rebuild)
      REBUILD=true
      shift
      ;;
    *)
      # Unknown option
      echo "Unknown option: $1"
      echo "Usage: $0 [--gen <1|2|both>] [--rebuild]"
      echo "  --gen 1: Include only Gen 1 documentation"
      echo "  --gen 2: Include only Gen 2 documentation"
      echo "  --gen both: Include both Gen 1 and Gen 2 documentation"
      echo "  --rebuild: Force rebuild of data directory"
      exit 1
      ;;
  esac
done

# Check if the dist directory exists
if [ ! -d "dist" ]; then
  echo "Building TypeScript files..."
  npx tsc
fi

# If rebuild flag is set, remove the data directory
if [ "$REBUILD" = true ]; then
  echo "Rebuilding data directory..."
  rm -rf data
  # Ensure the data directory is removed before continuing
  if [ -d "data" ]; then
    echo "Failed to remove data directory. Please check permissions."
    exit 1
  fi
  echo "Data directory removed successfully."
  
  # Also remove the data directory from the config file's cache
  # This ensures the server will detect that it needs to clone the repository again
  CONFIG_FILE="docs-mcp.config.json"
  if [ -f "$CONFIG_FILE" ]; then
    # Create a temporary file with the updated configuration
    TMP_FILE=$(mktemp)
    # Replace either "both" or "gen2" with the new value
    cat "$CONFIG_FILE" | sed -E 's/"amplifyGeneration": "(both|gen1|gen2)"/"amplifyGeneration": "'$AMPLIFY_GEN'"/' > "$TMP_FILE"
    # Replace the original file with the updated one
    mv "$TMP_FILE" "$CONFIG_FILE"
    echo "Updated configuration file with amplifyGeneration: $AMPLIFY_GEN"
  fi
fi

# Run the server with the specified Amplify generation
echo "Using Amplify generation: $AMPLIFY_GEN"
node dist/index.js --amplifyGeneration=$AMPLIFY_GEN
