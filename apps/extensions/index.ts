// Public surface of `@projekt-manga/extensions`: the scraper's anti-detection stats/health
// (e.g. for a server health route) and the sandbox spawner. Sources themselves are never
// imported here; they are installed at runtime and run sandboxed.

export { getOrchestrator } from './features/Orchestrator.js';
export { getCacheStats } from './utils/scraper.js';
export { getSourceCircuitBreaker } from './features/SourceCircuitBreaker.js';
export type { ProxyPoolStats } from './features/ProxyManager.js';
export type { DetectionStats, LogEntry } from './features/DetectionLogger.js';
export type { CacheStats } from './utils/cache.js';
export type { CircuitBreakerStats } from './features/SourceCircuitBreaker.js';

// The server spawns one sandboxed child per installed extension instead of importing its
// code; see sandbox/runner.ts for what runs inside the restricted process.
export { spawnSandboxedSource } from './sandbox/index.js';
export type { SandboxedSourceMetadata, SandboxedSourceOptions } from './sandbox/index.js';
