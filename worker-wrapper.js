/**
 * Cloudflare Worker wrapper for MCP Amplify Docs Server
 * 
 * This worker acts as an HTTP-to-MCP bridge, allowing HTTP clients
 * to query the MCP server running on traditional infrastructure.
 */

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    try {
      const url = new URL(request.url);
      
      // Health check endpoint
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ 
          status: 'healthy', 
          timestamp: new Date().toISOString() 
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Main search endpoint
      if (url.pathname === '/search' && request.method === 'POST') {
        const searchRequest = await request.json();
        
        // Validate request
        if (!searchRequest.query) {
          return new Response(JSON.stringify({ 
            error: 'Missing required field: query' 
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Forward to MCP server
        const mcpResponse = await forwardToMcpServer(searchRequest, env);
        
        return new Response(JSON.stringify(mcpResponse), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300' // 5 minute cache
          }
        });
      }

      // GET endpoint with query parameters
      if (url.pathname === '/search' && request.method === 'GET') {
        const query = url.searchParams.get('query');
        
        if (!query) {
          return new Response(JSON.stringify({ 
            error: 'Missing required parameter: query' 
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const searchRequest = {
          query,
          page: parseInt(url.searchParams.get('page') || '1'),
          includeContent: url.searchParams.get('includeContent') === 'true',
          maxResults: parseInt(url.searchParams.get('maxResults') || '10'),
          filesOnly: url.searchParams.get('filesOnly') === 'true',
          useJson: url.searchParams.get('useJson') === 'true',
          sessionId: url.searchParams.get('sessionId'),
        };

        const mcpResponse = await forwardToMcpServer(searchRequest, env);
        
        return new Response(JSON.stringify(mcpResponse), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=300'
          }
        });
      }

      // API documentation endpoint
      if (url.pathname === '/' || url.pathname === '/docs') {
        return new Response(getApiDocumentation(), {
          headers: { 
            'Content-Type': 'text/html',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // 404 for unknown endpoints
      return new Response(JSON.stringify({ 
        error: 'Not found',
        available_endpoints: ['/search', '/health', '/docs']
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Worker error:', error);
      
      return new Response(JSON.stringify({ 
        error: 'Internal server error',
        message: error.message
      }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  },
};

/**
 * Forward request to MCP server
 */
async function forwardToMcpServer(searchRequest, env) {
  // MCP server endpoint (set in Worker environment variables)
  const MCP_SERVER_URL = env.MCP_SERVER_URL || 'https://your-mcp-server.railway.app';
  
  try {
    const response = await fetch(`${MCP_SERVER_URL}/api/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.MCP_SERVER_TOKEN || ''}` // Optional auth
      },
      body: JSON.stringify({
        tool: 'search_amplify_docs',
        arguments: searchRequest
      }),
      // Timeout after 30 seconds
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      throw new Error(`MCP server responded with ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    
    // Add metadata
    return {
      ...data,
      metadata: {
        cached: false,
        timestamp: new Date().toISOString(),
        source: 'mcp-server',
        worker_version: '1.0.0'
      }
    };

  } catch (error) {
    // If MCP server is down, return cached response or error
    if (error.name === 'TimeoutError') {
      return {
        error: 'Search timeout - please try again with a more specific query',
        timeout: true
      };
    }
    
    throw new Error(`Failed to reach MCP server: ${error.message}`);
  }
}

/**
 * Generate API documentation
 */
function getApiDocumentation() {
  return `<!DOCTYPE html>
<html>
<head>
    <title>AWS Amplify Documentation Search API</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        .endpoint { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 5px; }
        .method { font-weight: bold; color: #2196F3; }
        code { background: #eee; padding: 2px 4px; border-radius: 3px; }
    </style>
</head>
<body>
    <h1>AWS Amplify Documentation Search API</h1>
    <p>HTTP wrapper for the MCP Amplify Documentation Server</p>
    
    <div class="endpoint">
        <div class="method">POST /search</div>
        <p>Search the Amplify documentation</p>
        <pre><code>{
  "query": "authentication setup",
  "page": 1,
  "includeContent": true,
  "maxResults": 15,
  "filesOnly": false,
  "useJson": false,
  "sessionId": "optional-session-id"
}</code></pre>
    </div>

    <div class="endpoint">
        <div class="method">GET /search?query=authentication</div>
        <p>Search via URL parameters</p>
        <p><strong>Parameters:</strong></p>
        <ul>
            <li><code>query</code> (required): Search query</li>
            <li><code>page</code>: Page number (default: 1)</li>
            <li><code>includeContent</code>: Include content snippets (default: false)</li>
            <li><code>maxResults</code>: Max results to return (default: 10)</li>
            <li><code>filesOnly</code>: Return only file paths (default: false)</li>
            <li><code>useJson</code>: Return raw JSON (default: false)</li>
            <li><code>sessionId</code>: Session ID for related searches</li>
        </ul>
    </div>

    <div class="endpoint">
        <div class="method">GET /health</div>
        <p>Health check endpoint</p>
    </div>

    <h2>Example Usage</h2>
    <pre><code>// JavaScript fetch example
const response = await fetch('https://your-worker.your-subdomain.workers.dev/search', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'authentication setup gen2',
    includeContent: true,
    maxResults: 5
  })
});

const results = await response.json();
console.log(results);</code></pre>

    <h2>Advanced Search Syntax</h2>
    <ul>
        <li>Exact phrases: <code>"authentication flow"</code></li>
        <li>Exclude terms: <code>authentication -flutter</code></li>
        <li>Field-specific: <code>title:authentication</code></li>
        <li>Wildcards: <code>auth*</code></li>
        <li>Boolean operators: <code>authentication AND (react OR javascript) NOT flutter</code></li>
    </ul>
</body>
</html>`;
}
</code></pre>