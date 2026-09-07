import { testContext } from '../../connection/testing';
import { ServerInitializeScenario } from './lifecycle';
import { connectToServer } from '../../connection/sdk-client';

vi.mock('../../connection/sdk-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../connection/sdk-client')>();
  return {
    ...actual,
    connectToServer: vi.fn()
  };
});

describe('ServerInitializeScenario', () => {
  const serverUrl = 'http://localhost:3000/mcp';
  const closeMock = vi.fn().mockResolvedValue(undefined);
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(connectToServer).mockResolvedValue({
      client: {} as any,
      close: closeMock
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns INFO when the server does not provide an MCP-Session-Id header', async () => {
    fetchMock.mockResolvedValue(new Response(null));

    const checks = await new ServerInitializeScenario().run(
      testContext(serverUrl)
    );

    expect(connectToServer).toHaveBeenCalledWith(
      serverUrl,
      {},
      testContext(serverUrl).specVersion
    );
    expect(closeMock).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      serverUrl,
      expect.objectContaining({
        method: 'POST'
      })
    );

    expect(checks).toHaveLength(2);
    expect(checks[0]?.id).toBe('server-initialize');
    expect(checks[0]?.status).toBe('SUCCESS');
    expect(checks[1]).toMatchObject({
      id: 'server-session-id-visible-ascii',
      status: 'INFO',
      details: {
        message:
          'Server did not provide an MCP-Session-Id header (session ID is optional)'
      }
    });
  });

  it('returns SUCCESS when the server provides a visible ASCII session ID', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        headers: {
          'mcp-session-id': 'session-123_ABC'
        }
      })
    );

    const checks = await new ServerInitializeScenario().run(
      testContext(serverUrl)
    );

    expect(checks[1]).toMatchObject({
      id: 'server-session-id-visible-ascii',
      status: 'SUCCESS',
      details: {
        sessionId: 'session-123_ABC'
      }
    });
  });

  it('returns FAILURE when the server provides a non-ASCII session ID', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        headers: {
          'mcp-session-id': 'session-123-é'
        }
      })
    );

    const checks = await new ServerInitializeScenario().run(
      testContext(serverUrl)
    );

    expect(checks[1]).toMatchObject({
      id: 'server-session-id-visible-ascii',
      status: 'FAILURE',
      errorMessage:
        'Session ID contains characters outside visible ASCII range (0x21-0x7E)',
      details: {
        sessionId: 'session-123-é'
      }
    });
  });

  it('sends an HTTP DELETE with the issued session ID to terminate the raw session', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        headers: {
          'mcp-session-id': 'session-123_ABC'
        }
      })
    );

    await new ServerInitializeScenario().run(testContext(serverUrl));

    expect(fetchMock).toHaveBeenCalledWith(
      serverUrl,
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          'mcp-session-id': 'session-123_ABC'
        })
      })
    );
  });

  it('does not send DELETE when the server did not assign a session ID', async () => {
    fetchMock.mockResolvedValue(new Response(null));

    await new ServerInitializeScenario().run(testContext(serverUrl));

    const deleteCalls = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('bounds the session-id probe so a server that never answers cannot hang it', async () => {
    fetchMock.mockResolvedValue(new Response(null));

    await new ServerInitializeScenario().run(testContext(serverUrl));

    const probe = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
    );
    expect(probe?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('cancels the probe response body so an SSE answer does not leak the connection', async () => {
    // `Accept` on the probe includes `text/event-stream`, so a server is free
    // to answer with a stream that stays open. Only the header is read, so the
    // body has to be released explicitly.
    const cancel = vi.fn().mockResolvedValue(undefined);
    const body = new ReadableStream({
      start() {
        // Never enqueue, never close: an SSE stream awaiting its first event.
      },
      cancel
    });

    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        headers: {
          'content-type': 'text/event-stream',
          'mcp-session-id': 'session-123_ABC'
        }
      })
    );
    fetchMock.mockResolvedValue(new Response(null));

    const checks = await new ServerInitializeScenario().run(
      testContext(serverUrl)
    );

    expect(cancel).toHaveBeenCalled();
    expect(checks[1]).toMatchObject({
      id: 'server-session-id-visible-ascii',
      status: 'SUCCESS'
    });
  });
});
