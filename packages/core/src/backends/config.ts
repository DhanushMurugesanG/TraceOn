/**
 * Backend selection config. A discriminated union on `backend`.
 *
 * v0.2.0 ships `signoz` and `embedded`. Phase 0 (this refactor) defines only
 * `signoz`; the `embedded` variant is added in the embedded-backend phase.
 * `tempo` / `jaeger` / `datadog` / `honeycomb` are future variants per the
 * multi-backend plan.
 */
export interface SigNozBackendConfig {
  backend: 'signoz';
  signoz: {
    baseUrl: string;
    apiKey?: string;
  };
}

export type BackendConfig = SigNozBackendConfig;
