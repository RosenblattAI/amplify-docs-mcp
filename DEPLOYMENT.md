# Deployment Guide: Cloudflare Worker + MCP Server

This guide shows how to deploy the Amplify Documentation Search with a Cloudflare Worker wrapper for HTTP access while keeping the original MCP server functionality.

## Architecture Overview

```
Client (HTTP) → Cloudflare Worker → HTTP Adapter → MCP Server → AWS Amplify Docs
```

### Components

1. **MCP Server** (`src/index.ts`) - Original MCP protocol server
2. **HTTP Adapter** (`src/http-adapter.ts`) - Express.js server that wraps MCP functionality  
3. **Cloudflare Worker** (`worker-wrapper.js`) - Global edge proxy with caching

## Deployment Steps

### Step 1: Deploy the HTTP Adapter

The HTTP adapter needs to run on infrastructure that supports:
- Long-running Node.js processes
- File system access for Git repositories
- Network access for cloning repos

#### Option A: Railway (Recommended)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and initialize
railway login
railway init

# Deploy
railway up
```

Create `railway.json`:
```json
{
  "build": {
    "builder": "nixpacks"
  },
  "deploy": {
    "startCommand": "npm run build && npm run start:http",
    "healthcheckPath": "/health"
  }
}
```

#### Option B: Render

```yaml
# render.yaml
services:
  - type: web
    name: amplify-docs-mcp
    env: node
    buildCommand: npm run build
    startCommand: npm run start:http
    healthCheckPath: /health
    envVars:
      - key: PORT
        value: 10000
```

#### Option C: AWS ECS Fargate

Create `Dockerfile`:
```dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start HTTP adapter
CMD ["npm", "run", "start:http"]
```

### Step 2: Configure Environment Variables

Set these in your deployment platform:

```bash
# Optional: Custom data directory
DATA_DIR=/app/data

# Optional: Override git settings
GIT_URL=https://github.com/aws-amplify/docs.git
GIT_REF=main
AMPLIFY_GENERATION=gen2
AUTO_UPDATE_INTERVAL=60

# Production settings
NODE_ENV=production
PORT=3000
```

### Step 3: Deploy Cloudflare Worker

#### Install Wrangler CLI
```bash
npm install -g wrangler
wrangler auth login
```

#### Configure Secrets
```bash
# Set your HTTP adapter URL (from Step 1)
wrangler secret put MCP_SERVER_URL
# Enter: https://your-app.railway.app (or your deployment URL)

# Optional: Add authentication token
wrangler secret put MCP_SERVER_TOKEN
# Enter: your-secret-token
```

#### Deploy Worker
```bash
wrangler deploy
```

### Step 4: Test the Deployment

#### Test HTTP Adapter Directly
```bash
# Health check
curl https://your-app.railway.app/health

# Search test
curl -X POST https://your-app.railway.app/search \
  -H "Content-Type: application/json" \
  -d '{"query": "authentication setup", "maxResults": 3}'
```

#### Test Cloudflare Worker
```bash
# Via Worker (global edge)
curl -X POST https://amplify-docs-api.your-subdomain.workers.dev/search \
  -H "Content-Type: application/json" \
  -d '{"query": "authentication setup", "maxResults": 3}'

# GET request
curl "https://amplify-docs-api.your-subdomain.workers.dev/search?query=auth&maxResults=3"
```

## Usage Examples

### JavaScript/TypeScript
```typescript
const client = {
  baseURL: 'https://amplify-docs-api.your-subdomain.workers.dev',
  
  async search(query: string, options: any = {}) {
    const response = await fetch(`${this.baseURL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, ...options })
    });
    return response.json();
  }
};

// Usage
const results = await client.search('authentication gen2', {
  includeContent: true,
  maxResults: 5
});
```

### cURL Examples
```bash
# Basic search
curl "https://your-worker.workers.dev/search?query=authentication"

# Advanced search with content
curl -X POST https://your-worker.workers.dev/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "create api graphql",
    "includeContent": true,
    "maxResults": 10,
    "sessionId": "my-session-123"
  }'

# Boolean search
curl "https://your-worker.workers.dev/search?query=authentication%20AND%20(react%20OR%20javascript)%20NOT%20flutter"
```

## Performance & Scaling

### Cloudflare Worker Benefits
- **Global Edge**: <50ms response times worldwide
- **Caching**: Automatic caching at edge locations
- **DDoS Protection**: Built-in protection and rate limiting
- **Cost Effective**: $5/month for 10M requests

### HTTP Adapter Scaling
- **Railway**: Auto-scaling with usage-based pricing
- **Render**: Auto-scaling web services
- **ECS**: Configure auto-scaling groups

### Optimization Tips

1. **Enable Worker Caching**:
   ```javascript
   // In worker-wrapper.js
   headers: {
     'Cache-Control': 'public, max-age=300' // 5 minute cache
   }
   ```

2. **Use Session IDs**:
   ```javascript
   // For related searches to avoid duplicates
   { sessionId: 'user-session-123' }
   ```

3. **Optimize Queries**:
   ```javascript
   // Start broad, then narrow down
   { query: 'auth', filesOnly: true } // Get overview
   { query: 'authentication setup gen2', includeContent: true } // Get details
   ```

## Monitoring & Debugging

### Health Checks
```bash
# HTTP Adapter health
curl https://your-app.railway.app/health

# Worker health  
curl https://your-worker.workers.dev/health
```

### Logs
- **Railway**: `railway logs`
- **Render**: View in dashboard
- **Cloudflare**: `wrangler tail` or dashboard

### Common Issues

1. **Worker can't reach HTTP adapter**:
   - Check `MCP_SERVER_URL` secret
   - Verify HTTP adapter is running
   - Check firewall/network settings

2. **Search returns empty results**:
   - Verify documentation was cloned successfully
   - Check `/health` endpoint for git status
   - Review `DATA_DIR` contents

3. **High latency**:
   - Check Worker caching settings
   - Verify HTTP adapter deployment region
   - Consider using CDN for static assets

## Cost Estimation

### Monthly Costs (Approximate)
- **Cloudflare Worker**: $5/month (10M requests)
- **Railway HTTP Adapter**: $5-20/month (depending on usage)
- **Render HTTP Adapter**: $7-25/month
- **AWS ECS**: $10-50/month (depending on configuration)

**Total**: ~$10-70/month for global, high-performance documentation search

## Security Considerations

1. **Add Authentication** (Optional):
   ```typescript
   // In worker-wrapper.js
   const authToken = request.headers.get('Authorization');
   if (authToken !== `Bearer ${env.API_TOKEN}`) {
     return new Response('Unauthorized', { status: 401 });
   }
   ```

2. **Rate Limiting**:
   ```typescript
   // Use Cloudflare's built-in rate limiting
   // Or implement custom limits in the worker
   ```

3. **CORS Configuration**:
   ```typescript
   // Restrict origins in production
   'Access-Control-Allow-Origin': 'https://yourdomain.com'
   ```

This setup provides a scalable, globally distributed documentation search API while preserving the original MCP server functionality for direct MCP clients.