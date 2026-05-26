import type { SpecVersion } from '../types';
import type { MockServer, RequestHandlers } from './index';
import { isStatefulVersion } from '../connection/select';
import { createServerStateful } from './stateful';
import { createServerStateless } from './stateless';

export function createServerFor(
  specVersion: SpecVersion
): (handlers: RequestHandlers) => Promise<MockServer> {
  return isStatefulVersion(specVersion)
    ? createServerStateful
    : createServerStateless;
}
