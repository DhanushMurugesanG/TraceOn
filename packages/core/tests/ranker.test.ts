import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { rank } from '../src/ranker.js';

const fixturesDir = join(import.meta.dirname, 'fixtures');

describe('ranker', () => {
  for (const file of readdirSync(fixturesDir)) {
    if (!file.endsWith('.json')) continue;
    const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf-8'));

    it(fixture.name, () => {
      const result = rank(fixture.input);

      if (fixture.expected.tier1_count !== undefined) {
        expect(result.tier1.length).toBe(fixture.expected.tier1_count);
      }
      if (fixture.expected.tier1_includes) {
        for (const required of fixture.expected.tier1_includes) {
          const matched = result.tier1.some((t) => t.summary.includes(required));
          expect(matched, `Tier 1 should include: ${required}`).toBe(true);
        }
      }
      if (fixture.expected.budget_under) {
        expect(result.budget_used).toBeLessThan(fixture.expected.budget_under);
      }
    });
  }
});
