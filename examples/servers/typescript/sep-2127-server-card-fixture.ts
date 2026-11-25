#!/usr/bin/env node

/**
 * Fixture for the SEP-2127 Server Card scenario (sep-2127-server-card).
 * Five MCP endpoints, each answering server/discover, each with a different card:
 *
 * - /good/mcp        — a correct card, served correctly, that agrees with
 *                      server/discover on every field the scenario compares.
 * - /html/mcp        — the card location answers 200 with an HTML page, no
 *                      CORS and no Cache-Control (a catch-all page, not a card).
 *                      Express still adds an ETag and answers If-None-Match.
 * - /contradict/mcp  — a valid card with the required CORS headers that
 *                      contradicts server/discover: transport, protocol
 *                      versions, version, reverse-DNS name, title, description.
 * - /none/mcp        — no card (404): the optional feature is not offered.
 * - /auth/mcp        — 401 at the card location: also not a hosted card.
 *
 * Run: PORT=3000 npx tsx sep-2127-server-card-fixture.ts
 */

import express from 'express';

const app = express();
app.use(express.json());

const SERVER_INFO = {
  good: {
    name: 'com.example/good-server',
    version: '1.0.0',
    title: 'Good Server',
    description: 'A card that agrees with its server'
  },
  html: { name: 'sep-2127-html', version: '1.0.0' },
  contradict: {
    name: 'com.example/live-server',
    version: '2.0.0',
    title: 'Live Server',
    description: 'What the server says about itself'
  },
  none: { name: 'sep-2127-none', version: '1.0.0' }
} as const;

for (const [prefix, serverInfo] of Object.entries(SERVER_INFO)) {
  app.post(`/${prefix}/mcp`, (req, res) => {
    const id = req.body?.id ?? null;
    if (req.body?.method !== 'server/discover') {
      res.status(404).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' }
      });
      return;
    }
    res.json({
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: ['2026-07-28'],
        capabilities: {},
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'public',
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo }
      }
    });
  });
}

/** Serve a card at /<prefix>/mcp/server-card with the CORS and caching headers the spec asks for. */
function serveCard(prefix: string, card: (origin: string) => object) {
  const path = `/${prefix}/mcp/server-card`;
  const etag = `"sep-2127-${prefix}"`;
  app.options(path, (_req, res) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Content-Type, If-None-Match'
    });
    res.sendStatus(204);
  });
  app.get(path, (req, res) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'ETag',
      'Cache-Control': 'public, max-age=3600',
      ETag: etag
    });
    if (req.get('if-none-match') === etag) {
      res.status(304).end();
      return;
    }
    const origin = `${req.protocol}://${req.get('host')}`;
    res
      .type('application/mcp-server-card+json')
      .send(JSON.stringify(card(origin)));
  });
}

const SCHEMA =
  'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';

// A card that agrees with server/discover.
serveCard('good', (origin) => ({
  $schema: SCHEMA,
  ...SERVER_INFO.good,
  remotes: [
    {
      type: 'streamable-http',
      url: `${origin}/good/mcp`,
      supportedProtocolVersions: ['2026-07-28']
    }
  ]
}));

// A well-formed card, served correctly, that contradicts the live server.
serveCard('contradict', (origin) => ({
  $schema: SCHEMA,
  name: 'com.example/card-says-otherwise',
  version: '1.0.0',
  title: 'Card Title',
  description: 'A card that contradicts its server',
  remotes: [
    {
      type: 'sse',
      url: `${origin}/contradict/mcp`,
      supportedProtocolVersions: ['2025-03-26', '2026-07-28']
    }
  ]
}));

// A catch-all web page at the card location: no card, no CORS, no Cache-Control.
app.get('/html/mcp/server-card', (_req, res) => {
  res
    .type('text/html')
    .send('<!doctype html><title>Not a card</title><p>Welcome</p>');
});

// An auth challenge at the card location: not a hosted card, so the checks skip.
app.get('/auth/mcp/server-card', (_req, res) => {
  res.status(401).set('WWW-Authenticate', 'Bearer').end();
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(
    `SEP-2127 server card fixture running on http://localhost:${PORT}`
  );
});
