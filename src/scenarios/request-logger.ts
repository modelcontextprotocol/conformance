import { Request, Response, NextFunction } from 'express';
import { ConformanceCheck } from '../types.js';

export interface LoggerOptions {
  incomingId: string;
  outgoingId: string;
  mcpRoute?: string;
}

export function createRequestLogger(
  checks: ConformanceCheck[],
  options: LoggerOptions
) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Log incoming request
    let requestDescription = `Received ${req.method} request for ${req.path}`;
    const requestDetails: any = {
      method: req.method,
      path: req.path,
      body: req.body
    };

    // Add query parameters to details if they exist
    if (Object.keys(req.query).length > 0) {
      requestDetails.query = req.query;
    }

    // Extract MCP method if this is the MCP route
    if (
      options.mcpRoute &&
      req.path === options.mcpRoute &&
      req.get('content-type')?.includes('application/json') &&
      req.body &&
      typeof req.body === 'object' &&
      req.body.method
    ) {
      const mcpMethod = req.body.method;
      requestDescription += ` (method: ${mcpMethod})`;
      requestDetails.mcpMethod = mcpMethod;
    }

    checks.push({
      id: options.incomingId,
      name:
        options.incomingId.charAt(0).toUpperCase() +
        options.incomingId.slice(1),
      description: requestDescription,
      status: 'INFO',
      timestamp: new Date().toISOString(),
      details: requestDetails
    });

    // Capture response body
    const oldWrite = res.write.bind(res);
    const oldEnd = res.end.bind(res);
    const chunks: (Buffer | string)[] = [];

    (res.write as any) = function (chunk: any, ...args: any[]) {
      chunks.push(chunk);
      return oldWrite(chunk, ...args);
    };

    (res.end as any) = function (chunk?: any, ...args: any[]) {
      if (chunk) {
        chunks.push(chunk);
      }

      const buffers = chunks.map((c) =>
        typeof c === 'string' ? Buffer.from(c) : c
      );
      const body = Buffer.concat(buffers).toString('utf8');
      let responseDescription = `Sent ${res.statusCode} response for ${req.method} ${req.path}`;
      const responseDetails: any = {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode
      };

      // Include MCP method in response log if present
      if (requestDetails.mcpMethod) {
        responseDescription += ` (method: ${requestDetails.mcpMethod})`;
        responseDetails.mcpMethod = requestDetails.mcpMethod;
      }

      // Add response headers
      const headers = res.getHeaders();
      if (Object.keys(headers).length > 0) {
        responseDetails.headers = headers;
      }

      // Add response body if available
      if (body) {
        try {
          responseDetails.body = JSON.parse(body);
        } catch {
          responseDetails.body = body;
        }
      }

      checks.push({
        id: options.outgoingId,
        name:
          options.outgoingId.charAt(0).toUpperCase() +
          options.outgoingId.slice(1),
        description: responseDescription,
        status: 'INFO',
        timestamp: new Date().toISOString(),
        details: responseDetails
      });

      return oldEnd(chunk, ...args);
    };

    next();
  };
}
