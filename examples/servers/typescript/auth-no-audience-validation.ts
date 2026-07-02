#!/usr/bin/env node

/**
 * Issue #78 Negative Test Server — broken audience validation.
 *
 * An OAuth-protected MCP server that verifies Bearer JWTs (signature via the
 * issuer's JWKS, issuer, expiry) but deliberately SKIPS audience validation,
 * violating "MCP servers MUST validate that access tokens were issued
 * specifically for them as the intended audience" (authorization spec,
 * Token Handling). Against this server the auth-token-audience-validation
 * scenario must emit FAILURE for the wrong-audience and missing-audience
 * checks while the signature/expiry checks still pass.
 *
 * Configuration (same contract as the everything-server's opt-in auth mode):
 *   PORT                         - listen port (default 3000)
 *   MCP_CONFORMANCE_AUTH_ISSUER  - trusted authorization server issuer URL
 */

import express from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const PORT = process.env.PORT || 3000;
const AUTH_ISSUER =
  process.env.MCP_CONFORMANCE_AUTH_ISSUER ?? 'http://127.0.0.1:9797';

const app = express();
app.use(express.json());

// Lazily-constructed remote JWKS, discovered from the issuer's RFC 8414
// metadata at first use.
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

app.use('/mcp', async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Unauthorized: missing Bearer token' }
    });
  }

  try {
    if (!jwks) {
      const metadataRes = await fetch(
        `${AUTH_ISSUER}/.well-known/oauth-authorization-server`
      );
      if (!metadataRes.ok) {
        throw new Error(
          `authorization server metadata fetch failed: HTTP ${metadataRes.status}`
        );
      }
      const metadata = (await metadataRes.json()) as { jwks_uri?: string };
      if (!metadata.jwks_uri) {
        throw new Error('authorization server metadata lacks jwks_uri');
      }
      jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
    }
    // BROKEN ON PURPOSE: no `audience` option — a token minted for any other
    // resource (or with no aud claim at all) passes verification.
    await jwtVerify(header.slice('Bearer '.length), jwks, {
      issuer: AUTH_ISSUER
    });
    return next();
  } catch (error) {
    res.set(
      'WWW-Authenticate',
      `Bearer error="invalid_token", error_description="${
        error instanceof Error ? error.message : 'invalid'
      }"`
    );
    return res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Unauthorized: invalid token' }
    });
  }
});

app.post('/mcp', (req, res) => {
  const body = req.body || {};
  const id = body.id ?? null;
  const method = body.method;

  switch (method) {
    case 'initialize':
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: body.params?.protocolVersion ?? '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'auth-no-audience-validation', version: '1.0.0' }
        }
      });
    case 'server/discover':
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
          serverInfo: { name: 'auth-no-audience-validation', version: '1.0.0' }
        }
      });
    case 'tools/list':
      return res.json({ jsonrpc: '2.0', id, result: { tools: [] } });
    default:
      if (id === null) return res.status(202).end(); // notification
      return res.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
  }
});

app.listen(PORT, () => {
  console.log(
    `Auth no-audience-validation negative test server running on http://localhost:${PORT}`
  );
  console.log(`  - MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`  - Trusted issuer: ${AUTH_ISSUER}`);
});
