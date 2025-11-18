import { Request, Response, NextFunction } from 'express';
import { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';

/**
 * Middleware for step-up authentication scenarios.
 * Checks MCP requests and enforces different scope requirements based on the operation:
 * - ListTools requires one set of scopes (e.g., mcp:basic)
 * - Tool calls require additional scopes (e.g., mcp:write)
 * Returns 401 with WWW-Authenticate header if scopes are insufficient.
 */
export function stepUpAuthMiddleware(options: {
  verifier: OAuthTokenVerifier;
  resourceMetadataUrl?: string;
  initialScopes: string[];
  toolCallScopes: string[];
}) {
  const { verifier, resourceMetadataUrl, initialScopes, toolCallScopes } =
    options;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        // No auth provided, require initial scopes
        return sendUnauthorized(res, resourceMetadataUrl, initialScopes);
      }

      const token = authHeader.substring('Bearer '.length);
      const authInfo = await verifier.verifyAccessToken(token);

      // Check if this is a tool call request
      let body = req.body;
      if (typeof body === 'string') {
        body = JSON.parse(body);
      }

      const isToolCall = body.method === 'tools/call';
      const requiredScopes = isToolCall ? toolCallScopes : initialScopes;

      // Verify token has required scopes
      const tokenScopes = authInfo.scopes || [];
      const hasRequiredScopes = requiredScopes.every((scope) =>
        tokenScopes.includes(scope)
      );

      if (!hasRequiredScopes) {
        // Token exists but doesn't have required scopes
        return sendForbidden(res, resourceMetadataUrl, requiredScopes);
      }

      // Authorization successful
      next();
    } catch (error) {
      // Token verification failed
      console.error(error);
      const initialScopes = options.initialScopes;
      return sendUnauthorized(res, resourceMetadataUrl, initialScopes);
    }
  };
}

function sendForbidden(
  res: Response,
  resourceMetadataUrl?: string,
  scopes: string[] = []
): void {
  let wwwAuthenticateHeader = 'Bearer';

  if (resourceMetadataUrl) {
    wwwAuthenticateHeader += ` realm="${resourceMetadataUrl}"`;
  }

  if (scopes.length > 0) {
    wwwAuthenticateHeader += `, scope="${scopes.join(' ')}"`;
  }

  res
    .status(403)
    .set('WWW-Authenticate', wwwAuthenticateHeader)
    .json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Insufficient scope'
      }
    });
}

function sendUnauthorized(
  res: Response,
  resourceMetadataUrl?: string,
  scopes: string[] = []
): void {
  let wwwAuthenticateHeader = 'Bearer';

  if (resourceMetadataUrl) {
    wwwAuthenticateHeader += ` realm="${resourceMetadataUrl}"`;
  }

  if (scopes.length > 0) {
    wwwAuthenticateHeader += `, scope="${scopes.join(' ')}"`;
  }

  res
    .status(401)
    .set('WWW-Authenticate', wwwAuthenticateHeader)
    .json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Unauthorized'
      }
    });
}
