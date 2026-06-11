export * from './types.js';
export { rank, DEFAULT_RANKER_CONFIG, RankerTier1OverflowError } from './ranker.js';
export { SigNozClient } from './backends/signoz.js';
export type { SigNozConfig } from './backends/signoz.js';
export { createBackend } from './backends/factory.js';
export type { BackendConfig, SigNozBackendConfig, EmbeddedBackendConfig } from './backends/config.js';
export type {
  EvidenceBackend,
  WaitForTraceOptions,
  LogTimeWindow,
} from './backends/interface.js';
export {
  EmbeddedBackend,
  getEmbeddedBackend,
  shutdownEmbeddedBackend,
  defaultDataDir,
} from './backends/embedded/client.js';
export type { EmbeddedConfig, CollectorLike } from './backends/embedded/client.js';
export { ensureCollectorBinary, OTELCOL_VERSION, collectorBinaryPath } from './backends/embedded/binary.js';
export { EmbeddedCollector, DEFAULT_OTLP_PORT } from './backends/embedded/collector.js';
export { parseTraces, parseLogs } from './backends/embedded/parser.js';
export { redactObject, redactString } from './redact.js';
export type { RedactionRecord, RedactResult } from './redact.js';
export { computeCoverage } from './coverage.js';
export { gatherEvidence } from './gather.js';
export type { GatherOptions, GatherResult } from './gather.js';
export { TraceOnError } from './errors.js';
export type { TraceOnErrorCode } from './errors.js';
