import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRole, resolveRole } from './role-target.mjs';

const provider = (instance, driver, model, key, values = ['low', 'medium', 'high', 'xhigh']) => ({
  providerInstanceId: instance, driverKind: driver, canRunChildTask: true,
  models: [{ id: model, options: [{ id: key, label: 'Reasoning', options: values.map((id) => ({ id })) }] }],
});
const catalog = { providers: [
  provider('codex', 'codex', 'sol', 'reasoningEffort'),
  provider('codex_second', 'codex', 'sol', 'reasoningEffort'),
  provider('claude', 'claudeAgent', 'opus', 'effort'),
  provider('grok', 'grok', 'fast', 'reasoningEffort', ['high', 'low', 'medium']),
  provider('cursor', 'cursor', 'composer', 'reasoning_effort'),
] };
const mapped = [
  { id: 'codex', driver: 'codex', pools: ['codex:default'] },
  { id: 'codex_second', driver: 'codex', pools: ['codex:second'] },
  { id: 'claude', driver: 'claudeAgent', pools: ['claude:games'] },
  { id: 'grok', driver: 'grok', pools: ['grok'] },
  { id: 'cursor', driver: 'cursor', pools: ['cursor_models', 'other_models'] },
];
const pool = (state, pace) => ({ state, reading: { pace, used_percent: 40 } });
const accounts = {
  'codex:default': pool('protected', 1.3), 'codex:second': pool('available', 0.6),
  'claude:games': pool('available', 0.4), grok: pool('available', 0.3),
  cursor_models: pool('available', 0.2), other_models: pool('unavailable', 2),
};
const resolve = (text, role, providers = catalog.providers, readings = accounts, mappings = mapped) =>
  resolveRole(parseRole(text, role), { providers }, mappings, readings);

test('a single seat expands all serving instances and resolves an alias budget', () => {
  const [seat] = resolve('# effort high: feature, refactoring\nfeature, refactoring: capacity[sol > opus]', 'refactoring');
  assert.deepEqual(seat.target, {
    providerInstanceId: 'codex_second', model: 'sol', options: [{ id: 'reasoningEffort', value: 'high' }],
  });
  assert.deepEqual(seat.candidates.map(({ instance, tier }) => [instance, tier]),
    [['codex', 0], ['codex_second', 0], ['claude', 1]]);
});

test('panel entries each produce a target using the catalog option key', () => {
  const seats = resolve('reviewers: capacity[sol], capacity[opus], capacity[fast], capacity[composer]', 'reviewers');
  assert.deepEqual(seats.map(({ target }) => target), [
    { providerInstanceId: 'codex_second', model: 'sol', options: [{ id: 'reasoningEffort', value: 'xhigh' }] },
    { providerInstanceId: 'claude', model: 'opus', options: [{ id: 'effort', value: 'xhigh' }] },
    { providerInstanceId: 'grok', model: 'fast', options: [{ id: 'reasoningEffort', value: 'high' }] },
    { providerInstanceId: 'cursor', model: 'composer', options: [{ id: 'reasoning_effort', value: 'xhigh' }] },
  ]);
});

test('equal models compete by capacity within their tier', () => {
  const [seat] = resolve('# effort medium: how explorer\nhow explorer: capacity[sol | opus > fast]', 'how explorer');
  assert.deepEqual(seat.target, {
    providerInstanceId: 'claude', model: 'opus', options: [{ id: 'effort', value: 'medium' }],
  });
  assert.equal(seat.choice.tier, 0);
});

test('work falls through every protected or spent tier to the first available one', () => {
  const readings = { ...accounts, 'codex:second': pool('unavailable', 2), 'claude:games': pool('protected', 1.5) };
  const [seat] = resolve('fix: capacity[sol > opus > fast]', 'fix', catalog.providers, readings);
  assert.deepEqual([seat.choice.instance, seat.choice.tier], ['grok', 2]);
});

test('an available earlier tier wins over a later tier with a lower pace', () => {
  assert.equal(resolve('fix: capacity[sol > fast]', 'fix')[0].target.providerInstanceId, 'codex_second');
});

