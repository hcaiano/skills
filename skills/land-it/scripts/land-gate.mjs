#!/usr/bin/env node
// Decides whether one GitHub PR may be merged without the user, and with
// --merge acts on that decision. Prints one JSON object:
//   pr       the PR URL
//   head     the head SHA the decision describes
//   action   merge | update-branch | wait | hold | done
//   reasons  why the action is not merge; empty when it is
//   acted    with --merge: merged, queued, branch-updated, or null
//
// A PR is landable when every rule in decide() passes:
//   - the user's own same-repository PR into the default branch, not draft,
//     with no hold label;
//   - its `**Merge danger.**` line says `Door: two-way` and no `Door: one-way`
//     appears anywhere in the body;
//   - its last `**Review.**` line is review-it's receipt
//     `<grade> by <models>; <n> fixed, <n> rejected, <n> open; reviewed <sha> on <base>`
//     graded standard (or the older single) with no rejected and no open
//     findings: every reviewer agreed;
//   - the review saw this base, and the reviewed commit still describes the
//     change: the head is that commit, or merging the reviewed commit with the
//     base the head now contains gives exactly the head's tree;
//   - at least one check succeeded and none failed, every review thread is
//     resolved, nothing requests changes, and GitHub reports no conflict or
//     protection block.
// Pending checks or unknown mergeability give wait; a branch behind its base
// gives update-branch; any other failed rule gives hold.
//
// --merge uses the first merge method the repository allows (squash, merge,
// rebase) with --match-head-commit, so a push after the decision fails the
// merge instead of landing unreviewed code. It never uses --admin. Git runs
// in the current directory, a checkout of the PR's repository.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const receiptPattern = /^\*\*Review\.\*\*\s*(skip|single|standard|panel|high)\b[^;\n]*;\s*(\d+)\s+fixed,\s*(\d+)\s+rejected,\s*(\d+)\s+open;\s*reviewed\s+`?([0-9a-f]{7,40})`?\s+on\s+`?([^\s`;,]+?)`?\.?(?=\s|$)/i;

// The last `**Review.**` line is the receipt; a last line in any other shape
// is no receipt, so an older approval above it never counts.
export const parseReceipt = (body) => {
  const line = (body ?? '').split('\n').filter((candidate) => candidate.trimStart().startsWith('**Review.**')).at(-1);
  const match = receiptPattern.exec(line?.trimStart() ?? '');
  if (!match) return null;
  const [, grade, fixed, rejected, open, sha, base] = match;
  return { grade: grade.toLowerCase(), fixed: Number(fixed), rejected: Number(rejected), open: Number(open), sha: sha.toLowerCase(), base };
};

export const parseDoor = (body) => {
  const text = body ?? '';
  if (/Door:\s*one-way/i.test(text)) return 'one-way';
  const line = text.split('\n').find((candidate) => candidate.trimStart().startsWith('**Merge danger.**'));
  return /Door:\s*two-way/i.test(line ?? '') ? 'two-way' : null;
};

const checkState = (check) => {
  if (check.__typename === 'StatusContext') {
    if (check.state === 'SUCCESS') return 'pass';
    return check.state === 'PENDING' || check.state === 'EXPECTED' ? 'pending' : 'fail';
  }
  if (check.status !== 'COMPLETED') return 'pending';
  return ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion) ? 'pass' : 'fail';
};

