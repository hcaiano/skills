#!/usr/bin/env node
// Decides whether one GitHub PR may be merged without the user, and with
// --merge acts on that decision. Prints one JSON object:
//   pr       the PR URL
//   head     the head SHA the decision describes
//   action   merge | update-branch | wait | hold | done
//   reasons  why the action is not merge; empty when it is
//   acted    with --merge, what was run: merged, branch-updated, or null
//
// A PR is landable when its body says `Door: two-way`, its `**Review.**`
// receipt (from review-it, carried by write-pr) is graded skip or single with
// 0 rejected findings, the receipt reviewed the current change, checks are
// green, review threads are resolved, nothing requests changes, no hold
// label is set, and its base is not another PR's branch: a stack lands
// bottom-up, and a layer whose parent merged is rebased and retargeted first. A head that moved since the receipt still counts as reviewed
// when the only difference is the base merged in: the PR's net patch-id is
// unchanged. That comparison runs git in the current directory, a checkout of
// the PR's repository.
//
// Precedence: any hold reason gives hold; otherwise pending checks or an
// unknown mergeable state give wait; otherwise a branch behind its base gives
// update-branch; otherwise merge. --merge squashes with --match-head-commit,
// so a push after the decision makes the merge fail instead of landing
// unreviewed code.
import { execFileSync } from 'node:child_process';

const usage = 'usage: land-gate.mjs <pr-url|number> [--merge]';
const args = process.argv.slice(2);
const doMerge = args.includes('--merge');
const target = args.filter((arg) => arg !== '--merge');
if (target.length !== 1) {
  console.error(usage);
  process.exit(2);
}

const run = (cmd, argv, input) => execFileSync(cmd, argv, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
const gh = (...argv) => run('gh', argv);
const git = (...argv) => run('git', argv).trim();

const fields = 'number,url,state,isDraft,body,headRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,labels';
const pr = JSON.parse(gh('pr', 'view', target[0], '--json', fields));
const [, owner, name] = new URL(pr.url).pathname.split('/');
const repo = `${owner}/${name}`;

const receiptPattern = /\*\*Review\.\*\*\s*(skip|single|dual)\b[^;\n]*;\s*(\d+)\s+fixed,\s*(\d+)\s+rejected;\s*reviewed\s+`?([0-9a-f]{7,40})`?/gi;
const parseReceipt = (body) => {
  const all = [...(body ?? '').matchAll(receiptPattern)];
  if (all.length === 0) return null;
  const [, grade, fixed, rejected, sha] = all.at(-1);
  return { grade: grade.toLowerCase(), fixed: Number(fixed), rejected: Number(rejected), sha: sha.toLowerCase() };
};

const checkState = (check) => {
  if (check.__typename === 'StatusContext') {
    if (check.state === 'SUCCESS') return 'pass';
    return check.state === 'PENDING' || check.state === 'EXPECTED' ? 'pending' : 'fail';
  }
  if (check.status !== 'COMPLETED') return 'pending';
  return ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion) ? 'pass' : 'fail';
};

const unresolvedThreads = () => {
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}}}}';
  const threads = JSON.parse(gh('api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${pr.number}`))
    .data.repository.pullRequest.reviewThreads;
  return { open: threads.nodes.filter((thread) => !thread.isResolved).length, more: threads.pageInfo.hasNextPage };
};

// The patch a commit adds on top of where it meets the base branch.
const netPatchId = (sha, baseRef) => {
  const diff = git('diff', git('merge-base', baseRef, sha), sha);
  return run('git', ['patch-id', '--stable'], `${diff}\n`).split(' ')[0];
};
const reviewedCurrentChange = (receiptSha) => {
  if (pr.headRefOid.toLowerCase().startsWith(receiptSha)) return true;
  try {
    git('fetch', '-q', 'origin', pr.baseRefName, `pull/${pr.number}/head`);
    const baseRef = `origin/${pr.baseRefName}`;
    const reviewed = git('rev-parse', '--verify', `${receiptSha}^{commit}`);
    return netPatchId(reviewed, baseRef) === netPatchId(pr.headRefOid, baseRef);
  } catch {
    return false;
  }
};

const decide = () => {
  if (pr.state !== 'OPEN') return { action: 'done', reasons: [`PR is ${pr.state.toLowerCase()}`] };
  const holds = [];
  const waits = [];
  if (pr.isDraft) holds.push('draft');
  const holdLabels = pr.labels.map((label) => label.name).filter((label) => /hold|do.?not.?merge|wip/i.test(label));
  if (holdLabels.length) holds.push(`hold label: ${holdLabels.join(', ')}`);
  const door = /Door:\s*(one-way|two-way)/i.exec(pr.body ?? '')?.[1]?.toLowerCase();
  if (door !== 'two-way') holds.push(door ? 'Door: one-way' : 'no Door in the PR body');
  const receipt = parseReceipt(pr.body);
  if (!receipt) holds.push('no review-it receipt in the PR body');
  else {
    if (receipt.grade === 'dual') holds.push('review-it graded dual');
    if (receipt.rejected > 0) holds.push(`${receipt.rejected} rejected review finding(s): reviewers did not all agree`);
    if (!reviewedCurrentChange(receipt.sha)) holds.push(`HEAD changed since the review of ${receipt.sha}`);
  }
  const [below] = JSON.parse(gh('pr', 'list', '-R', repo, '--head', pr.baseRefName, '--state', 'all', '--json', 'number,state,baseRefName'));
  if (below?.state === 'OPEN') holds.push(`base is the branch of open PR #${below.number}; land it first`);
  if (below?.state === 'MERGED') holds.push(`PR #${below.number} under this one merged; rebase onto ${below.baseRefName} and retarget`);
  if (pr.reviewDecision === 'CHANGES_REQUESTED') holds.push('changes requested');
  if (pr.mergeable === 'CONFLICTING') holds.push('conflicts with the base');
  const threads = unresolvedThreads();
  if (threads.open || threads.more) holds.push(`${threads.open}${threads.more ? '+' : ''} unresolved review thread(s)`);
  const checks = pr.statusCheckRollup ?? [];
  if (checks.length === 0) holds.push('no checks reported');
  const states = checks.map((check) => [check.name ?? check.context, checkState(check)]);
  const failing = states.filter(([, state]) => state === 'fail').map(([checkName]) => checkName);
  if (failing.length) holds.push(`failing checks: ${failing.join(', ')}`);
  const pending = states.filter(([, state]) => state === 'pending').map(([checkName]) => checkName);
  if (pending.length) waits.push(`pending checks: ${pending.join(', ')}`);
  if (pr.mergeable === 'UNKNOWN') waits.push('GitHub is still computing mergeability');
  if (holds.length) return { action: 'hold', reasons: [...holds, ...waits] };
  if (waits.length) return { action: 'wait', reasons: waits };
  if (pr.mergeStateStatus === 'BEHIND') return { action: 'update-branch', reasons: ['branch is behind its base'] };
  return { action: 'merge', reasons: [] };
};

const decision = decide();
let acted = null;
if (doMerge && decision.action === 'merge') {
  gh('pr', 'merge', String(pr.number), '-R', repo, '--squash', '--match-head-commit', pr.headRefOid);
  acted = 'merged';
} else if (doMerge && decision.action === 'update-branch') {
  gh('pr', 'update-branch', String(pr.number), '-R', repo);
  acted = 'branch-updated';
}
console.log(JSON.stringify({ pr: pr.url, head: pr.headRefOid, ...decision, acted }, null, 2));
