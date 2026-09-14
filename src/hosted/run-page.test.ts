import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import { createHostedApp, type RunConfig } from './server';
import { MemoryRunStore } from './store';
import { buildMatrix } from './matrix';
import { CLIENTS, clientConfig, serverName } from './client-config';
import {
  configPicker,
  JUST_THE_URL,
  PICKER_STORAGE_KEY,
  pickerScript
} from './config-picker';
import {
  ago,
  renderRunPage,
  runClientEntries,
  startableSentence,
  STARTER_AUTH
} from './run-page';
import type { CellLive, RunLive } from './run-status';
import { escapeHtml as esc } from './escape';
import type { CellState } from './report';
import { REACHED } from './markdown';

const STATELESS = '2026-07-28';
const STATEFUL = '2025-11-25';

/** The page's text with tags dropped and whitespace folded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/** A deployment with the sign-in relay, so its auth cells can start. */
const withAuth = () =>
  createHostedApp({
    auxOrigins: { as: 'https://as.example' },
    relaySecret: 'x'
  });

async function listen(app: ReturnType<typeof createHostedApp>['app']) {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return { server, origin: `http://localhost:${port}` };
}

const close = (server: Server) =>
  new Promise<void>((r) => server.close(() => r()));

const html = (url: string) =>
  fetch(url, { headers: { accept: 'text/html' } }).then((r) => r.text());

describe('the config picker', () => {
  const entries = [
    { name: 'c9e-a', url: 'https://h.example/s/r/2026-07-28/a/mcp' },
    { name: 'c9e-b', url: 'https://h.example/s/r/2026-07-28/b/mcp' }
  ];

  it('shows the URL by default, and each client’s block for exactly its entries behind the select', () => {
    const picker = configPicker(entries);
    expect(picker).toContain(
      `<option value=${JUST_THE_URL}>Just the URL (works with any client)</option>`
    );
    // The URL panel is the only one shown without script.
    expect(picker).toContain(`<div data-pick=${JUST_THE_URL}><ul class=urls>`);
    for (const e of entries) {
      expect(picker).toContain(
        `<button class=copy data-copy-text="${e.url}">copy URL</button>`
      );
    }
    for (const c of CLIENTS) {
      expect(picker).toContain(`<option value="${c.kind}">${c.label}</option>`);
      expect(picker).toContain(`<div data-pick="${c.kind}" hidden>`);
      expect(picker).toContain(
        `data-copy-text="${esc(clientConfig(c.kind, entries))}">copy</button>`
      );
    }
    expect(
      configPicker(entries, { urlPanel: '<p>listed below</p>' })
    ).toContain(`<div data-pick=${JUST_THE_URL}><p>listed below</p></div>`);
  });

  /** Runs pickerScript against a stand-in page with one picker. */
  function runScript(storage: {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
  }) {
    const kinds = [JUST_THE_URL, ...CLIENTS.map((c) => c.kind)];
    const panels = kinds.map((kind) => ({
      kind,
      hidden: kind !== JUST_THE_URL,
      getAttribute: () => kind
    }));
    let onChange = () => {};
    const box = { querySelectorAll: () => panels };
    const select = {
      value: JUST_THE_URL as string,
      options: kinds.map((value) => ({ value })),
      closest: () => box,
      addEventListener: (_: string, fn: () => void) => (onChange = fn)
    };
    const document = { querySelectorAll: () => [select] };
    const body = pickerScript.replace(/^<script>|<\/script>$/g, '');
    new Function('document', 'localStorage', body)(document, storage);
    const shown = () => panels.filter((p) => !p.hidden).map((p) => p.kind);
    return {
      shown,
      choose(kind: string) {
        select.value = kind;
        onChange();
      }
    };
  }

  it('opens on the choice remembered in this browser, and remembers a new one', () => {
    const saved = new Map([[PICKER_STORAGE_KEY, 'goose']]);
    const storage = {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v)
    };
    const page = runScript(storage);
    expect(page.shown()).toEqual(['goose']);
    page.choose('codex');
    expect(page.shown()).toEqual(['codex']);
    expect(saved.get(PICKER_STORAGE_KEY)).toBe('codex');
  });

  it('shows the URL when storage is blocked or holds a choice it does not offer', () => {
    const blocked = {
      getItem: (): string | null => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      }
    };
    const page = runScript(blocked);
    expect(page.shown()).toEqual([JUST_THE_URL]);
    page.choose('vscode');
    expect(page.shown()).toEqual(['vscode']);
    const stale = runScript({ getItem: () => 'emacs', setItem: () => {} });
    expect(stale.shown()).toEqual([JUST_THE_URL]);
  });
});

