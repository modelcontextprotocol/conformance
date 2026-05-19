import { ServerInitializeScenario } from './lifecycle';
import { connectToServer } from './client-helper';

vi.mock('./client-helper', () => ({
  connectToServer: vi.fn()
}));

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

    const checks = await new ServerInitializeScenario().run(serverUrl);

    expect(connectToServer).toHaveBeenCalledWith(serverUrl);
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

    const checks = await new ServerInitializeScenario().run(serverUrl);

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

    const checks = await new ServerInitializeScenario().run(serverUrl);

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
});
