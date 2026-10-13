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

export const chooseCandidate = (ranked) => {
  const byState = (a, b) => (a.state === 'available' ? 0 : 1) - (b.state === 'available' ? 0 : 1) || byPace(a, b);
  const best = ranked.map((tier) => tier.filter(({ state }) => state === 'available' || state === 'protected')
    .sort(byState)[0]);
  const first = best.findIndex(Boolean);
  const yields = (protectedPick, next) => protectedPick.state === 'protected' && next != null
    && (next.state === 'available' || (next.pace != null && protectedPick.pace != null && next.pace < protectedPick.pace));
  return first < 0 ? null : yields(best[first], best[first + 1]) ? best[first + 1] : best[first];
};
