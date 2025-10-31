import http from 'http';
import { Scenario, ScenarioUrls, ConformanceCheck } from '../../types.js';
import { createClientInitializationCheck, createServerInfoCheck } from '../../checks.js';

export class InitializeScenario implements Scenario {
    name = 'initialize';
    description = 'Tests MCP client initialization handshake';

    private server: http.Server | null = null;
    private checks: ConformanceCheck[] = [];
    private port: number = 0;

    async start(): Promise<ScenarioUrls> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });

            this.server.on('error', reject);

            this.server.listen(0, () => {
                const address = this.server!.address();
                if (address && typeof address === 'object') {
                    this.port = address.port;
                    resolve({
                        serverUrl: `http://localhost:${this.port}`
                    });
                } else {
                    reject(new Error('Failed to get server address'));
                }
            });
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.server) {
                this.server.close(err => {
                    if (err) {
                        reject(err);
                    } else {
                        this.server = null;
                        resolve();
                    }
                });
            } else {
                resolve();
            }
        });
    }

    getChecks(): ConformanceCheck[] {
        return this.checks;
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                const request = JSON.parse(body);

                if (request.method === 'initialize') {
                    this.handleInitialize(request, res);
                } else if (request.method === 'tools/list') {
                    this.handleToolsList(request, res);
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id: request.id,
                            result: {}
                        })
                    );
                }
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        error: {
                            code: -32700,
                            message: `Parse error ${error}`
                        }
                    })
                );
            }
        });
    }

    private handleInitialize(request: any, res: http.ServerResponse): void {
        const initializeRequest = request.params;

        const check = createClientInitializationCheck(initializeRequest);
        this.checks.push(check);

        const serverInfo = {
            name: 'test-server',
            version: '1.0.0'
        };

        const serverInfoCheck = createServerInfoCheck(serverInfo);
        this.checks.push(serverInfoCheck);

        const response = {
            jsonrpc: '2.0',
            id: request.id,
            result: {
                protocolVersion: '2025-06-18',
                serverInfo,
                capabilities: {}
            }
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
    }

    private handleToolsList(request: any, res: http.ServerResponse): void {
        const response = {
            jsonrpc: '2.0',
            id: request.id,
            result: {
                tools: []
            }
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
    }
}
