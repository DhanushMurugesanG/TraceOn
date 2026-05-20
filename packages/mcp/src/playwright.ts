import { spawn } from 'child_process';
import type { TestSummary } from '@traceon/core';

export interface RunPlaywrightOptions {
  test: string;
  traceId: string;
  runId: string;
  evidenceDir: string;
  cwd?: string;
}

interface PWStep { title?: string }
interface PWResult { status?: string; steps?: PWStep[]; error?: { message?: string } }
interface PWReport {
  suites?: Array<{
    specs?: Array<{ title?: string; tests?: Array<{ results?: PWResult[] }> }>;
  }>;
}

function classifyStatus(exitCode: number | null, raw?: string): TestSummary['status'] {
  if (exitCode === 0) return 'passed';
  if (raw === 'timedOut') return 'timedOut';
  if (raw === 'interrupted') return 'interrupted';
  return 'failed';
}

export function runPlaywright(opts: RunPlaywrightOptions): Promise<TestSummary> {
  return new Promise((resolvePromise) => {
    const startTs = Date.now();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TRACEON_TRACE_ID: opts.traceId,
      TRACEON_RUN_ID: opts.runId,
      TRACEON_EVIDENCE_DIR: opts.evidenceDir,
    };
    const child = spawn('npx', ['playwright', 'test', opts.test, '--reporter=json'], {
      cwd: opts.cwd,
      env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('error', (err) => {
      resolvePromise({
        file: opts.test,
        name: 'unknown',
        status: 'interrupted',
        duration_ms: Date.now() - startTs,
        steps_executed: [],
        failure_message: `Failed to spawn Playwright: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      try {
        const report = JSON.parse(stdout) as PWReport;
        const spec = report.suites?.[0]?.specs?.[0];
        const result = spec?.tests?.[0]?.results?.[0];
        resolvePromise({
          file: opts.test,
          name: spec?.title ?? 'unknown',
          status: classifyStatus(code, result?.status),
          duration_ms: Date.now() - startTs,
          steps_executed: (result?.steps ?? []).map((s) => s.title ?? '').filter((t) => t.length > 0),
          failure_message: result?.error?.message,
        });
      } catch {
        resolvePromise({
          file: opts.test,
          name: 'unknown',
          status: 'interrupted',
          duration_ms: Date.now() - startTs,
          steps_executed: [],
          failure_message: `Failed to parse Playwright report${stderr ? `: ${stderr.slice(0, 200)}` : ''}`,
        });
      }
    });
  });
}
