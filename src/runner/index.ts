// Export client functions
export {
  runConformanceTest,
  printClientResults,
  runInteractiveMode,
  type ClientExecutionResult
} from './client';

// Export remote (hosted-server) functions
export {
  runRemoteConformanceTest,
  writeRemoteResult,
  type RemoteRunOptions,
  type RemoteRunResult
} from './remote';

// Export server functions
export {
  runServerConformanceTest,
  printServerResults,
  printServerSummary
} from './server';

// Export utilities
export {
  createResultDir,
  formatPrettyChecks,
  getStatusColor,
  COLORS
} from './utils';
