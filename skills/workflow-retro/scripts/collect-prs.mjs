import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { json, main } from './io.mjs';
const exec = promisify(execFile);
const pageInfo = 'pageInfo { hasNextPage endCursor }';
const comments = `comments(first: 50, after: $commentCursor) { nodes { id body url createdAt updatedAt path diffHunk author { login } replyTo { id } } ${pageInfo} }`;
const threadQuery = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String,$commentCursor:String) {
  repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
    reviewThreads(first:50,after:$cursor) { nodes { id isResolved isOutdated path line ${comments} } ${pageInfo} }
  } }
}`;
const commentQuery = `query($id:ID!,$commentCursor:String) { node(id:$id) { ... on PullRequestReviewThread { ${comments} } } }`;
async function gh(args) {
  const { stdout } = await exec('gh', ['api', ...args], { maxBuffer: 16 * 1024 ** 2, timeout: 120000 });
  const data = JSON.parse(stdout);
  if (data.errors?.length) throw new Error('GitHub GraphQL errors: ' + data.errors.map(e => e.message).join('; '));
  return data;
}
async function connection(fetch, emit, initialCursor) {
  let cursor = initialCursor; const seen = new Set(initialCursor ? [initialCursor] : []);
  do {
    const page = await fetch(cursor);
    if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') throw new Error('Missing GitHub connection');
    await emit(page);
    if (!page.pageInfo.hasNextPage) return;
    cursor = page.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) throw new Error('GitHub pagination made no progress');
    seen.add(cursor);
  } while (true);
}

await main('prs', false, async (opts, out) => {
  const urls = new Map();
  function add(value, provenance) {
    const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(value);
    if (!match) throw new Error('Invalid GitHub PR URL');
    const url = `https://github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/pull/${Number(match[3])}`;
    const pr = urls.get(url) || { owner: match[1], repo: match[2], number: Number(match[3]), provenance: [] };
    for (const ref of provenance) if (!pr.provenance.some(r => JSON.stringify(r) === JSON.stringify(ref))) pr.provenance.push(ref);
    urls.set(url, pr);
  }
  for (const path of (opts.indexes || '').split(',').filter(Boolean)) {
    const index = await json(path);
    if (index.version !== 1 || !index.prs) throw new Error('Unsupported input index');
    if (!index.complete) out.gap('partial-input', { path, source: index.source, machine: index.machine });
    for (const [url, refs] of Object.entries(index.prs)) add(url, refs);
  }
  for (const url of (opts.urls || '').split(',').filter(Boolean)) add(url, [{ machine: opts.machine, sessionId: 'explicit' }]);
  if (!opts.indexes && !opts.urls) throw new Error('--indexes or --urls is required');
  out.index.completedPrs = [];
  for (const [prUrl, pr] of urls) {
    const base = `repos/${pr.owner}/${pr.repo}`;
    async function emit(kind, raw, extra = {}) { await out.emit({ prUrl, provenance: pr.provenance, kind, ...extra, raw }); }
    async function restPages(endpoint, kind, field) {
      for (let page = 1; ; page++) {
        const raw = await gh([`${endpoint}?per_page=100&page=${page}`]);
        const items = field ? raw[field] : raw;
        if (!Array.isArray(items)) throw new Error(`Missing GitHub ${kind} page`);
        await emit(kind, raw, { page });
        if (items.length < 100) break;
      }
    }
    try {
      const body = await gh([`${base}/pulls/${pr.number}`]);
      if (!body.head?.sha) throw new Error('Missing PR head SHA');
      await emit('pull-request', body);
      await restPages(`${base}/pulls/${pr.number}/reviews`, 'reviews');
      await connection(async cursor => {
        const args = ['graphql', '-f', `query=${threadQuery}`, '-f', `owner=${pr.owner}`, '-f', `repo=${pr.repo}`, '-F', `number=${pr.number}`];
        if (cursor) args.push('-f', `cursor=${cursor}`);
        return (await gh(args)).data?.repository?.pullRequest?.reviewThreads;
      }, async page => {
        await emit('review-threads', page);
        for (const thread of page.nodes) {
          if (!thread.comments?.pageInfo) throw new Error('Missing review comments');
          if (!thread.comments.pageInfo.hasNextPage) continue;
          const first = thread.comments.pageInfo.endCursor;
          if (!first) throw new Error('Missing review comment cursor');
          await connection(async cursor => {
            const data = await gh(['graphql', '-f', `query=${commentQuery}`, '-f', `id=${thread.id}`, '-f', `commentCursor=${cursor}`]);
            return data.data?.node?.comments;
          }, page => emit('review-comments', page, { reviewThreadId: thread.id }), first);
        }
      });
      await restPages(`${base}/commits/${body.head.sha}/check-runs`, 'checks', 'check_runs');
      await restPages(`${base}/commits/${body.head.sha}/statuses`, 'statuses');
      out.index.completedPrs.push(prUrl);
    } catch (e) { out.gap('partial-pr', { prUrl, message: e.message }); }
  }
});
