import express from 'express';

export interface CallbackServer {
  waitForCallback: (timeoutMs: number) => Promise<string>;
}

export function startCallbackServer(port: number): CallbackServer {
  const app = express();

  let resolveFn: (url: string) => void;

  const promise = new Promise<string>((resolve) => {
    resolveFn = resolve;
  });

  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Callback server started: http://localhost:${port}`);
  });

  app.use((req, res) => {
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    res.send('OK. You can close this page.');

    server.close();
    resolveFn(fullUrl);
  });

  return {
    waitForCallback: (timeoutMs: number) =>
      Promise.race([
        promise,
        new Promise<string>((_, reject) =>
          setTimeout(() => {
            server.close();
            reject(new Error('Timeout: No callback received'));
          }, timeoutMs)
        )
      ])
  };
}
