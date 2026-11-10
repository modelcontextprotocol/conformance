#!/usr/bin/env node

/**
 * SEP-1036 URL Mode Elicitation Broken Server — Negative Test Case
 *
 * Deliberately violates the server-side URL mode requirements (2026-07-28):
 * 1. Sends its URL-mode request without `mode: "url"`, and with a url that is
 *    not a valid absolute URI
 * 2. Sends that request whatever modes the client declared, so a form-only
 *    client gets it too, and never answers -32021
 * 3. Fails with an internal error (-32603) when the user declines
 * 4. Answers a cancel with -32042, the URLElicitationRequiredError that only
 *    exists in 2025-11-25
 * 5. Sends a form-mode request to a client that declared URL mode only
 *
 * The elicitation-sep1036-url-mode scenario should emit FAILURE against this
 * server.
 */

import express from 'express';

const PORT = parseInt(process.env.PORT || '3012', 10);

const app = express();
app.use(express.json());

app.post('/mcp', (req, res) => {
  const body = req.body as {
    id: number;
    method: string;
    params?: Record<string, unknown>;
  };
  const params = body.params ?? {};
  const inputResponses = params.inputResponses as
    | Record<string, { action?: string }>
    | undefined;

  if (body.method !== 'tools/call') {
    res.json({
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32601, message: `Method not found: ${body.method}` }
    });
    return;
  }

  switch (params.name) {
    case 'test_url_elicitation': {
      const answer = inputResponses?.['connect_account'];

      // BUG 3: An unhandled decline surfaces as an internal error.
      if (answer?.action === 'decline') {
        res.status(500).json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32603, message: 'Internal error: unhandled decline' }
        });
        return;
      }

      // BUG 4: The 2025-11-25 error, which 2026-07-28 servers MUST NOT emit.
      if (answer?.action === 'cancel') {
        res.json({
          jsonrpc: '2.0',
          id: body.id,
          error: {
            code: -32042,
            message: 'This request requires more information.',
            data: {
              elicitations: [
                {
                  mode: 'url',
                  elicitationId: 'connect-account',
                  url: 'https://example.com/connect',
                  message: 'Connect your account to continue.'
                }
              ]
            }
          }
        });
        return;
      }

      // BUGS 1 and 2: No `mode`, an invalid url, and no capability check.
      res.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          resultType: 'input_required',
          inputRequests: {
            connect_account: {
              method: 'elicitation/create',
              params: {
                message: 'Connect your account to continue.',
                url: 'connect your account here'
              }
            }
          }
        }
      });
      return;
    }

    case 'test_input_required_result_elicitation': {
      // BUG 5: Sends form mode without checking the declared modes.
      res.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          resultType: 'input_required',
          inputRequests: {
            user_name: {
              method: 'elicitation/create',
              params: {
                message: 'What is your name?',
                requestedSchema: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                  required: ['name']
                }
              }
            }
          }
        }
      });
      return;
    }

    default:
      res.json({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32602, message: `Unknown tool: ${params.name}` }
      });
  }
});

app.listen(PORT, () => {
  console.log(
    `sep-1036-url-elicitation-broken-server running on http://localhost:${PORT}/mcp`
  );
});
