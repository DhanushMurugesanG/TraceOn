import type { EvidenceBackend } from './interface.js';
import type { BackendConfig } from './config.js';
import { SigNozClient } from './signoz.js';
import { getEmbeddedBackend } from './embedded/client.js';

/**
 * Build the configured evidence backend. gather.ts/verify.ts construct via
 * this factory rather than `new SigNozClient(...)` so adding a backend is a
 * one-case change here, not a change at every call site.
 *
 * Async because the embedded backend may need to resolve (and on a cold
 * machine, download) the collector binary.
 */
export async function createBackend(config: BackendConfig): Promise<EvidenceBackend> {
  switch (config.backend) {
    case 'signoz': {
      const signozConfig: { baseUrl: string; apiKey?: string } = {
        baseUrl: config.signoz.baseUrl,
      };
      if (config.signoz.apiKey) signozConfig.apiKey = config.signoz.apiKey;
      return new SigNozClient(signozConfig);
    }
    case 'embedded':
      return getEmbeddedBackend(config.embedded ?? {});
    default:
      throw new Error(`Unknown backend: ${(config as { backend: string }).backend}`);
  }
}
