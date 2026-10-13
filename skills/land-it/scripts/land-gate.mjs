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
//     `<grade> by <models>; <n> fixed, <n> rejected, <n> open; reviewed <sha>`
//     graded single (or skip, when every changed file is plain docs) with no
//     rejected and no open findings: every reviewer agreed;
//   - the reviewed commit still describes the change: the head is that commit,
//     or merging the reviewed commit with the base the head now contains gives
//     exactly the head's tree; and the base did not change after the review;
//   - checks reported and all passed, review threads are resolved, nothing
//     requests changes, and GitHub reports no conflict or protection block.
// Pending checks or unknown mergeability give wait; a branch behind its base
// gives update-branch; any other failed rule gives hold.
//
// --merge uses the first merge method the repository allows (squash, merge,
// rebase) with --match-head-commit, so a push after the decision fails the
// merge instead of landing unreviewed code. It never uses --admin. Git runs
// in the current directory, a checkout of the PR's repository.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const receiptPattern = /^\*\*Review\.\*\*\s*(skip|single|dual)\b[^;\n]*;\s*(\d+)\s+fixed,\s*(\d+)\s+rejected,\s*(\d+)\s+open;\s*reviewed\s+`?([0-9a-f]{7,40})`?/gim;

export const parseReceipt = (body) => {
  const all = [...(body ?? '').matchAll(receiptPattern)];
  if (all.length === 0) return null;
  const [, grade, fixed, rejected, open, sha] = all.at(-1);
  return { grade: grade.toLowerCase(), fixed: Number(fixed), rejected: Number(rejected), open: Number(open), sha: sha.toLowerCase() };
};

export const parseDoor = (body) => {
  const text = body ?? '';
  if (/Door:\s*one-way/i.test(text)) return 'one-way';
  const line = text.split('\n').find((candidate) => candidate.trimStart().startsWith('**Merge danger.**'));
  return /Door:\s*two-way/i.test(line ?? '') ? 'two-way' : null;
};

// Plain documentation: no code that runs and no agent instructions.
const agentPaths = /(^|\/)(skills|\.claude|\.codex|\.cursor|\.agents|\.github)\//i;
const agentFiles = /(^|\/)(AGENTS|CLAUDE|GEMINI|SKILL)\.md$/i;
export const docsOnly = (files) => files.length > 0
  && files.every((file) => /\.(md|mdx|txt|rst)$/i.test(file) && !agentPaths.test(file) && !agentFiles.test(file));

const checkState = (check) => {
  if (check.__typename === 'StatusContext') {
    if (check.state === 'SUCCESS') return 'pass';
    return check.state === 'PENDING' || check.state === 'EXPECTED' ? 'pending' : 'fail';
  }
  if (check.status !== 'COMPLETED') return 'pending';
  return ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion) ? 'pass' : 'fail';
};

// facts: { pr, viewer, defaultBranch, unresolvedThreads, moreThreads, receipt,
//          door, reviewed: { matches, reason } | null, baseChangedAfterReview }
export const decide = (facts) => {
  const { pr } = facts;
  if (pr.state !== 'OPEN') return { action: 'done', reasons: [`PR is ${pr.state.toLowerCase()}`] };
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
    if (receipt.grade === 'dual') holds.push('review-it graded dual');
    if (receipt.grade === 'skip' && !(pr.changedFiles <= (pr.files ?? []).length && docsOnly(pr.files.map((file) => file.path)))) {
      holds.push('graded skip but changes more than plain docs');
    }
    if (receipt.rejected > 0) holds.push(`${receipt.rejected} rejected review finding(s): reviewers did not all agree`);
    if (receipt.open > 0) holds.push(`${receipt.open} review finding(s) or blocker(s) left open`);
    if (facts.reviewed && !facts.reviewed.matches) holds.push(facts.reviewed.reason);
    if (facts.baseChangedAfterReview) holds.push('base changed after the review');
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') holds.push('changes requested');
  if (pr.mergeable === 'CONFLICTING') holds.push('conflicts with the base');
  if (facts.unresolvedThreads || facts.moreThreads) holds.push(`${facts.unresolvedThreads}${facts.moreThreads ? '+' : ''} unresolved review thread(s)`);
  const checks = pr.statusCheckRollup ?? [];
  if (checks.length === 0) holds.push('no checks reported');
  const states = checks.map((check) => [check.name ?? check.context, checkState(check)]);
  const failing = states.filter(([, state]) => state === 'fail').map(([name]) => name);
  if (failing.length) holds.push(`failing checks: ${failing.join(', ')}`);
  const pending = states.filter(([, state]) => state === 'pending').map(([name]) => name);
  if (pending.length) waits.push(`pending checks: ${pending.join(', ')}`);
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
const compareTrees = (pr, receiptSha) => {
  try {
    git('fetch', '-q', 'origin', pr.baseRefName, `pull/${pr.number}/head`);
    const reviewed = git('rev-parse', '--verify', `${receiptSha}^{commit}`);
    const reviewedAt = git('show', '-s', '--format=%cI', reviewed);
    if (reviewed === pr.headRefOid) return { matches: true, reviewedAt };
    const base = git('merge-base', `origin/${pr.baseRefName}`, pr.headRefOid);
    let expected;
    try {
      expected = git('merge-tree', '--write-tree', reviewed, base).split('\n')[0];
    } catch {
      return { matches: false, reason: `the reviewed ${receiptSha} conflicts with the base the head contains`, reviewedAt };
    }
    const actual = git('rev-parse', `${pr.headRefOid}^{tree}`);
    return expected === actual
      ? { matches: true, reviewedAt }
      : { matches: false, reason: `HEAD changed since the review of ${receiptSha}`, reviewedAt };
  } catch (error) {
    return { matches: false, reason: `could not compare the reviewed and current code: ${firstLine(error)}` };
  }
};

const fields = 'number,url,state,isDraft,body,author,isCrossRepository,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,labels,files,changedFiles';
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
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){'
    + 'reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}} '
    + 'timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT],last:1){nodes{... on BaseRefChangedEvent{createdAt}}}}}}';
  const data = JSON.parse(gh('api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr.number}`))
    .data.repository.pullRequest;
  const receipt = parseReceipt(pr.body);
  const reviewed = receipt && pr.state === 'OPEN' ? compareTrees(pr, receipt.sha) : null;
  const baseChangedAt = data.timelineItems.nodes[0]?.createdAt;
  return {
    repo, owner, name,
    facts: {
      pr, viewer, receipt, reviewed,
      defaultBranch: repo.defaultBranchRef.name,
      door: parseDoor(pr.body),
      unresolvedThreads: data.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
      moreThreads: data.reviewThreads.pageInfo.hasNextPage,
      baseChangedAfterReview: Boolean(baseChangedAt && reviewed?.reviewedAt && Date.parse(baseChangedAt) > Date.parse(reviewed.reviewedAt)),
    },
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
  const gathered = gather(target[0]);
  let decision = decide(gathered.facts);
  let acted = null;
  if (args.includes('--merge') && ['merge', 'update-branch'].includes(decision.action)) ({ decision, acted } = act(gathered, decision));
  console.log(JSON.stringify({ pr: gathered.facts.pr.url, head: gathered.facts.pr.headRefOid, ...decision, acted }, null, 2));
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
