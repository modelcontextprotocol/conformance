/** Bounded stream collection for the SEP-2575 server-stateless scenario. */
export async function observeStream(
  url: string,
  request: RequestInit,
  maxFrames: number,
  timeoutMs: number,
  onAcknowledged?: (signal: AbortSignal) => Promise<void>,
  mutationTimeoutMs = 10000
): Promise<{
  frames: any[];
  mutationFrames: any[];
  mutationError?: string;
  observationComplete: boolean;
}> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observationComplete = false;
  const arm = (ms: number, observing = false) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      observationComplete = observing;
      controller.abort();
    }, ms);
  };
  // The opening window and the post-mutation observation window retain the
  // caller's original duration. The diagnostic RPC has its own finite bound
  // (the same default as sendStatelessRequest).
  arm(timeoutMs);
  const frames: any[] = [];
  let mutationError = onAcknowledged
    ? 'Subscription acknowledgment was not observed before the mutation'
    : undefined;
  let mutationFrameOffset: number | undefined;
  const result = () => ({
    frames,
    mutationFrames:
      mutationFrameOffset === undefined
        ? []
        : frames.slice(mutationFrameOffset),
    mutationError,
    observationComplete
  });
  let invoked = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const res = await fetch(url, { ...request, signal: controller.signal });
    if (!res.body) return result();
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const parseLine = (line: string) => {
      const cleanLine = line.trim();
      if (!cleanLine) return;
      const jsonText = cleanLine.startsWith('data:')
        ? cleanLine.replace(/^data:\s*/, '')
        : cleanLine;
      try {
        frames.push(JSON.parse(jsonText));
      } catch {
        // Preserve the scenario's existing line-oriented parsing behavior.
      }
    };
    while (frames.length < maxFrames) {
      let value: Uint8Array | undefined;
      let done = false;
      try {
        ({ value, done } = await reader.read());
      } catch {
        // Timeout or disconnect: keep the frames actually received.
        break;
      }
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) parseLine(line);
        if (
          onAcknowledged &&
          !invoked &&
          frames[0]?.method === 'notifications/subscriptions/acknowledged'
        ) {
          invoked = true;
          try {
            controller.signal.throwIfAborted();
            mutationFrameOffset = frames.length;
            arm(mutationTimeoutMs);
            await onAcknowledged(controller.signal);
            controller.signal.throwIfAborted();
            mutationError = undefined;
            arm(timeoutMs, true);
          } catch {
            mutationError = controller.signal.aborted
              ? 'Diagnostic mutation timed out'
              : 'Diagnostic mutation failed';
            break;
          }
        }
      }
      if (done) {
        parseLine(buffer);
        break;
      }
    }
    return result();
  } catch {
    return result();
  } finally {
    clearTimeout(timer);
    // Abort the owned fetch on EVERY exit, even after collecting enough
    // frames. Releasing a reader lock alone does not cancel a live stream.
    controller.abort();
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // A fetch already aborted or a closed stream needs no further cleanup.
      } finally {
        reader.releaseLock();
      }
    }
  }
}
