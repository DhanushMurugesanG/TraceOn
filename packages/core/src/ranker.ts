import type { RawEvidence, RankedPacket, RankerConfig } from './types.js';
import { collectTier1 } from './ranker/tier1.js';
import { collectTier2, sortTier2 } from './ranker/tier2.js';
import { summarizeTier3 } from './ranker/tier3.js';
import { greedyPack } from './ranker/pack.js';
import { estimateTokens } from './ranker/tokens.js';

export const DEFAULT_RANKER_CONFIG: RankerConfig = {
  budget_total: 50_000,
  tier3_summary_cap: 500,
  slow_span_percentile: 95,
};

export class RankerTier1OverflowError extends Error {
  constructor(public tier1Tokens: number, public budget: number) {
    super(`Tier 1 evidence (${tier1Tokens} tokens) exceeds budget (${budget})`);
    this.name = 'RankerTier1OverflowError';
  }
}

export function rank(
  evidence: RawEvidence,
  config: RankerConfig = DEFAULT_RANKER_CONFIG,
): RankedPacket {
  // Tier 1
  const tier1 = collectTier1(evidence);
  const tier1Tokens = tier1.reduce((acc, r) => acc + estimateTokens(r), 0);
  if (tier1Tokens > config.budget_total - config.budget_total * 0.2) {
    throw new RankerTier1OverflowError(tier1Tokens, config.budget_total);
  }

  // Tier 2 candidates and sort
  const tier1Ids = new Set(tier1.map((t) => t.id));
  const candidates = collectTier2(evidence, tier1Ids);
  const sorted = sortTier2(candidates);

  // Greedy-pack tier 2 into remaining budget
  const remaining = config.budget_total - tier1Tokens;
  const { packed: tier2, used: tier2Tokens } = greedyPack(
    sorted.map((c) => c.ref),
    remaining,
  );

  // Tier 3 summary over everything excluded from tier 1 + tier 2
  const excluded = new Set<string>(tier1Ids);
  for (const r of tier2) excluded.add(r.id);
  const tier3_summary = summarizeTier3(evidence, excluded, config.tier3_summary_cap);

  const omittedCount = sorted.length - tier2.length;
  const omitted_summary =
    omittedCount > 0 ? `${omittedCount} candidate(s) omitted due to budget` : undefined;

  return {
    tier1,
    tier2,
    tier3_summary,
    budget_used: tier1Tokens + tier2Tokens,
    budget_total: config.budget_total,
    omitted_summary,
  };
}
