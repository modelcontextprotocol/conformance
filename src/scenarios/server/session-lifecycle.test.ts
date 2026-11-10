import { SessionLifecycleScenario } from './session-lifecycle';
import { testContext } from '../../connection/testing';

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

    const checks = await new SessionLifecycleScenario().run(
      testContext(serverUrl)
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      id: 'server-session-lifecycle-skipped',
      status: 'INFO'
    });
  });

  it('reports FAILURE when initialize itself fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const checks = await new SessionLifecycleScenario().run(
      testContext(serverUrl)
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      id: 'server-session-lifecycle-error',
      status: 'FAILURE',
      details: { statusCode: 500 }
    });
  });

  it('reports FAILURE when the initialized notification is rejected', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { 'mcp-session-id': 'session-abc' }
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 400 }));

    const checks = await new SessionLifecycleScenario().run(
      testContext(serverUrl)
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(checks).toHaveLength(3);
    expect(checks[0]).toMatchObject({
      id: 'server-session-initialized-accepted',
      status: 'FAILURE',
      details: { statusCode: 400 }
    });
    expect(checks[1]).toMatchObject({
      id: 'server-session-delete-accepted',
      status: 'SKIPPED'
    });
    expect(checks[2]).toMatchObject({
      id: 'server-session-terminated-returns-404',
      status: 'SKIPPED'
    });
  });

  it('reports SUCCESS for all checks on the happy path (DELETE 200, then POST 404)', async () => {
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

    const checks = await new SessionLifecycleScenario().run(
      testContext(serverUrl)
    );

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

    expect(checks).toHaveLength(3);
    expect(checks[0]).toMatchObject({
      id: 'server-session-initialized-accepted',
      status: 'SUCCESS',
      details: { statusCode: 202 }
    });
    expect(checks[1]).toMatchObject({
      id: 'server-session-delete-accepted',
      status: 'SUCCESS',
      details: { statusCode: 200 }
    });
    expect(checks[2]).toMatchObject({
      id: 'server-session-terminated-returns-404',
      status: 'SUCCESS',
      details: { statusCode: 404 }
    });
  });

  it('sends the negotiated protocol version on follow-up requests', async () => {
    fetchMock
      // initialize: server negotiates down to 2025-03-26
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'test', version: '1.0.0' }
            }
          }),
          {
            headers: {
              'content-type': 'application/json',
              'mcp-session-id': 'session-old'
            }
          }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const checks = await new SessionLifecycleScenario().run(
      testContext(serverUrl, '2025-06-18')
    );

    // initialize itself must not carry MCP-Protocol-Version.
    const initHeaders = (fetchMock.mock.calls[0]?.[1] as RequestInit)
      .headers as Record<string, string>;
    expect(initHeaders['MCP-Protocol-Version']).toBeUndefined();

    // All follow-up requests carry the negotiated version, not a hardcoded one.
    for (const callIndex of [1, 2, 3]) {
      const headers = (fetchMock.mock.calls[callIndex]?.[1] as RequestInit)
        .headers as Record<string, string>;
      expect(headers['MCP-Protocol-Version']).toBe('2025-03-26');
    }

    expect(checks).toHaveLength(3);
    expect(checks.every((c) => c.status === 'SUCCESS')).toBe(true);
  });

  it('marks the lifecycle checks as SKIPPED when the server returns 405 on DELETE', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { 'mcp-session-id': 'session-no-delete' }
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 405 }));

    const checks = await new SessionLifecycleScenario().run(
      testContext(serverUrl)
    );

    // Should NOT POST again after a 405 — the 404 check is meaningless then.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(checks).toHaveLength(3);
    expect(checks[1]).toMatchObject({
      id: 'server-session-delete-accepted',
      status: 'SKIPPED',
      details: { statusCode: 405 }
    });
    expect(checks[2]).toMatchObject({
      id: 'server-session-terminated-returns-404',
      status: 'SKIPPED'
    });
  });

  it('treats 404 on DELETE as already terminated when the session stops responding', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { 'mcp-session-id': 'session-expired' }
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      // DELETE says the session is already gone
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const checks = await new SessionLifecycleScenario().run(
      testContext(serverUrl)
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(checks[1]).toMatchObject({
      id: 'server-session-delete-accepted',
      status: 'SUCCESS',
      details: { statusCode: 404 }
    });
    expect(checks[2]).toMatchObject({
      id: 'server-session-terminated-returns-404',
      status: 'SUCCESS'
    });
  });

  it('reports INFO when DELETE returns 404 but the session still responds', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { 'mcp-session-id': 'session-no-delete-route' }
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      // DELETE 404s (no DELETE route)...
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      // ...but the session is still alive.
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const checks = await new SessionLifecycleScenario().run(
      testContext(serverUrl)
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(checks).toHaveLength(3);
    expect(checks[1]).toMatchObject({
      id: 'server-session-delete-accepted',
      status: 'INFO',
      details: { statusCode: 404 }
    });
    expect(checks[1].details?.message).toContain('still responds');
    expect(checks[2]).toMatchObject({
      id: 'server-session-terminated-returns-404',
      status: 'SKIPPED'
    });
  });

  it('reports INFO on an inconclusive DELETE status and skips the 404 check', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { 'mcp-session-id': 'session-odd-delete' }
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));

    const checks = await new SessionLifecycleScenario().run(
      testContext(serverUrl)
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(checks).toHaveLength(3);
    expect(checks[1]).toMatchObject({
      id: 'server-session-delete-accepted',
      status: 'INFO',
      details: { statusCode: 500 }
    });
    expect(checks[1].details?.message).toContain('Expected 2xx, 404, or 405');
    expect(checks[2]).toMatchObject({
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

    const checks = await new SessionLifecycleScenario().run(
      testContext(serverUrl)
    );

    expect(checks[1]).toMatchObject({
      id: 'server-session-delete-accepted',
      status: 'SUCCESS'
    });
    expect(checks[2]).toMatchObject({
      id: 'server-session-terminated-returns-404',
      status: 'FAILURE',
      details: { statusCode: 200 }
    });
  });
});
