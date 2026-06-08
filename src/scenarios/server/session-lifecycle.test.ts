import { SessionLifecycleScenario } from './session-lifecycle';

describe('SessionLifecycleScenario', () => {
  const serverUrl = 'http://localhost:3000/mcp';
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits INFO and skips the lifecycle checks when the server is stateless', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null));

    const checks = await new SessionLifecycleScenario().run(serverUrl);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      id: 'server-session-lifecycle-skipped',
      status: 'INFO'
    });
  });

  it('reports SUCCESS for both checks on the happy path (DELETE 200, then POST 404)', async () => {
    fetchMock
      // initialize
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { 'mcp-session-id': 'session-abc' }
        })
      )
      // notifications/initialized
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      // DELETE
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      // POST after termination
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const checks = await new SessionLifecycleScenario().run(serverUrl);

    const deleteCall = fetchMock.mock.calls[2];
    expect(deleteCall?.[0]).toBe(serverUrl);
    expect((deleteCall?.[1] as RequestInit).method).toBe('DELETE');
    expect((deleteCall?.[1] as RequestInit).headers).toMatchObject({
      'mcp-session-id': 'session-abc'
    });

    const postAfterDelete = fetchMock.mock.calls[3];
    expect((postAfterDelete?.[1] as RequestInit).method).toBe('POST');
    expect((postAfterDelete?.[1] as RequestInit).headers).toMatchObject({
      'mcp-session-id': 'session-abc'
    });

    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({
      id: 'server-session-delete-accepted',
      status: 'SUCCESS',
      details: { statusCode: 200 }
    });
    expect(checks[1]).toMatchObject({
      id: 'server-session-terminated-returns-404',
      status: 'SUCCESS',
      details: { statusCode: 404 }
    });
  });

  it('marks both checks as SKIPPED when the server returns 405 on DELETE', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { 'mcp-session-id': 'session-no-delete' }
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 405 }));

    const checks = await new SessionLifecycleScenario().run(serverUrl);

    // Should NOT POST again after a 405 — the 404 check is meaningless then.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({
      id: 'server-session-delete-accepted',
      status: 'SKIPPED',
      details: { statusCode: 405 }
    });
    expect(checks[1]).toMatchObject({
      id: 'server-session-terminated-returns-404',
      status: 'SKIPPED'
    });
  });

  it('reports FAILURE on the terminated-returns-404 check when the server returns 200 after DELETE', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { 'mcp-session-id': 'session-buggy' }
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const checks = await new SessionLifecycleScenario().run(serverUrl);

    expect(checks[0]).toMatchObject({
      id: 'server-session-delete-accepted',
      status: 'SUCCESS'
    });
    expect(checks[1]).toMatchObject({
      id: 'server-session-terminated-returns-404',
      status: 'FAILURE',
      details: { statusCode: 200 }
    });
  });
});
