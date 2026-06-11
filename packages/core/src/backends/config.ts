import type { EmbeddedConfig } from './embedded/client.js';

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
