export const byPace = (a, b) => (a.pace ?? 1) - (b.pace ?? 1) || (a.used_percent ?? 100) - (b.used_percent ?? 100);

const cursorOwn = /^(?:default|auto|composer|grok)(?:[-.]|$)/iu;
export const rankCandidates = (tiers, mapped, accounts) => tiers.map((tier, index) => tier.map(({ instance, model }) => {
  const { pools, driver } = mapped.find(({ id }) => id === instance) ?? { pools: [] };
  const billed = driver === 'cursor' && pools.length ? [cursorOwn.test(model) ? 'cursor_models' : 'other_models'] : pools;
  const pool = billed.length === 1 ? billed[0] : null;
  const reading = pool ? accounts[pool].reading : null;
  return { tier: index, instance, model, pool, state: pool ? accounts[pool].state : 'unknown',
    pace: reading?.pace ?? null, used_percent: reading?.used_percent ?? null };
}));

const inState = (tier, state) => tier.filter((candidate) => candidate.state === state);
const byPaceThenTier = (a, b) => (a.pace ?? 1) - (b.pace ?? 1) || a.tier - b.tier || byPace(a, b);
export const chooseCandidate = (ranked) => {
  const preferred = ranked.map((tier) => inState(tier, 'available')).find((tier) => tier.length);
  if (preferred) return preferred.sort(byPace)[0];
  return ranked.flatMap((tier) => inState(tier, 'protected')).sort(byPaceThenTier)[0] ?? null;
};