test('with no available tier the protected pool with the lowest pace takes work', () => {
  const readings = { ...accounts, 'codex:second': pool('unavailable', 2), grok: pool('protected', 1.6),
    'claude:games': pool('protected', 1.2) };
  const [seat] = resolve('fix: capacity[fast > sol > opus]', 'fix', catalog.providers, readings);
  assert.deepEqual([seat.choice.instance, seat.choice.tier], ['claude', 2]);
  readings['claude:games'] = { state: 'protected', reading: { pace: 1.3, used_percent: 10 } };
  assert.equal(resolve('fix: capacity[sol > opus]', 'fix', catalog.providers, readings)[0].choice.instance, 'codex');
});

test('effort discovery follows a renamed catalog key and skips unrelated option values', () => {
  const renamed = provider('new', 'future', 'sol', 'budget', ['low', 'medium', 'high', 'max']);
  renamed.models[0].options.unshift({ id: 'serviceTier', options: [{ id: 'high' }, { id: 'low' }] });
  const [seat] = resolve('fix: capacity[sol]', 'fix', [renamed], { future: pool('available', 0.5) },
    [{ id: 'new', driver: 'future', pools: ['future'] }]);
  assert.deepEqual(seat.target, { providerInstanceId: 'new', model: 'sol', options: [{ id: 'budget', value: 'high' }] });
});

test('unknown roles return a null choice with a reason', () => {
  const [seat] = resolve('fix: capacity[sol]', 'missing');
  assert.equal(seat.choice, null);
  assert.equal(seat.target, null);
  assert.equal(seat.reason, 'unknown role missing');
});

test('a missing catalog model is reported and later tiers can still take work', () => {
  const [missing] = resolve('fix: capacity[absent]', 'fix');
  assert.equal(missing.choice, null);
  assert.equal(missing.target, null);
  assert.deepEqual(missing.rejected, [{ model: 'absent', reason: 'model missing from catalog' }]);
  assert.equal(resolve('fix: capacity[absent > sol]', 'fix')[0].target.model, 'sol');
});

test('unavailable and unknown capacity never produce a target', () => {
  const [seat] = resolve('fix: capacity[sol > opus]', 'fix', catalog.providers,
    { ...accounts, 'codex:default': pool('unknown', null), 'codex:second': pool('unavailable', 2),
      'claude:games': pool('unknown', null) });
  assert.equal(seat.choice, null);
  assert.equal(seat.target, null);
  assert.match(seat.reason, /known available or protected capacity/u);
  const [fallback] = resolve('fix: capacity[sol > opus]', 'fix', catalog.providers,
    { ...accounts, 'codex:second': pool('unknown', null), 'claude:games': pool('unavailable', 2) });
  assert.equal(fallback.choice.instance, 'codex');
});

test('disabled providers and models without a supported budget are rejected', () => {
  const disabled = { ...catalog.providers[0], canRunChildTask: false };
  const tooHigh = provider('claude', 'claudeAgent', 'opus', 'effort', ['max']);
  const [seat] = resolve('fix: capacity[sol | opus]', 'fix', [disabled, tooHigh]);
  assert.equal(seat.target, null);
  assert.deepEqual(seat.rejected.map(({ reason }) => reason),
    ['provider cannot run child tasks', 'no unambiguous reasoning option at or below xhigh']);
});

test('missing or ambiguous reasoning controls never leave effort unset', () => {
  for (const options of [[], [
    { id: 'effort', options: [{ id: 'high' }] },
    { id: 'reasoning', options: [{ id: 'high' }] },
  ]]) {
    const custom = { ...catalog.providers[0], models: [{ id: 'sol', options }] };
    const [seat] = resolve('fix: capacity[sol]', 'fix', [custom]);
    assert.equal(seat.choice, null);
    assert.equal(seat.target, null);
    assert.equal(seat.rejected[0].reason, 'no unambiguous reasoning option at or below xhigh');
  }
});

test('malformed role pools and effort declarations fail instead of guessing', () => {
  for (const text of ['fix: capacity[sol > ]', 'fix: sol', '# effort huge: fix\nfix: capacity[sol]']) {
    assert.throws(() => resolve(text, 'fix'));
  }
});