// facts: { pr, viewer, defaultBranch, unresolvedThreads, receipt, door,
//          reviewed: { matches, reason } | null }
export const decide = (facts) => {
  const { pr } = facts;
  if (pr.state !== 'OPEN') return { action: 'done', reasons: [pr.state === 'MERGED' ? 'PR is merged' : 'PR was closed without merging'] };
  const holds = [];
  const waits = [];
  if (pr.isCrossRepository) holds.push('PR comes from a fork');
  if (pr.author?.login !== facts.viewer) holds.push(`PR author ${pr.author?.login} is not ${facts.viewer}`);
  if (pr.baseRefName !== facts.defaultBranch) holds.push(`base ${pr.baseRefName} is not the default branch ${facts.defaultBranch}`);
  if (pr.isDraft) holds.push('draft');
  const holdLabels = (pr.labels ?? []).map((label) => label.name).filter((label) => /\b(hold|do[- ]not[- ]merge|wip)\b/i.test(label));
  if (holdLabels.length) holds.push(`hold label: ${holdLabels.join(', ')}`);
  if (facts.door !== 'two-way') holds.push(facts.door === 'one-way' ? 'Door: one-way' : 'no `Door: two-way` on the Merge danger line');
  const { receipt } = facts;
  if (!receipt) holds.push('no review-it receipt in the PR body');
  else {
    if (receipt.grade === 'panel' || receipt.grade === 'high') holds.push(`review-it graded ${receipt.grade}`);
    if (receipt.grade === 'skip') holds.push('graded skip: no reviewer saw the change');
    if (receipt.rejected > 0) holds.push(`${receipt.rejected} rejected review finding(s): reviewers did not all agree`);
    if (receipt.open > 0) holds.push(`${receipt.open} review finding(s) or blocker(s) left open`);
    if (receipt.base !== pr.baseRefName) holds.push(`reviewed on ${receipt.base}, but the base is now ${pr.baseRefName}`);
    if (facts.reviewed && !facts.reviewed.matches) holds.push(facts.reviewed.reason);
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') holds.push('changes requested');
  if (pr.mergeable === 'CONFLICTING') holds.push('conflicts with the base');
  if (facts.unresolvedThreads) holds.push(`${facts.unresolvedThreads} unresolved review thread(s)`);
  const checks = pr.statusCheckRollup ?? [];
  if (checks.length === 0) holds.push('no checks reported');
  const states = checks.map((check) => [check.name ?? check.context, checkState(check)]);
  const failing = states.filter(([, state]) => state === 'fail').map(([name]) => name);
  if (failing.length) holds.push(`failing checks: ${failing.join(', ')}`);
  const pending = states.filter(([, state]) => state === 'pending').map(([name]) => name);
  if (pending.length) waits.push(`pending checks: ${pending.join(', ')}`);
  else if (checks.length && !failing.length && !checks.some((check) => check.conclusion === 'SUCCESS' || check.state === 'SUCCESS')) holds.push('no check succeeded');
  if (pr.mergeable === 'UNKNOWN') waits.push('GitHub is still computing mergeability');
  if (holds.length) return { action: 'hold', reasons: [...holds, ...waits] };
  if (waits.length) return { action: 'wait', reasons: waits };
  if (pr.mergeStateStatus === 'BEHIND') return { action: 'update-branch', reasons: ['branch is behind its base'] };
  if (pr.mergeStateStatus === 'BLOCKED') return { action: 'hold', reasons: ['branch protection blocks the merge'] };
  return { action: 'merge', reasons: [] };
};

const run = (cmd, argv) => execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
const gh = (...argv) => run('gh', argv);
const git = (...argv) => run('git', argv).trim();
const firstLine = (error) => String(error.stderr || error.message).trim().split('\n')[0];
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The reviewed commit still describes the PR when merging it with the base
// the head now contains reproduces the head's tree exactly.
const compareTrees = (pr, receiptSha, slug) => {
  if (pr.headRefOid.toLowerCase().startsWith(receiptSha)) return { matches: true };
  try {
    const remotes = git('remote', '-v').split('\n').map((line) => line.split(/\s+/));
    const remote = remotes.find(([, url]) => new RegExp(`[:/]${slug}(\\.git)?$`, 'i').test(url ?? ''))?.[0] ?? 'origin';
    git('fetch', '-q', remote, `+refs/heads/${pr.baseRefName}:refs/land-it/base`, `+refs/pull/${pr.number}/head:refs/land-it/head`);
    const reviewed = git('rev-parse', '--verify', `${receiptSha}^{commit}`);
    const base = git('merge-base', 'refs/land-it/base', pr.headRefOid);
    let expected;
    try {
      expected = git('merge-tree', '--write-tree', reviewed, base).split('\n')[0];
    } catch {
      return { matches: false, reason: `the reviewed ${receiptSha} conflicts with the base the head contains` };
    }
    const actual = git('rev-parse', `${pr.headRefOid}^{tree}`);
    return expected === actual ? { matches: true } : { matches: false, reason: `HEAD changed since the review of ${receiptSha}` };
  } catch (error) {
    return { matches: false, reason: `could not compare the reviewed and current code: ${firstLine(error)}` };
  }
};

const fields = 'number,url,state,isDraft,body,author,isCrossRepository,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,labels';
const readPr = (target) => {
  let pr = JSON.parse(gh('pr', 'view', target, '--json', fields));
  for (let attempt = 0; pr.mergeable === 'UNKNOWN' && attempt < 3; attempt += 1) {
    pause(3000);
    pr = JSON.parse(gh('pr', 'view', target, '--json', fields));
  }
  return pr;
};

const gather = (target) => {
  const pr = readPr(target);
  const [, owner, name] = new URL(pr.url).pathname.split('/');
  const repo = JSON.parse(gh('repo', 'view', `${owner}/${name}`, '--json', 'defaultBranchRef,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'));
  const viewer = gh('api', 'user', '-q', '.login').trim();
  const query = 'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){'
    + 'reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved}}}}}';
  let unresolvedThreads = 0;
  for (let after = null, more = true; more;) {
    const page = JSON.parse(gh('api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
      '-F', `number=${pr.number}`, ...(after ? ['-f', `after=${after}`] : []))).data.repository.pullRequest.reviewThreads;
    unresolvedThreads += page.nodes.filter((thread) => !thread.isResolved).length;
    ({ hasNextPage: more, endCursor: after } = page.pageInfo);
  }
  const receipt = parseReceipt(pr.body);
  const reviewed = receipt && pr.state === 'OPEN' ? compareTrees(pr, receipt.sha, `${owner}/${name}`) : null;
  return {
    repo, owner, name,
    facts: { pr, viewer, receipt, reviewed, unresolvedThreads, defaultBranch: repo.defaultBranchRef.name, door: parseDoor(pr.body) },
  };
};

const act = ({ repo, owner, name, facts }, decision) => {
  const { pr } = facts;
  const slug = `${owner}/${name}`;
  if (decision.action === 'update-branch') {
    try {
      gh('pr', 'update-branch', String(pr.number), '-R', slug);
      return { decision, acted: 'branch-updated' };
    } catch (error) {
      return { decision: { action: 'hold', reasons: [`update-branch failed: ${firstLine(error)}`] }, acted: null };
    }
  }
  const method = repo.squashMergeAllowed ? '--squash' : repo.mergeCommitAllowed ? '--merge' : repo.rebaseMergeAllowed ? '--rebase' : null;
  if (!method) return { decision: { action: 'hold', reasons: ['the repository allows no merge method'] }, acted: null };
  try {
    gh('pr', 'merge', String(pr.number), '-R', slug, method, '--match-head-commit', pr.headRefOid);
  } catch (error) {
    return { decision: { action: 'hold', reasons: [`merge rejected: ${firstLine(error)}`] }, acted: null };
  }
  const state = JSON.parse(gh('pr', 'view', String(pr.number), '-R', slug, '--json', 'state')).state;
  return state === 'MERGED'
    ? { decision, acted: 'merged' }
    : { decision: { action: 'wait', reasons: ['queued to merge'] }, acted: 'queued' };
};

const main = () => {
  const args = process.argv.slice(2);
  const target = args.filter((arg) => arg !== '--merge');
  if (target.length !== 1) {
    console.error('usage: land-gate.mjs <pr-url|number> [--merge]');
    process.exit(2);
  }
  let gathered;
  try {
    gathered = gather(target[0]);
  } catch (error) {
    console.log(JSON.stringify({ pr: target[0], head: null, action: 'hold', reasons: [`could not read the PR: ${firstLine(error)}`], acted: null }, null, 2));
    return;
  }
  let decision = decide(gathered.facts);
  let acted = null;
  if (args.includes('--merge') && ['merge', 'update-branch'].includes(decision.action)) ({ decision, acted } = act(gathered, decision));
  console.log(JSON.stringify({ pr: gathered.facts.pr.url, head: gathered.facts.pr.headRefOid, ...decision, acted }, null, 2));
};

const isMain = () => {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
};

if (isMain()) main();
