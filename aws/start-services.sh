#!/bin/sh

# Start script for ECS Fargate - runs both MCP server and HTTP adapter

echo "Starting Amplify Docs MCP Server on ECS Fargate..."
echo "Node version: $(node --version)"
echo "NPM version: $(npm --version)"

# Environment variables with defaults
export NODE_ENV=${NODE_ENV:-production}
export PORT=${PORT:-3000}
export DATA_DIR=${DATA_DIR:-/app/data}
export AMPLIFY_GENERATION=${AMPLIFY_GENERATION:-gen2}
export AUTO_UPDATE_INTERVAL=${AUTO_UPDATE_INTERVAL:-60}

echo "Environment:"
echo "  NODE_ENV: $NODE_ENV"
echo "  PORT: $PORT" 
echo "  DATA_DIR: $DATA_DIR"
echo "  AMPLIFY_GENERATION: $AMPLIFY_GENERATION"
echo "  AUTO_UPDATE_INTERVAL: $AUTO_UPDATE_INTERVAL"

# Ensure data directory exists and has correct permissions
mkdir -p "$DATA_DIR"
echo "Data directory ready: $DATA_DIR"

# Function to handle graceful shutdown
cleanup() {
    echo "Received shutdown signal, stopping services..."
    if [ ! -z "$HTTP_PID" ]; then
        kill $HTTP_PID 2>/dev/null
        wait $HTTP_PID 2>/dev/null
    fi
    if [ ! -z "$MCP_PID" ]; then
        kill $MCP_PID 2>/dev/null  
        wait $MCP_PID 2>/dev/null
    fi
    echo "Services stopped gracefully"
    exit 0
}

# Set up signal handlers
trap cleanup SIGTERM SIGINT

# Start HTTP adapter (primary service for ALB health checks)
echo "Starting HTTP adapter on port $PORT..."
node dist/http-adapter.js &
HTTP_PID=$!

# Wait a moment for HTTP adapter to start
sleep 2

# Verify HTTP adapter is running
if ! kill -0 $HTTP_PID 2>/dev/null; then
    echo "ERROR: HTTP adapter failed to start"
    exit 1
fi

echo "HTTP adapter started with PID $HTTP_PID"

# Start MCP server (for MCP clients)
echo "Starting MCP server..."
node dist/index.js &
MCP_PID=$!

# Wait a moment for MCP server to start  
sleep 2

# Verify MCP server is running
if ! kill -0 $MCP_PID 2>/dev/null; then
    echo "WARNING: MCP server failed to start, continuing with HTTP only"
    MCP_PID=""
else
    echo "MCP server started with PID $MCP_PID"
fi

echo "All services started successfully"
echo "HTTP API available at: http://localhost:$PORT"
echo "Health check endpoint: http://localhost:$PORT/health"

# Wait for services and handle failures
while true; do
    # Check if HTTP adapter is still running (critical for ALB)
    if ! kill -0 $HTTP_PID 2>/dev/null; then
        echo "ERROR: HTTP adapter stopped unexpectedly"
        exit 1
    fi
    
    # Check MCP server (non-critical)
    if [ ! -z "$MCP_PID" ] && ! kill -0 $MCP_PID 2>/dev/null; then
        echo "WARNING: MCP server stopped, continuing with HTTP only"
        MCP_PID=""
    fi
    
    sleep 5
done