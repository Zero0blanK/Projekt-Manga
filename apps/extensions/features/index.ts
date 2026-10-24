/**
 * Anti-detection module barrel.
 */

// Configuration
export type {
  AntiDetectionConfig,
  BrowserFingerprint,
  ProxyConfig,
  ProxyType,
  UserAgentProfile,
  FingerprintConfig,
  DelayConfig,
  SessionConfig,
  LoggingConfig,
} from '../config/anon.config.js';

export {
  REALISTIC_USER_AGENT_PROFILES,
  TIMEZONE_POOL,
  WEBGL_VENDORS,
  WEBGL_RENDERERS,
  defaultAntiDetectionConfig,
  getAntiDetectionConfig,
  setAntiDetectionConfig,
  resetAntiDetectionConfig,
} from '../config/anon.config.js';

// Proxy Manager
export type { ProxyHealth, ProxyPoolStats, RotationStrategy } from './ProxyManager.js';
export { ProxyManager, getProxyManager, resetProxyManager } from './ProxyManager.js';

// User Agent Manager
export {
  UserAgentManager,
  getUserAgentManager,
  resetUserAgentManager,
} from './UserAgentManager.js';

// Fingerprint Manager
export {
  FingerprintManager,
  getFingerprintManager,
  resetFingerprintManager,
} from './FingerprintManager.js';

// Session Manager
export type { Session, Cookie } from './SessionManager.js';
export { SessionManager, getSessionManager, resetSessionManager } from './SessionManager.js';

// Human Behavior
export { HumanBehavior, getHumanBehavior, resetHumanBehavior } from './HumanBehavior.js';

// Detection Logger
export type { LogEntry, DetectionStats } from './DetectionLogger.js';
export { DetectionLogger, DetectionEvent, getLogger, resetLogger } from './DetectionLogger.js';

// Orchestrator
export type { AntiDetectionContext, FetchResult } from './Orchestrator.js';
export { AntiDetectionOrchestrator, getOrchestrator } from './Orchestrator.js';
