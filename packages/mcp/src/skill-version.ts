import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Reads `version: X.Y.Z` from a SKILL.md YAML frontmatter block.
 * Returns null if the file doesn't exist or has no `version:` line.
 *
 * Tolerant by design: any IO or parse error returns null so a malformed
 * skill file never blocks the verify call.
 */
export function readSkillVersion(skillPath: string): string | null {
  if (!existsSync(skillPath)) return null;
  try {
    const content = readFileSync(skillPath, 'utf-8');
    // Match `version: X.Y.Z` inside the frontmatter block (between --- markers).
    // The /m flag makes ^ match the start of each line.
    const match = content.match(/^---\s*\n[\s\S]*?^version:\s*([^\s\n]+)/m);
    return match ? match[1]!.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Locates the bundled SKILL.md inside the installed traceon-cli package.
 * The MCP server runs from `dist/`; we walk up looking for `skills/`.
 *
 * Returns null if not found (weird install, edited bundle, etc.) — callers
 * should treat that as "skip the check" rather than as a warning.
 */
export function findBundledSkillPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'skills', 'traceon-verify', 'SKILL.md');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Returns the path where the project copy of SKILL.md should live.
 * (May or may not exist on disk; caller handles absence.)
 */
export function projectSkillPath(projectRoot: string): string {
  return join(projectRoot, '.claude', 'skills', 'traceon-verify', 'SKILL.md');
}

export interface SkillVersionCheck {
  /** True when no action is needed: match, or one side legitimately absent. */
  ok: boolean;
  /** Version string read from the bundled SKILL.md, or null if not found. */
  bundled: string | null;
  /** Version string read from the project's SKILL.md, or null if not found. */
  project: string | null;
  /**
   * - 'match'           — both versions present and equal
   * - 'stale'           — both present and different (the warn case)
   * - 'missing_project' — project hasn't run `traceon init` yet
   * - 'missing_bundled' — couldn't locate the bundled skill (unusual install)
   */
  reason: 'match' | 'stale' | 'missing_project' | 'missing_bundled';
}

/**
 * Compares the bundled SKILL.md version against the project's copy.
 *
 * We only consider the project's skill stale (`ok: false`) when BOTH versions
 * are present AND they differ. Missing-on-either-side returns ok:true with a
 * specific reason — false positives erode trust in the warning.
 */
export function checkSkillVersion(projectRoot: string): SkillVersionCheck {
  const bundledPath = findBundledSkillPath();
  const bundled = bundledPath ? readSkillVersion(bundledPath) : null;
  const project = readSkillVersion(projectSkillPath(projectRoot));

  if (!bundled) return { ok: true, bundled, project, reason: 'missing_bundled' };
  if (!project) return { ok: true, bundled, project, reason: 'missing_project' };
  if (bundled === project) return { ok: true, bundled, project, reason: 'match' };
  return { ok: false, bundled, project, reason: 'stale' };
}

/**
 * Format the user-facing warning message for a stale skill. Single line,
 * actionable. Returns null when the check is ok (caller can skip logging).
 */
export function formatStaleSkillWarning(check: SkillVersionCheck): string | null {
  if (check.ok || check.reason !== 'stale') return null;
  return (
    `[traceon] Skill version mismatch — your project's .claude/skills/traceon-verify/SKILL.md ` +
    `is v${check.project} but the CLI bundles v${check.bundled}. ` +
    `Re-run \`traceon init\` in this project to refresh the agent's instructions.`
  );
}
