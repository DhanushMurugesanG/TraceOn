import type { EvidenceBackend } from './interface.js';
import type { BackendConfig } from './config.js';
import { SigNozClient } from './signoz.js';

/**
 * Build the configured evidence backend. gather.ts/verify.ts construct via
 * this factory rather than `new SigNozClient(...)` so adding a backend is a
 * one-case change here, not a change at every call site.
 */
export function createBackend(config: BackendConfig): EvidenceBackend {
  switch (config.backend) {
    case 'signoz': {
      const signozConfig: { baseUrl: string; apiKey?: string } = {
        baseUrl: config.signoz.baseUrl,
      };
      if (config.signoz.apiKey) signozConfig.apiKey = config.signoz.apiKey;
      return new SigNozClient(signozConfig);
    }
    default:
      throw new Error(`Unknown backend: ${(config as { backend: string }).backend}`);
  }
}
