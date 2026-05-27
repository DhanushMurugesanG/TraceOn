/**
 * Shared types for `traceon doctor` checks.
 *
 * Each check is a small async function (cwd-based, idempotent, read-only)
 * that returns a structured CheckResult. The doctor runner accumulates
 * shared state on DoctorContext as earlier checks discover it (e.g. the
 * baseURL parsed from playwright.config.ts is needed by later checks).
 */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface CheckResult {
  /** Display name, e.g. "CORS allows traceparent". */
  name: string;
  status: CheckStatus;
  /** What was checked, in past tense. */
  message: string;
  /** Why it failed or extra context. Multi-line allowed. */
  detail?: string;
  /** Copy-pasteable remediation, when applicable. Multi-line allowed. */
  fix?: string;
}

/**
 * Mutable state accumulated as checks run. Earlier checks set fields that
 * later checks read. All fields optional — checks must handle "not found".
 */
export interface DoctorContext {
  /** The directory the user is checking — usually process.cwd(). */
  cwd: string;
  /** The discovered project root (nearest package.json upward). */
  projectRoot: string;

  /** baseURL extracted from playwright.config.ts, if any. */
  playwrightBaseUrl?: string;
  /** webServer.url extracted from playwright.config.ts, if any. */
  playwrightWebServerUrl?: string;
  /** First backend URL inferred from vite proxy / .env / defaults, if any.
   *  Kept for compatibility; new code should prefer backendUrls. */
  backendUrl?: string;
  /** All distinct backend URLs detected (vite proxy entries, .env vars,
   *  common defaults). Empty if none detected. The CORS check iterates
   *  over the full list, so multi-backend apps don't silently miss the
   *  second backend's CORS gap. */
  backendUrls?: string[];
  /** SigNoz URL inferred from the user's MCP server config, if any. */
  signozBaseUrl?: string;
}

export type CheckFn = (ctx: DoctorContext) => Promise<CheckResult>;
