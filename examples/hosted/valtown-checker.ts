/**
 * MCP Checker — 2026-07-28 (stateless draft) — dedicated val.town entry.
 *
 * This val IS the checker: the gauntlet scenario is mounted at the ORIGIN
 * ROOT, so the val URL is the MCP endpoint itself (no /x/<scenario> path),
 * the RFC 9728/8414 well-knowns are origin-rooted, and client configuration
 * is just the val URL. One val = one spec version; other versions get their
 * own checker vals.
 *
 *   POST /            the MCP endpoint (strict: stateless draft only)
 *   POST /lenient     advisory mode — classic flows complete, gaps reported
 *   GET  /            HTML explainer (browsers) / JSON hint (everyone else)
 *   /oauth/*          the initialize consent gate's mini-AS
 */

import { StatelessGauntletScenario } from '../../src/scenarios/client/stateless-gauntlet';
import { toFetchHandler } from './fetch-bridge';

// The base URL is the request origin; handler() reads it lazily per request,
// and it is constant for a deployed val, so a module-level cell is safe.
let origin = 'https://invalid.example';

const scenario = new StatelessGauntletScenario();
const bridge = toFetchHandler(scenario.handler(() => origin));

export default function (request: Request): Promise<Response> {
  origin = new URL(request.url).origin;
  return bridge(request);
}
