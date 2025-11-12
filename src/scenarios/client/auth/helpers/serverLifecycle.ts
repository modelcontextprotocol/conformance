import express from 'express';

export class ServerLifecycle {
  private app: express.Application | null = null;
  private httpServer: any = null;
  private baseUrl: string = '';

  async start(app: express.Application): Promise<string> {
    this.app = app;
    this.httpServer = this.app.listen(0);
    const port = this.httpServer.address().port;
    this.baseUrl = `http://localhost:${port}`;
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

  getUrl(): string {
    return this.baseUrl;
  }
}
