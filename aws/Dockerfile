# Multi-stage build for AWS ECS Fargate deployment
FROM node:18-alpine AS builder

# Install build dependencies for native modules
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Clear npm cache and install dependencies
RUN npm cache clean --force && \
    npm install --no-optional --production=false

# Copy source code
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY docs-mcp.config.json ./

# Build TypeScript
RUN npm run build

# Production stage  
FROM node:18-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache \
    git \
    curl \
    python3 \
    make \
    g++

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm cache clean --force && \
    npm install --only=production --no-optional && \
    npm cache clean --force

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/docs-mcp.config.json ./
COPY --from=builder /app/scripts ./scripts

# Create data directory for persistent storage mount
RUN mkdir -p /app/data && chmod 755 /app/data

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership of app directory
RUN chown -R nodejs:nodejs /app

USER nodejs

# Expose port for HTTP adapter
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start both MCP server and HTTP adapter
# Use a simple process manager or supervisor
COPY aws/start-services.sh ./
RUN chmod +x start-services.sh

CMD ["./start-services.sh"]