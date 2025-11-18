import { Request, Response, NextFunction, RequestHandler } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';

export interface ScopeAwareAuthOptions {
  verifier: OAuthTokenVerifier;
  requiredScopes: string[];
  resourceMetadataUrl?: string;
  includeScopeInWwwAuth?: boolean;
}

/**
 * Wraps requireBearerAuth to add scope parameter to WWW-Authenticate header
 * on 401 responses when includeScopeInWwwAuth is true.
 */
export function scopeAwareAuthMiddleware(
  options: ScopeAwareAuthOptions
): RequestHandler {
  const { includeScopeInWwwAuth, requiredScopes, ...bearerAuthOptions } =
    options;
  const baseMiddleware = requireBearerAuth(bearerAuthOptions);

  return (req: Request, res: Response, next: NextFunction) => {
    if (!includeScopeInWwwAuth || requiredScopes.length === 0) {
      // Use base middleware as-is
      return baseMiddleware(req, res, next);
    }

    // Intercept the response to add scope parameter
    const originalSetHeader = res.setHeader.bind(res);
    const originalSet = res.set.bind(res);

    const addScopeToWwwAuth = (value: string | string[] | number): string => {
      if (typeof value !== 'string') return value.toString();

      // Only modify WWW-Authenticate headers for Bearer auth
      if (value.startsWith('Bearer ')) {
        const scopeParam = `scope="${requiredScopes.join(' ')}"`;
        // Insert scope parameter after error and error_description but before resource_metadata
        if (value.includes('resource_metadata=')) {
          return value.replace(
            /resource_metadata=/,
            `${scopeParam}, resource_metadata=`
          );
        } else {
          return `${value}, ${scopeParam}`;
        }
      }
      return value;
    };

    // Override setHeader
    res.setHeader = function (name: string, value: string | string[] | number) {
      if (name.toLowerCase() === 'www-authenticate') {
        value = addScopeToWwwAuth(value as string);
      }
      return originalSetHeader(name, value);
    };

    // Override set (Express helper)
    res.set = function (field: any, value?: any) {
      if (
        typeof field === 'string' &&
        field.toLowerCase() === 'www-authenticate'
      ) {
        value = addScopeToWwwAuth(value);
      }
      return originalSet(field, value);
    };

    baseMiddleware(req, res, next);
  };
}
