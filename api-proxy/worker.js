/**
 * COFE Properties — Anthropic API Proxy (Cloudflare Worker)
 *
 * Environment secret required:
 *   ANTHROPIC_API_KEY  — your sk-ant-... key
 *
 * Deploy:  npx wrangler deploy
 * Secret:  npx wrangler secret put ANTHROPIC_API_KEY
 */

const ALLOWED_ORIGINS = [
  'https://ejcosculluela26-sketch.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

const CORS_HEADERS = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
});

function getAllowedOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

export default {
  async fetch(request, env) {
    const origin = getAllowedOrigin(request);
    const cors = CORS_HEADERS(origin);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'API key not configured on server' }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    try {
      const body = await request.json();

      // Validate required fields
      if (!body.messages || !Array.isArray(body.messages)) {
        return new Response(JSON.stringify({ error: 'messages array is required' }), {
          status: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // Build the Anthropic API request
      const anthropicBody = {
        model: body.model || 'claude-sonnet-4-20250514',
        max_tokens: Math.min(body.max_tokens || 1024, 2048),
        messages: body.messages,
      };

      if (body.system) {
        anthropicBody.system = body.system;
      }

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(anthropicBody),
      });

      const data = await resp.text();

      return new Response(data, {
        status: resp.status,
        headers: {
          ...cors,
          'Content-Type': 'application/json',
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Proxy error: ' + e.message }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  },
};
