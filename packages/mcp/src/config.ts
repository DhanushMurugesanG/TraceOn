export interface TraceOnConfig {
  signozBaseUrl: string;
  signozApiKey?: string;
  evidenceRootDir: string;
}

/**
 * v1 config loader. Pulls from env vars; ignores the `env` arg
 * (named environments from .traceonrc.yaml are a v1.1 concern).
 */
export function loadConfig(_env: string = 'default'): TraceOnConfig {
  const apiKey = process.env['SIGNOZ_API_KEY'];
  const cfg: TraceOnConfig = {
    signozBaseUrl: process.env['SIGNOZ_BASE_URL'] ?? 'http://localhost:8080',
    evidenceRootDir: process.env['TRACEON_EVIDENCE_ROOT'] ?? '.traceon/runs',
  };
  if (apiKey) cfg.signozApiKey = apiKey;
  return cfg;
}