describe('the run page', () => {
  const hosted = withAuth();
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    ({ server, origin } = await listen(hosted.app));
  });
  afterAll(async () => {
    await hosted.sessions.close();
    await close(server);
  });

  it('says how many cells can start at each revision', async () => {
    const page = text(await html(`${origin}/s/counts`));
    // Today's catalog with the sign-in relay: 18 and 31, not "49 at every
    // revision".
    expect(page).toContain(
      `At ${STATEFUL}, 18 cells can start here, and at ${STATELESS}, 31 can.`
    );
    const column = text(await html(`${origin}/s/counts/${STATELESS}`));
    expect(column).toContain(`At ${STATELESS}, 31 cells can start here.`);
    expect(
      startableSentence(
        [{ revision: 'a' }, { revision: 'b' }, { revision: 'c' }],
        ['a', 'b', 'c']
      )
    ).toBe(
      'At <code>a</code>, 1 cell can start here, at <code>b</code>, 1 can, and at <code>c</code>, 1 can.'
    );
  });

  it('puts the URLs in order: one per revision, the cells on their own, then auth from metadata-default', async () => {
    const page = await html(`${origin}/s/order`);
    const at = (s: string) => {
      const i = page.indexOf(s);
      expect(i, s).toBeGreaterThan(0);
      return i;
    };
    const composite = at(
      `/s/order/${STATELESS}/tools_call+http-standard-headers`
    );
    const own = at(`href="/s/order/${STATELESS}/request-metadata"`);
    const starter = at(`href="/s/order/${STATEFUL}/${STARTER_AUTH}"`);
    const folded = at(`href="/s/order/${STATELESS}/auth/resource-mismatch"`);
    expect(composite).toBeLessThan(own);
    expect(own).toBeLessThan(starter);
    expect(starter).toBeLessThan(folded);
    // The rest of the auth cells are folded by group.
    expect(page).toMatch(
      /<details id="auth-metadata"><summary>Metadata discovery \(\d+\)/
    );
    expect(page).toContain('<details id="auth-issuer"><summary>Issuer checks');
    expect(page.lastIndexOf('<details id="auth-', starter)).toBe(-1);
  });

  it('has one picker whose blocks cover only the starter set, and links the bulk page', async () => {
    const page = await html(`${origin}/s/pick`);
    expect(page.match(/<select data-picker/g)).toHaveLength(1);
    const config = (await fetch(`${origin}/s/pick?format=json`).then((r) =>
      r.json()
    )) as RunConfig;
    const { starter, all } = runClientEntries(origin, hosted.matrix, config);
    expect(starter.map((e) => e.name)).toEqual([
      `c9e-${STATEFUL}-composite`,
      `c9e-${STATELESS}-composite`,
      serverName(STATEFUL, STARTER_AUTH),
      serverName(STATELESS, STARTER_AUTH)
    ]);
    for (const c of CLIENTS) {
      expect(page).toContain(esc(clientConfig(c.kind, starter)));
      expect(page).not.toContain(esc(clientConfig(c.kind, all)));
    }
    expect(page).toContain(`<a href="/s/pick/bulk">bulk page</a>`);
    // "copy all" is the bulk page's, not this one's.
    expect(page).not.toContain('data-copy="all"');
    expect(page).not.toContain('copy all');
  });
});

describe('the bulk page', () => {
  const hosted = withAuth();
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    ({ server, origin } = await listen(hosted.app));
  });
  afterAll(async () => {
    await hosted.sessions.close();
    await close(server);
  });

  it('holds every client’s full block, with copy all', async () => {
    const page = await html(`${origin}/s/bulk1/bulk`);
    const config = (await fetch(`${origin}/s/bulk1?format=json`).then((r) =>
      r.json()
    )) as RunConfig;
    const { all } = runClientEntries(origin, hosted.matrix, config);
    expect(all.length).toBeGreaterThan(30);
    for (const c of CLIENTS) {
      const block = esc(clientConfig(c.kind, all));
      expect(page).toContain(
        `<button class=copy data-copy-text="${block}">copy all ${all.length}</button>`
      );
      expect(page).toContain(`<b>${c.label}</b>`);
    }
    expect(page).toContain(
      `<button class=copy data-copy="all">copy mcpServers for all ${config.cells.length}</button>`
    );
    // The run's matrix, every startable cell linked.
    expect(page).toContain(
      `<a href="/s/bulk1/${STATELESS}/tools_call">open</a>`
    );
    expect(page).toContain('<script type="application/json" id="cfg">');

    const json = await fetch(`${origin}/s/bulk1/bulk?format=json`).then((r) =>
      r.json()
    );
    expect(json.cells).toHaveLength(config.cells.length);
    for (const c of CLIENTS) {
      expect(json.clients[c.kind]).toBe(clientConfig(c.kind, all));
    }
  });

  it('is only a GET, and "bulk" is not a revision anywhere else', async () => {
    expect(
      (await fetch(`${origin}/s/bulk1/bulk`, { method: 'POST' })).status
    ).toBe(405);
    expect((await fetch(`${origin}/results/bulk1/bulk`)).status).toBe(404);
  });
});

