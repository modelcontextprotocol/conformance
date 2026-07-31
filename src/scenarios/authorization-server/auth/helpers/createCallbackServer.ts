import express from 'express';

export interface CallbackServer {
  waitForCallback: (timeoutMs: number) => Promise<string>;
  close: () => void;
}

export function startCallbackServer(port: number): CallbackServer {
  const app = express();

  let resolveFn: (url: string) => void;
  let rejectFn: (err: Error) => void;

  const promise = new Promise<string>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Callback server started: http://127.0.0.1:${port}`);
  });

  server.on('error', (err) => {
    rejectFn(err instanceof Error ? err : new Error(String(err)));
  });

  app.get('/callback', (req, res) => {
    // Do not derive origin from the client-supplied Host header — reconstruct
    // from the bind address so a forged Host can't influence validation.
    const fullUrl = `http://127.0.0.1:${port}${req.originalUrl}`;
    res.send('OK. You can close this page.');

    server.close();
    resolveFn(fullUrl);
  });

  const close = () => {
    server.close();
  };

  return {
    close,
    waitForCallback: (timeoutMs: number) => {
      let timer: NodeJS.Timeout;
      const timeout = new Promise<string>((_, reject) => {
        timer = setTimeout(() => {
          server.close();
          reject(new Error('Timeout: No callback received'));
        }, timeoutMs);
        timer.unref();
      });
      return Promise.race([promise, timeout]).finally(() =>
        clearTimeout(timer)
      );
    }
  };
}
