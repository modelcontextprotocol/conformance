import express from 'express';

export class ServerLifecycle {
  private app: express.Application | null = null;
  private httpServer: any = null;
  private baseUrl: string = '';

  // Arrow function to avoid needing lots of .bind(this)
  getUrl = (): string => {
    return this.baseUrl;
  };

  async start(app: express.Application, port?: number): Promise<string> {
    this.app = app;
    this.httpServer = this.app.listen(port ?? 0);
    const actualPort = this.httpServer.address().port;
    this.baseUrl = `http://localhost:${actualPort}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer.closeAllConnections?.();
        this.httpServer.close(() => resolve());
      });
      this.httpServer = null;
    }
    this.app = null;
  }
}
