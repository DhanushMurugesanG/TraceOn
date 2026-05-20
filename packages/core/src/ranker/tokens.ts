export function estimateTokens(item: unknown): number {
  return Math.ceil(JSON.stringify(item).length / 4);
}
