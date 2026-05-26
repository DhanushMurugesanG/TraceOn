/**
 * Tests for the skill-staleness check shipped in v0.0.9.
 *
 * The check warns when the project's .claude/skills/traceon-verify/SKILL.md
 * is from an older traceon-cli install than the currently-running MCP server.
 * Common case: user upgrades the npm package but doesn't re-run `traceon init`
 * in their project, so the agent reads pre-upgrade instructions and the new
 * features (extra_env, .traceon/auth.json, timeout context) are invisible.
 *
 * Design constraint: the check must never false-positive (no warning when
 * we can't tell), and must never throw (best-effort, IO failures swallowed).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readSkillVersion,
  projectSkillPath,
  checkSkillVersion,
  formatStaleSkillWarning,
} from '../src/skill-version.js';

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'traceon-skill-version-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

function writeSkill(dir: string, content: string): string {
  const path = join(dir, '.claude', 'skills', 'traceon-verify', 'SKILL.md');
  mkdirSync(join(dir, '.claude', 'skills', 'traceon-verify'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('readSkillVersion', () => {
  it('parses `version: X.Y.Z` from a well-formed frontmatter block', () => {
    const root = mkTmp();
    const path = writeSkill(root, `---
name: traceon-verify
version: 0.0.9
description: blah
---

# Body
`);
    expect(readSkillVersion(path)).toBe('0.0.9');
  });

  it('returns null when the file does not exist', () => {
    expect(readSkillVersion('/this/path/does/not/exist/SKILL.md')).toBeNull();
  });

  it('returns null when there is no `version:` line in the frontmatter', () => {
    const root = mkTmp();
    const path = writeSkill(root, `---
name: traceon-verify
description: blah
---

# Body
`);
    expect(readSkillVersion(path)).toBeNull();
  });

  it('returns null for a file with no frontmatter at all', () => {
    const root = mkTmp();
    const path = writeSkill(root, '# Just a markdown body\n\nversion: 0.0.9\n');
    expect(readSkillVersion(path)).toBeNull();
  });

  it('ignores `version:` mentions in the body — only frontmatter counts', () => {
    const root = mkTmp();
    const path = writeSkill(root, `---
name: traceon-verify
description: blah
---

This text says version: 99.99.99 but that's not the real version.
`);
    expect(readSkillVersion(path)).toBeNull();
  });

  it('handles trailing whitespace on the version line', () => {
    const root = mkTmp();
    const path = writeSkill(root, `---
name: traceon-verify
version: 1.2.3
description: blah
---
`);
    expect(readSkillVersion(path)).toBe('1.2.3');
  });
});

describe('projectSkillPath', () => {
  it('returns <projectRoot>/.claude/skills/traceon-verify/SKILL.md', () => {
    expect(projectSkillPath('/abs/proj')).toBe(
      '/abs/proj/.claude/skills/traceon-verify/SKILL.md',
    );
  });
});

describe('checkSkillVersion', () => {
  it('returns ok:true + missing_project when the project has no skill file', () => {
    const root = mkTmp(); // no .claude/ at all
    const result = checkSkillVersion(root);
    // Bundled may or may not be findable depending on test runner cwd; the
    // important assertion is that an absent project skill never warns.
    expect(result.ok).toBe(true);
    expect(result.reason === 'missing_project' || result.reason === 'missing_bundled').toBe(true);
    expect(result.project).toBeNull();
  });

  // The remaining checkSkillVersion cases need a controllable bundled
  // location — covered via the formatStaleSkillWarning unit tests below,
  // which take a pre-built SkillVersionCheck so we don't have to mock the
  // bundled-skill discovery path.
});

describe('formatStaleSkillWarning', () => {
  it('returns null when ok:true (no warning needed)', () => {
    expect(formatStaleSkillWarning({
      ok: true, bundled: '0.0.9', project: '0.0.9', reason: 'match',
    })).toBeNull();
    expect(formatStaleSkillWarning({
      ok: true, bundled: '0.0.9', project: null, reason: 'missing_project',
    })).toBeNull();
    expect(formatStaleSkillWarning({
      ok: true, bundled: null, project: '0.0.7', reason: 'missing_bundled',
    })).toBeNull();
  });

  it('formats a clear actionable warning when the skill is stale', () => {
    const warn = formatStaleSkillWarning({
      ok: false,
      bundled: '0.0.9',
      project: '0.0.7',
      reason: 'stale',
    });
    expect(warn).not.toBeNull();
    expect(warn!).toMatch(/\[traceon\] Skill version mismatch/);
    expect(warn!).toMatch(/v0\.0\.7/);  // project version
    expect(warn!).toMatch(/v0\.0\.9/);  // bundled version
    expect(warn!).toMatch(/traceon init/);  // remediation
  });

  it('produces a single-line warning (no embedded newlines)', () => {
    const warn = formatStaleSkillWarning({
      ok: false, bundled: '0.0.9', project: '0.0.7', reason: 'stale',
    });
    expect(warn).not.toBeNull();
    expect(warn!.includes('\n')).toBe(false);
  });
});
