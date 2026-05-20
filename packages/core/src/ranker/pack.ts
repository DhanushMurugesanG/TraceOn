import type { EvidenceRef } from '../types.js';
import { estimateTokens } from './tokens.js';

export function greedyPack(
  items: EvidenceRef[],
  remainingBudget: number,
): { packed: EvidenceRef[]; used: number } {
  const packed: EvidenceRef[] = [];
  let used = 0;
  for (const item of items) {
    const cost = estimateTokens(item);
    if (used + cost > remainingBudget) break;
    packed.push(item);
    used += cost;
  }
  return { packed, used };
}
