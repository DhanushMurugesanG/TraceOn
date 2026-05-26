import type { CheckFn } from '../types.js';
import { checkSkillVersion } from '../../skill-version.js';

/**
 * Check 8 — Project's .claude/skills/traceon-verify/SKILL.md matches the
 * version bundled with this traceon-cli. Delegates entirely to the
 * skill-version module shipped in v0.0.9.
 */
export const skillUpToDate: CheckFn = async (ctx) => {
  const result = checkSkillVersion(ctx.projectRoot);

  if (result.reason === 'match') {
    return {
      name: `Skill is up to date (v${result.bundled})`,
      status: 'pass',
      message: 'Bundled skill matches project copy',
    };
  }

  if (result.reason === 'missing_project') {
    return {
      name: 'Skill is up to date',
      status: 'skip',
      message: '.claude/skills/traceon-verify/SKILL.md does not exist yet',
      detail: 'This is normal before the first `traceon init` in a project.',
      fix: 'Run `traceon init` to install the skill.',
    };
  }

  if (result.reason === 'missing_bundled') {
    return {
      name: 'Skill is up to date',
      status: 'warn',
      message: 'Could not locate the bundled SKILL.md inside the installed traceon-cli package',
      detail: 'Unusual install layout. The check can\'t determine staleness.',
    };
  }

  // reason === 'stale'
  return {
    name: 'Skill is up to date',
    status: 'fail',
    message: `Project skill is v${result.project}, bundled is v${result.bundled}`,
    detail: 'The agent in this project is following older instructions and may miss recent features (extra_env, .traceon/auth.json, timeout context).',
    fix: 'Run `traceon init` in this project to refresh the skill.',
  };
};
