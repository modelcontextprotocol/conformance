import type { SpecVersion } from '../types';
import type { MockHandler, MockServer, RequestHandlers } from './index';
import { isStatefulVersion } from '../connection/select';
import { createHandlerStateful, createServerStateful } from './stateful';
import { createHandlerStateless, createServerStateless } from './stateless';

export function createServerFor(
  specVersion: SpecVersion
): (handlers: RequestHandlers) => Promise<MockServer> {
  return isStatefulVersion(specVersion)
    ? (handlers) => createServerStateful(handlers, specVersion)
    : (handlers) => createServerStateless(handlers, specVersion);
}

export function createHandlerFor(
  specVersion: SpecVersion
): (handlers: RequestHandlers) => MockHandler {
  return isStatefulVersion(specVersion)
    ? (handlers) => createHandlerStateful(handlers, specVersion)
    : (handlers) => createHandlerStateless(handlers, specVersion);
}