/**
 * The live line on every URL reads the stored log, as the report does: two
 * apps over one store stand in for two isolates, and the cells are evicted
 * from the one that served them before the other renders the page.
 */
describe('the run page’s live status across processes', () => {
  const store = new MemoryRunStore();
  let now = Date.now();
  const apps = [
    createHostedApp({ store }),
    createHostedApp({ store, clock: () => now })
  ];
  const servers: Server[] = [];
  const origins: string[] = [];

  beforeAll(async () => {
    for (const { app } of apps) {
      const { server, origin } = await listen(app);
      servers.push(server);
      origins.push(origin);
    }
  });
  afterAll(async () => {
    for (const { sessions } of apps) await sessions.close();
    await Promise.all(servers.map(close));
  });

  /** A SEP-2575 stateless request, with the SEP-2243 headers. */
  async function send(
    base: string,
    path: string,
    method: string,
    params: object = {}
  ) {
    const name = (params as { name?: string }).name;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': STATELESS,
        'mcp-method': method,
        ...(name && { 'mcp-name': name })
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': STATELESS,
            'io.modelcontextprotocol/clientInfo': {
              name: 'live-client',
              version: '7.1'
            },
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        }
      })
    });
    // request-metadata turns the run's first request away on purpose.
    expect([200, 400]).toContain(res.status);
    return res.text();
  }

  /** The live line after a link or row naming `scenario` at `revision`. */
  function line(page: string, run: string, revision: string, scenario: string) {
    const at = page.indexOf(`href="/s/${run}/${revision}/${scenario}"`);
    expect(at, scenario).toBeGreaterThan(0);
    const stat = page.indexOf('<div class=stat>', at);
    return text(page.slice(stat, page.indexOf('</div>', stat)));
  }

  it('shows each URL’s state with the time and the client, from the stored log after eviction', async () => {
    const [a, b] = origins;
    const run = 'liverun';
    now = Date.now();
    // Turned away once on purpose, then accepted: the client retries.
    await send(a, `/s/${run}/${STATELESS}/request-metadata/mcp`, 'tools/list');
    await send(a, `/s/${run}/${STATELESS}/request-metadata/mcp`, 'tools/list');
    await send(
      a,
      `/s/${run}/${STATELESS}/http-invalid-tool-headers/mcp`,
      'tools/list'
    );
    await apps[0].sessions.flush();
    // Process a forgets the run, as its sweep would; b never saw it.
    for (const r of apps[0].sessions.list())
      if (r.runId === run) await apps[0].sessions.destroy(r.id, false);

    const states = async (base: string) => {
      const report = await fetch(`${base}/results/${run}`).then((r) =>
        r.json()
      );
      const col = report.columns.find(
        (c: { revision: string }) => c.revision === STATELESS
      );
      return Object.fromEntries(
        col.cells
          .filter((c: { state: CellState }) => REACHED.includes(c.state))
          .map((c: { scenario: string; state: CellState }) => [
            c.scenario,
            c.state
          ])
      );
    };
    const judged = await states(b);
    expect(Object.keys(judged).sort()).toEqual([
      'http-invalid-tool-headers',
      'request-metadata'
    ]);

    now += 30_000;
    const page = await html(`${b}/s/${run}`);
    for (const scenario of Object.keys(judged)) {
      const said = line(page, run, STATELESS, scenario);
      expect(said, scenario).toContain(LIVE[judged[scenario] as CellState]);
      expect(said, scenario).toMatch(
        /last request 3\d s ago by live-client 7\.1/
      );
    }
    // Nothing else was reached.
    expect(
      line(page, run, STATEFUL, 'elicitation-sep1034-client-defaults')
    ).toBe(LIVE['not-tried']);
    expect(text(page)).toContain(
      `Your client has reached 2 cells so far, and ${
        Object.values(judged).filter((s) => s !== 'pass').length || 'none'
      }`
    );
    // The same from the process that served it, rebuilt from the store.
    const onA = await html(`${a}/s/${run}`);
    for (const scenario of Object.keys(judged)) {
      expect(line(onA, run, STATELESS, scenario)).toContain(
        LIVE[judged[scenario] as CellState]
      );
    }
  });

  it('turns a waiting composite child to stopped once its client goes quiet', async () => {
    const [a, b] = origins;
    const run = 'livequiet';
    now = Date.now();
    await send(a, `/s/${run}/${STATELESS}/tools_call/mcp`, 'tools/list');
    await apps[0].sessions.flush();
    const composite = (page: string) => {
      const at = page.indexOf(
        `<span class=url><code>${b}/s/${run}/${STATELESS}/tools_call+`
      );
      expect(at).toBeGreaterThan(0);
      const stat = page.indexOf('<div class=stat>', at);
      return text(page.slice(stat, page.indexOf('<details', stat)));
    };
    const waiting = composite(await html(`${b}/s/${run}`));
    expect(waiting).toContain('◔ waiting 1 of 5 scenarios reached');
    expect(waiting).toContain('by live-client 7.1');
    now += 3 * 60_000;
    const stopped = composite(await html(`${b}/s/${run}`));
    expect(stopped).toContain('■ stopped 1 of 5 scenarios reached');
    expect(stopped).toContain('last request 3 min ago');
  });
});

