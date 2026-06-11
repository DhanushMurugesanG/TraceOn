import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OTELCOL_VERSION,
  detectPlatform,
  assetName,
  downloadUrl,
  checksumsUrl,
  expectedChecksum,
  sha256,
  collectorBinaryPath,
  ensureCollectorBinary,
} from '../../src/backends/embedded/binary.js';
import { TraceOnError } from '../../src/errors.js';

describe('detectPlatform', () => {
  it('maps node platform/arch to release naming', () => {
    expect(detectPlatform('darwin', 'arm64')).toEqual({ platform: 'darwin', arch: 'arm64' });
    expect(detectPlatform('darwin', 'x64')).toEqual({ platform: 'darwin', arch: 'amd64' });
    expect(detectPlatform('linux', 'x64')).toEqual({ platform: 'linux', arch: 'amd64' });
    expect(detectPlatform('linux', 'arm64')).toEqual({ platform: 'linux', arch: 'arm64' });
  });

  it('rejects unsupported platforms and arches with TraceOnError', () => {
    expect(() => detectPlatform('win32', 'x64')).toThrowError(TraceOnError);
    expect(() => detectPlatform('darwin', 'ia32')).toThrowError(TraceOnError);
    try {
      detectPlatform('win32', 'x64');
    } catch (e) {
      expect((e as TraceOnError).code).toBe('EMBEDDED_PLATFORM_UNSUPPORTED');
    }
  });
});

describe('release URLs', () => {
  const target = { platform: 'darwin', arch: 'arm64' } as const;

  it('builds the versioned asset name', () => {
    expect(assetName(target, '0.154.0')).toBe('otelcol-contrib_0.154.0_darwin_arm64.tar.gz');
  });

  it('builds the GitHub release download URL', () => {
    expect(downloadUrl(target, '0.154.0')).toBe(
      'https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.154.0/otelcol-contrib_0.154.0_darwin_arm64.tar.gz',
    );
  });

  it('builds the checksums URL', () => {
    expect(checksumsUrl('0.154.0')).toBe(
      'https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.154.0/opentelemetry-collector-releases_otelcol-contrib_checksums.txt',
    );
  });
});

describe('expectedChecksum', () => {
  // Mirrors the real file: each asset also has an .sbom.json line, which is
  // exactly the trap a substring match falls into.
  const checksums = [
    'aaaa  otelcol-contrib_0.154.0_darwin_amd64.tar.gz',
    'BBBB  otelcol-contrib_0.154.0_darwin_arm64.tar.gz',
    'cccc  otelcol-contrib_0.154.0_darwin_arm64.tar.gz.sbom.json',
    'dddd  otelcol-contrib_0.154.0_linux_amd64.tar.gz',
  ].join('\n');

  it('returns the hash for the exact asset, lowercased', () => {
    expect(expectedChecksum(checksums, 'otelcol-contrib_0.154.0_darwin_arm64.tar.gz')).toBe('bbbb');
  });

  it('does not substring-match the sbom line', () => {
    expect(expectedChecksum(checksums, 'otelcol-contrib_0.154.0_darwin_amd64.tar.gz')).toBe('aaaa');
  });

  it('throws EMBEDDED_CHECKSUM_MISSING for unknown assets', () => {
    try {
      expectedChecksum(checksums, 'otelcol-contrib_0.154.0_linux_arm64.tar.gz');
      expect.unreachable();
    } catch (e) {
      expect((e as TraceOnError).code).toBe('EMBEDDED_CHECKSUM_MISSING');
    }
  });
});

describe('ensureCollectorBinary', () => {
  let binDir: string;
  let srcDir: string;
  let tarball: Buffer;
  const target = { platform: 'linux', arch: 'amd64' } as const;
  const asset = assetName(target);

  function fetchMock(opts: { checksum?: string; tarStatus?: number } = {}): typeof fetch {
    return (async (url: string | URL) => {
      const u = String(url);
      if (u === checksumsUrl()) {
        const line = `${opts.checksum ?? sha256(tarball)}  ${asset}`;
        return new Response(line, { status: 200 });
      }
      if (u === downloadUrl(target)) {
        if (opts.tarStatus && opts.tarStatus !== 200) {
          return new Response('nope', { status: opts.tarStatus });
        }
        return new Response(new Uint8Array(tarball), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  }

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'traceon-bin-'));
    srcDir = mkdtempSync(join(tmpdir(), 'traceon-src-'));
    // A real (tiny) gzipped tarball containing a fake `otelcol-contrib`.
    writeFileSync(join(srcDir, 'otelcol-contrib'), '#!/bin/sh\necho fake-collector\n');
    execFileSync('tar', ['-czf', join(srcDir, asset), '-C', srcDir, 'otelcol-contrib']);
    tarball = readFileSync(join(srcDir, asset));
  });

  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('downloads, verifies, extracts, and returns the binary path', async () => {
    const path = await ensureCollectorBinary({ binDir, target, fetchImpl: fetchMock() });
    expect(path).toBe(collectorBinaryPath(binDir));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('fake-collector');
  });

  it('is idempotent — skips download when the binary already exists', async () => {
    await ensureCollectorBinary({ binDir, target, fetchImpl: fetchMock() });
    let fetched = 0;
    const countingFetch = (async (url: string | URL) => {
      fetched++;
      return fetchMock()(String(url));
    }) as typeof fetch;
    const path = await ensureCollectorBinary({ binDir, target, fetchImpl: countingFetch });
    expect(fetched).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it('hard-fails on checksum mismatch and leaves no binary behind', async () => {
    const bad = fetchMock({ checksum: 'f'.repeat(64) });
    await expect(ensureCollectorBinary({ binDir, target, fetchImpl: bad })).rejects.toMatchObject({
      code: 'EMBEDDED_CHECKSUM_MISMATCH',
    });
    expect(existsSync(collectorBinaryPath(binDir))).toBe(false);
  });

  it('fails with EMBEDDED_DOWNLOAD_FAILED on HTTP errors', async () => {
    const bad = fetchMock({ tarStatus: 500 });
    await expect(ensureCollectorBinary({ binDir, target, fetchImpl: bad })).rejects.toMatchObject({
      code: 'EMBEDDED_DOWNLOAD_FAILED',
    });
  });

  it('reports progress through onProgress', async () => {
    const messages: string[] = [];
    await ensureCollectorBinary({
      binDir,
      target,
      fetchImpl: fetchMock(),
      onProgress: (m) => messages.push(m),
    });
    expect(messages.some((m) => m.includes('Downloading'))).toBe(true);
    expect(messages.some((m) => m.includes(OTELCOL_VERSION))).toBe(true);
  });
});
