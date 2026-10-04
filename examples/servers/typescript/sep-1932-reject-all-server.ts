#!/usr/bin/env node

/**
 * MCP server that rejects EVERY request with 401 + `WWW-Authenticate: DPoP` —
 * NEGATIVE test fixture for the gating in the DPoP server-validation scenario.
 *
 * A naive rejection check ("did the server 401 the malformed proof?") passes
 * vacuously here, because this server also 401s a perfectly valid DPoP request.
 * The scenario must therefore gate its rejection checks on the positive
 * baseline: against this fixture `AcceptsValidProof` FAILs, and every rejection
 * check must report notTestable rather than SUCCESS. DO NOT use in production.
 */

import express, { type Request, type Response } from 'express';

const ASYMMETRIC_ALGS = ['ES256', 'ES384', 'ES512', 'RS256', 'PS256', 'EdDSA'];

const app = express();
app.use(express.json());

// Reject unconditionally — a valid proof is refused exactly like a malformed one.
app.post('/mcp', (_req: Request, res: Response) => {
  res.setHeader(
    'WWW-Authenticate',
    `DPoP error="invalid_token", error_description="rejects everything", algs="${ASYMMETRIC_ALGS.join(' ')}"`
  );
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null
  });
});

const PORT = parseInt(process.env.PORT || '3012', 10);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`DPoP reject-all server running on http://localhost:${PORT}/mcp`);
  console.log('WARNING: Rejects every request, including valid ones!');
});
