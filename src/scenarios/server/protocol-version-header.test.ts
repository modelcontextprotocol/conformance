import { ServerProtocolVersionHeaderScenario } from './protocol-version-header';

describe('ServerProtocolVersionHeaderScenario', () => {
  const serverUrl = 'http://localhost:3000/mcp';
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockHappyPath(sessionId = 'session-abc') {
    fetchMock.mockImplementation((_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: { 'mcp-session-id': sessionId }
          })
        );
      }
      if (body.method === 'notifications/initialized') {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      return Promise.resolve(new Response('bad version', { status: 400 }));
    });
  }

  it('emits 6 checks (3 header values × pre/post-init) all SUCCESS when server responds 400', async () => {
    mockHappyPath();

    const checks = await new ServerProtocolVersionHeaderScenario().run(
      serverUrl
    );

    expect(checks.map((c) => c.id)).toEqual([
      'server-protocol-version-header-malformed',
      'server-protocol-version-header-unsupported-past',
      'server-protocol-version-header-unsupported-future',
      'server-protocol-version-header-malformed-post-init',
      'server-protocol-version-header-unsupported-past-post-init',
      'server-protocol-version-header-unsupported-future-post-init'
    ]);
    for (const check of checks) {
      expect(check.status).toBe('SUCCESS');
      expect(check.specReferences?.[0]?.id).toBe('MCP-Protocol-Version-Header');
    }
  });

  it('sends tools/list with each bad header value, and includes session-id post-init', async () => {
    mockHappyPath('session-abc');

    await new ServerProtocolVersionHeaderScenario().run(serverUrl);

    const toolsListCalls = fetchMock.mock.calls.filter(
      ([, init]) => JSON.parse(init.body).method === 'tools/list'
    );
    expect(toolsListCalls).toHaveLength(6);

    const headerValues = toolsListCalls.map(
      ([, init]) =>
        (init.headers as Record<string, string>)['MCP-Protocol-Version']
    );
    expect(headerValues).toEqual([
      'invalid-protocol-version',
      '2000-01-01',
      '2099-01-01',
      'invalid-protocol-version',
      '2000-01-01',
      '2099-01-01'
    ]);

    // pre-init: no session-id header
    for (const [, init] of toolsListCalls.slice(0, 3)) {
      expect(
        (init.headers as Record<string, string>)['Mcp-Session-Id']
      ).toBeUndefined();
    }
    // post-init: session-id header present
    for (const [, init] of toolsListCalls.slice(3)) {
      expect((init.headers as Record<string, string>)['Mcp-Session-Id']).toBe(
        'session-abc'
      );
    }
  });

  it('completes the initialize handshake with valid headers before post-init checks', async () => {
    mockHappyPath();

    await new ServerProtocolVersionHeaderScenario().run(serverUrl);

    const initCall = fetchMock.mock.calls.find(
      ([, init]) => JSON.parse(init.body).method === 'initialize'
    );
    expect(initCall).toBeDefined();
    expect(
      (initCall![1].headers as Record<string, string>)['MCP-Protocol-Version']
    ).toBe('2025-11-25');

    const initializedCall = fetchMock.mock.calls.find(
      ([, init]) => JSON.parse(init.body).method === 'notifications/initialized'
    );
    expect(initializedCall).toBeDefined();
  });

  it('returns FAILURE when the server responds with a non-400 status', async () => {
    fetchMock.mockImplementation((_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: { 'mcp-session-id': 's' }
          })
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const checks = await new ServerProtocolVersionHeaderScenario().run(
      serverUrl
    );

    const toolsChecks = checks.filter((c) => c.id.includes('protocol-version'));
    expect(toolsChecks).toHaveLength(6);
    for (const check of toolsChecks) {
      expect(check.status).toBe('FAILURE');
      expect(check.errorMessage).toContain('got 200');
    }
  });

  it('emits FAILURE for post-init checks when initialize itself fails', async () => {
    fetchMock.mockImplementation((_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        return Promise.resolve(new Response('nope', { status: 500 }));
      }
      return Promise.resolve(new Response(null, { status: 400 }));
    });

    const checks = await new ServerProtocolVersionHeaderScenario().run(
      serverUrl
    );

    expect(checks).toHaveLength(6);
    expect(checks.slice(0, 3).map((c) => c.status)).toEqual([
      'SUCCESS',
      'SUCCESS',
      'SUCCESS'
    ]);
    for (const check of checks.slice(3)) {
      expect(check.id).toMatch(/-post-init$/);
      expect(check.status).toBe('FAILURE');
      expect(check.errorMessage).toContain('Failed to initialize session');
    }
  });

  it('omits session-id header on post-init requests when server is stateless (no session-id returned)', async () => {
    fetchMock.mockImplementation((_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 400 }));
    });

    const checks = await new ServerProtocolVersionHeaderScenario().run(
      serverUrl
    );

    expect(checks).toHaveLength(6);
    for (const check of checks) {
      expect(check.status).toBe('SUCCESS');
    }

    const postInitCalls = fetchMock.mock.calls
      .filter(([, init]) => JSON.parse(init.body).method === 'tools/list')
      .slice(3);
    for (const [, init] of postInitCalls) {
      expect(
        (init.headers as Record<string, string>)['Mcp-Session-Id']
      ).toBeUndefined();
    }
  });

  it('reports independent results when only some header values are rejected', async () => {
    fetchMock.mockImplementation((_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers: { 'mcp-session-id': 's' }
          })
        );
      }
      if (body.method === 'notifications/initialized') {
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      const version = (init.headers as Record<string, string>)[
        'MCP-Protocol-Version'
      ];
      // Simulate a server that only rejects malformed versions, not unsupported dates
      const status = version === 'invalid-protocol-version' ? 400 : 200;
      return Promise.resolve(new Response(null, { status }));
    });

    const checks = await new ServerProtocolVersionHeaderScenario().run(
      serverUrl
    );

    expect(checks[0]).toMatchObject({
      id: 'server-protocol-version-header-malformed',
      status: 'SUCCESS'
    });
    expect(checks[1]).toMatchObject({
      id: 'server-protocol-version-header-unsupported-past',
      status: 'FAILURE',
      details: { sentHeader: '2000-01-01', statusCode: 200 }
    });
    expect(checks[2]?.status).toBe('FAILURE');
    expect(checks[3]?.status).toBe('SUCCESS');
    expect(checks[4]?.status).toBe('FAILURE');
    expect(checks[5]?.status).toBe('FAILURE');
  });
});