const LIVE: Record<CellState, string> = {
  pass: '✓ reached',
  fail: '✗ fails',
  stopped: '■ stopped',
  waiting: '◔ waiting',
  'in-progress': '◑ in progress',
  incomplete: '◐ stopped short',
  'not-tried': '○ not reached yet',
  'not-startable': '⊘ unavailable',
  'n/a': '– not part of this revision'
};

describe('the live line', () => {
  const matrix = buildMatrix({ auxOrigins: { as: 'https://as.example' } });
  const cells = matrix
    .cells()
    .filter((c) => c.startable)
    .map((c) => ({
      scenario: c.scenario,
      revision: c.revision,
      url: `http://x/s/r/${c.revision}/${c.scenario}/mcp`,
      resultsUrl: `http://x/results/r/${c.revision}/${c.scenario}`,
      scoring: c.scoring,
      env: {
        MCP_CONFORMANCE_SCENARIO: c.scenario,
        MCP_CONFORMANCE_PROTOCOL_VERSION: c.revision
      }
    }));
  const config: RunConfig = {
    runId: 'r',
    resultsUrl: 'http://x/results/r',
    mcpServers: {},
    cells
  };
  const now = Date.parse('2026-09-14T10:00:00Z');
  const cell = (state: CellState, name?: string): CellLive => ({
    state,
    lastRequestAt: '2026-09-14T09:59:48Z',
    identities: name ? [{ name, version: '1.0', protocolVersions: [] }] : [],
    resultsUrl: 'http://x/results/r/cell'
  });

  it('says every state with a glyph and a word, and counts what needs a look', () => {
    const live: RunLive = {
      cells: new Map([
        [`${STATELESS}/request-metadata`, cell('fail', 'c')],
        [`${STATEFUL}/sse-retry`, cell('stopped')],
        [`${STATEFUL}/${STARTER_AUTH}`, cell('waiting', 'c')],
        [`${STATELESS}/${STARTER_AUTH}`, cell('pass', 'c')],
        [`${STATELESS}/http-invalid-tool-headers`, cell('incomplete')],
        [`${STATEFUL}/elicitation-sep1034-client-defaults`, cell('in-progress')]
      ]),
      reached: 6,
      needsLook: 5,
      now
    };
    const page = renderRunPage('http://x', matrix, config, live);
    for (const state of [
      'fail',
      'stopped',
      'waiting',
      'pass',
      'incomplete',
      'in-progress',
      'not-tried'
    ] as CellState[]) {
      expect(page, state).toContain(`>${LIVE[state]}</span>`);
    }
    expect(text(page)).toContain('✗ fails last request 12 s ago by c 1.0');
    expect(text(page)).toContain(
      'Your client has reached 6 cells so far, and 5 need a look. Open the results'
    );
    expect(page).toContain(
      '<a class=btn href="http://x/results/r">Open the results</a>'
    );
    // A fold's summary counts what is reached in it; its id keeps it open
    // across refreshes.
    expect(text(page)).not.toContain('Metadata discovery (6) ·');
  });

  it('says so when nothing has been reached', () => {
    const page = renderRunPage('http://x', matrix, config, {
      cells: new Map(),
      reached: 0,
      needsLook: 0,
      now
    });
    expect(text(page)).toContain('Your client has not reached any cell yet.');
    expect(page).not.toContain('last request');
  });

  it('writes how long ago in the largest unit that fits', () => {
    const t = '2026-09-14T10:00:00Z';
    const at = (ms: number) => ago(t, Date.parse(t) + ms);
    expect(at(2_000)).toBe('just now');
    expect(at(12_000)).toBe('12 s ago');
    expect(at(3 * 60_000 + 5_000)).toBe('3 min ago');
    expect(at(5 * 3_600_000)).toBe('5 h ago');
    expect(at(3 * 86_400_000)).toBe('3 days ago');
  });
});
