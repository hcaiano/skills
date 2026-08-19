#!/usr/bin/env node
// Dismantles a merged work unit in the order that actually works, kept in
// code because the gotchas keep getting shaved out of prose: worktree first
// (`gh pr merge --delete-branch` fails while it exists), then the branch on
// both sides (`-D`, since `-d` refuses under squash/rebase merge styles;
// `git push origin --delete`), then registered auxiliary tabs/panes, then
// the unit tab. A worktree remove that drags (large node_modules) falls
// back to `trash` + `git worktree prune`.
//
//   node dismantle-unit.mjs --worktree <path> --branch <name> --tab <tab_id>
//                           [--teardown "<command>"] [--aux <id,id,...>]
//
// Exit 0: JSON report of every step. Exit 1: JSON with the failed step and
// what was already done — the caller reports that checkpoint verbatim.
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

const WORKTREE_REMOVE_TIMEOUT_MS = 120000;

const emit = (obj, code) => {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(code);
};

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) {
    emit({ dismantled: false, error: 'usage: dismantle-unit.mjs --worktree <path> --branch <name> --tab <tab_id> [--teardown "<command>"] [--aux <id,...>]' }, 2);
  }
  options[argv[i].slice(2)] = argv[i + 1];
}
for (const key of ['worktree', 'branch', 'tab']) {
  if (!options[key]) emit({ dismantled: false, error: `--${key} is required` }, 2);
}

const steps = [];
const fail = (step, detail) =>
  emit({ dismantled: false, failed_step: step, error: detail.trim(), done: steps }, 1);

// Resolve the main repo before the worktree disappears.
const common = run('git', ['-C', options.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
if (common.status !== 0) fail('resolve-repo', common.stderr || 'not a git worktree');
const repo = dirname(common.stdout.trim());

// 1. Worktree.
if (options.teardown) {
  const t = run('sh', ['-c', options.teardown], { cwd: repo });
  if (t.status !== 0) fail('teardown', t.stderr || t.stdout || `teardown exited ${t.status}`);
  steps.push({ step: 'worktree', via: 'teardown' });
} else {
  const w = run('git', ['-C', repo, 'worktree', 'remove', options.worktree], { timeout: WORKTREE_REMOVE_TIMEOUT_MS });
  if (w.status === 0) {
    steps.push({ step: 'worktree', via: 'git worktree remove' });
  } else {
    const trashed = run('trash', [options.worktree]);
    if (trashed.status !== 0) fail('worktree', `git worktree remove failed (${(w.stderr || 'timeout').trim()}) and trash fallback failed: ${(trashed.stderr || '').trim()}`);
    const pruned = run('git', ['-C', repo, 'worktree', 'prune']);
    if (pruned.status !== 0) fail('worktree-prune', pruned.stderr || 'prune failed');
    steps.push({ step: 'worktree', via: 'trash + prune', note: (w.stderr || 'remove timed out').trim() });
  }
}

// 2. Branch, both sides. Already-gone is fine — the goal is absence.
const local = run('git', ['-C', repo, 'branch', '-D', options.branch]);
steps.push({ step: 'local-branch', ok: local.status === 0, note: local.status === 0 ? undefined : (local.stderr || '').trim() });
if (local.status !== 0 && !/not found/i.test(local.stderr || '')) {
  fail('local-branch', local.stderr || 'branch -D failed');
}
const remote = run('git', ['-C', repo, 'push', 'origin', '--delete', options.branch]);
steps.push({ step: 'remote-branch', ok: remote.status === 0, note: remote.status === 0 ? undefined : (remote.stderr || '').trim() });
if (remote.status !== 0 && !/remote ref does not exist|couldn't find remote ref/i.test(remote.stderr || '')) {
  fail('remote-branch', remote.stderr || 'remote delete failed');
}

// 3. Auxiliary tabs/panes registered to the unit, then the unit tab.
const closeHerdr = (kind, id) => {
  const r = run('herdr', [kind, 'close', id]);
  return r.status === 0 ? null : (r.stderr || r.stdout || `${kind} close exited ${r.status}`).trim();
};
for (const aux of (options.aux ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const tabError = closeHerdr('tab', aux);
  if (tabError === null) {
    steps.push({ step: 'aux', id: aux, via: 'tab close' });
    continue;
  }
  const paneError = closeHerdr('pane', aux);
  if (paneError !== null) fail('aux', `could not close ${aux}: ${tabError} / ${paneError}`);
  steps.push({ step: 'aux', id: aux, via: 'pane close' });
}
const tabError = closeHerdr('tab', options.tab);
if (tabError !== null) fail('tab', tabError);
steps.push({ step: 'tab', id: options.tab });

emit({ dismantled: true, repo, done: steps }, 0);
