import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform, arch as osArch } from 'node:os';
import { join } from 'node:path';
import { TraceOnError } from '../../errors.js';

/**
 * Lazy download + cache of the otelcol-contrib binary (the contrib
 * distribution — core doesn't include the File exporter we depend on).
 *
 * Pinned to one version so checksum verification is reproducible. The
 * binary lands at ~/.traceon/bin/otelcol-contrib-<version>; presence of
 * that file means "installed" and the download is skipped entirely.
 */
export const OTELCOL_VERSION = '0.154.0';

const RELEASES_BASE =
  'https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download';

/** Platforms we ship for — matches `traceon init`'s darwin/linux support. */
export type SupportedPlatform = 'darwin' | 'linux';
export type SupportedArch = 'amd64' | 'arm64';

export interface PlatformTarget {
  platform: SupportedPlatform;
  arch: SupportedArch;
}

export function detectPlatform(
  rawPlatform: string = osPlatform(),
  rawArch: string = osArch(),
): PlatformTarget {
  if (rawPlatform !== 'darwin' && rawPlatform !== 'linux') {
    throw new TraceOnError(
      'EMBEDDED_PLATFORM_UNSUPPORTED',
      `Embedded mode doesn't support ${rawPlatform} yet`,
      'Embedded mode runs on macOS and Linux. On other platforms, use the SigNoz backend.',
    );
  }
  const arch = rawArch === 'x64' ? 'amd64' : rawArch === 'arm64' ? 'arm64' : null;
  if (!arch) {
    throw new TraceOnError(
      'EMBEDDED_PLATFORM_UNSUPPORTED',
      `Embedded mode doesn't support the ${rawArch} architecture`,
      'Supported architectures: x64 (amd64) and arm64.',
    );
  }
  return { platform: rawPlatform, arch };
}

export function assetName(target: PlatformTarget, version: string = OTELCOL_VERSION): string {
  return `otelcol-contrib_${version}_${target.platform}_${target.arch}.tar.gz`;
}

export function downloadUrl(target: PlatformTarget, version: string = OTELCOL_VERSION): string {
  return `${RELEASES_BASE}/v${version}/${assetName(target, version)}`;
}

export function checksumsUrl(version: string = OTELCOL_VERSION): string {
  return `${RELEASES_BASE}/v${version}/opentelemetry-collector-releases_otelcol-contrib_checksums.txt`;
}

/**
 * Pull the SHA256 for one exact asset out of the release checksums file.
 * Exact-filename match is load-bearing: the file also lists
 * `<asset>.sbom.json` lines, so a substring match grabs the wrong hash.
 */
export function expectedChecksum(checksumsText: string, asset: string): string {
  for (const line of checksumsText.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === asset && hash) return hash.toLowerCase();
  }
  throw new TraceOnError(
    'EMBEDDED_CHECKSUM_MISSING',
    `No checksum found for ${asset}`,
    'The release checksums file did not list this asset. The pinned OTel version may have incomplete release artifacts; report this as a TraceOn bug.',
  );
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function defaultBinDir(): string {
  return join(homedir(), '.traceon', 'bin');
}

/** Final on-disk location for the pinned collector binary. */
export function collectorBinaryPath(binDir: string = defaultBinDir()): string {
  return join(binDir, `otelcol-contrib-${OTELCOL_VERSION}`);
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

export interface EnsureCollectorOptions {
  binDir?: string;
  target?: PlatformTarget;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Progress callback for init-time UX ("downloading 95 MB…"). */
  onProgress?: (message: string) => void;
}

/**
 * Ensure the pinned otelcol-contrib binary exists locally; download,
 * checksum-verify, and extract it if not. Returns the binary path.
 * Idempotent — a successful prior install short-circuits everything.
 */
export async function ensureCollectorBinary(opts: EnsureCollectorOptions = {}): Promise<string> {
  const binDir = opts.binDir ?? defaultBinDir();
  const target = opts.target ?? detectPlatform();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const progress = opts.onProgress ?? (() => {});

  const finalPath = collectorBinaryPath(binDir);
  if (existsSync(finalPath)) return finalPath;

  mkdirSync(binDir, { recursive: true });
  const asset = assetName(target);

  progress(`Fetching checksums for otelcol-contrib v${OTELCOL_VERSION}…`);
  const checksumsRes = await fetchImpl(checksumsUrl());
  if (!checksumsRes.ok) {
    throw new TraceOnError(
      'EMBEDDED_DOWNLOAD_FAILED',
      `Failed to fetch collector checksums (HTTP ${checksumsRes.status})`,
      'Check your network connection and retry `traceon init`. GitHub may also be rate-limiting; wait a minute and retry.',
    );
  }
  const expected = expectedChecksum(await checksumsRes.text(), asset);

  progress(`Downloading ${asset} (~95 MB)…`);
  const tarballRes = await fetchImpl(downloadUrl(target));
  if (!tarballRes.ok) {
    throw new TraceOnError(
      'EMBEDDED_DOWNLOAD_FAILED',
      `Failed to download ${asset} (HTTP ${tarballRes.status})`,
      'Check your network connection and retry `traceon init`.',
    );
  }
  const tarball = new Uint8Array(await tarballRes.arrayBuffer());

  const actual = sha256(tarball);
  if (actual !== expected) {
    throw new TraceOnError(
      'EMBEDDED_CHECKSUM_MISMATCH',
      `Checksum mismatch for ${asset}`,
      `Expected ${expected}, got ${actual}. The download may be corrupted or tampered with — retry; if it persists, report it.`,
    );
  }

  // Extract in a scratch dir next to the final location so a half-finished
  // install never masquerades as a completed one (presence of finalPath is
  // the only "installed" signal).
  const workDir = join(binDir, `.extract-${OTELCOL_VERSION}`);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  try {
    const tarPath = join(workDir, asset);
    writeFileSync(tarPath, tarball);
    progress('Verifying and extracting…');
    await run('tar', ['-xzf', tarPath, 'otelcol-contrib'], workDir);

    const extracted = join(workDir, 'otelcol-contrib');
    chmodSync(extracted, 0o755);
    if (target.platform === 'darwin') {
      // curl/Node downloads don't set com.apple.quarantine (verified in the
      // v0.2.0 spike), but clear it defensively in case the file came in via
      // a quarantining path. Failure here is fine — usually "no such xattr".
      await run('xattr', ['-d', 'com.apple.quarantine', extracted], workDir).catch(() => {});
    }
    renameSync(extracted, finalPath);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  progress(`Installed otelcol-contrib v${OTELCOL_VERSION} at ${finalPath}`);
  return finalPath;
}
