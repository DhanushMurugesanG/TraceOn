import type { WaitForTraceOptions } from './interface.js';

/**
 * Tuning for the embedded collector. Declared here (not in client.ts) so the
 * config-shape types don't drag the collector/binary/subprocess subsystem
 * into every module that only needs the shape.
 */
export interface EmbeddedConfig {
  port?: number;
  dataDir?: string;
  /** Override the settle defaults; exposed via the embedded config block. */
  settle?: Partial<WaitForTraceOptions>;
}

/**
 * Backend selection config. A discriminated union on `backend`.
 *
 * v0.2.0 ships `signoz` and `embedded`. `tempo` / `jaeger` / `datadog` /
 * `honeycomb` are future variants per the multi-backend plan.
 */
export interface SigNozBackendConfig {
  backend: 'signoz';
  signoz: {
    baseUrl: string;
    apiKey?: string;
  };
}

export interface EmbeddedBackendConfig {
  backend: 'embedded';
  embedded?: EmbeddedConfig;
}

export type BackendConfig = SigNozBackendConfig | EmbeddedBackendConfig;
