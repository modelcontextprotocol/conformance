/**
 * MCP Checker — Auth Chain — dedicated val.town entry, mounted at the
 * origin root (the val URL is the MCP endpoint; well-knowns are
 * origin-rooted). See src/scenarios/client/auth-checker.ts.
 */

import { AuthCheckerScenario } from '../../src/scenarios/client/auth-checker';
import { toFetchHandler } from './fetch-bridge';

let origin = 'https://invalid.example';

const scenario = new AuthCheckerScenario();
const bridge = toFetchHandler(scenario.handler(() => origin));

export default function (request: Request): Promise<Response> {
  origin = new URL(request.url).origin;
  return bridge(request);
}
