# GitHub Comment Fetching

Reference commands for the PR comment loop. Prefer `--paginate` where supported so long reviews are not silently truncated.

Set common variables first:

```bash
OWNER_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
PR_NUMBER="$(gh pr view --json number -q .number)"
```

## REST Surfaces

Review comments:

```bash
gh api "repos/$OWNER_REPO/pulls/$PR_NUMBER/comments" --paginate
```

Reviews:

```bash
gh api "repos/$OWNER_REPO/pulls/$PR_NUMBER/reviews" --paginate
```

Non-empty review bodies can contain actionable findings that are not present as
review-thread nodes. Fetch and classify them explicitly:

```bash
gh api "repos/$OWNER_REPO/pulls/$PR_NUMBER/reviews" --paginate |
  jq -r '.[] | select((.body // "") != "") |
    {rest_id: .id, node_id: .node_id, author: .user.login, commit_id: .commit_id, html_url: .html_url, body: .body} | @json'
```

Use `node_id`, not the numeric REST `rest_id`, as `$REVIEW_NODE_ID` for the
GraphQL minimization checks below.

Top-level issue comments:

```bash
gh api "repos/$OWNER_REPO/issues/$PR_NUMBER/comments" --paginate
```

PR metadata and mergeability:

```bash
gh pr view "$PR_NUMBER" --json number,headRefName,baseRefName,mergeStateStatus,reviewDecision,isDraft,statusCheckRollup
```

Changed files:

```bash
gh pr diff "$PR_NUMBER" --name-only
```

Checks:

```bash
gh pr checks "$PR_NUMBER"
```

## Target Branch Sync

Resolve the live PR target instead of assuming `main`, fetch its remote tip, and
record the exact target SHA used by the clean recheck:

```bash
BASE_BRANCH="$(gh pr view "$PR_NUMBER" --json baseRefName -q .baseRefName)"
git fetch origin "$BASE_BRANCH"
BASE_SHA="$(git rev-parse "origin/$BASE_BRANCH")"
```

From the checked-out PR branch, follow the repo's explicit integration convention.
With no explicit convention, merge the fetched remote target:

```bash
git merge --no-edit "origin/$BASE_BRANCH"
```

After resolving any conflicts, verify the index and target ancestry before the
quality gate and push:

```bash
test -z "$(git diff --name-only --diff-filter=U)"
git merge-base --is-ancestor "$BASE_SHA" HEAD
```

Before each clean recheck, repeat the fetch and ancestry test. A changed
`BASE_SHA` or failed ancestry test means the target advanced; integrate it, push,
and restart the loop.

## Unresolved Review Threads

Use GraphQL for review thread resolution state:

```bash
gh api graphql --paginate -f owner="${OWNER_REPO%/*}" -f name="${OWNER_REPO#*/}" -F number="$PR_NUMBER" -f query='
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 20) {
            nodes {
              id
              databaseId
              author { login }
              body
              url
              createdAt
            }
          }
        }
      }
    }
  }
}'
```

Treat every `isResolved=false` thread as review inventory, even when
`isOutdated=true`. Outdated means the diff hunk moved; it does not mean the
conversation is closed in GitHub's UI.

Summarize unresolved threads without dropping outdated ones:

```bash
gh api graphql --paginate --slurp \
  -f owner="${OWNER_REPO%/*}" -f name="${OWNER_REPO#*/}" -F number="$PR_NUMBER" -f query='
query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 20) {
            nodes {
              databaseId
              author { login }
              body
              url
              createdAt
              outdated
              commit { oid }
            }
          }
        }
      }
    }
  }
}' | jq '.[0].data.repository.pullRequest.headRefOid as $head |
  [.[].data.repository.pullRequest.reviewThreads.nodes[]] as $threads |
  {head: $head,
   unresolved: [$threads[]
     | select(.isResolved == false)
     | {id, path, line, isOutdated,
        comments: [.comments.nodes[]
          | {databaseId, url, author: .author.login, createdAt, outdated,
             commit: .commit.oid,
             title: (.body | split("\n") | map(select(length > 0))[0:2])}]}],
   resolved_count: ([$threads[] | select(.isResolved == true)] | length),
   total_threads: ($threads | length)}'
```

Verify one review thread after replying or resolving:

```bash
gh api graphql -f query='
query($id: ID!) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      id
      isResolved
      isOutdated
      path
      line
      comments(first: 20) {
        nodes {
          databaseId
          author { login }
          body
          url
        }
      }
    }
  }
}' -f id="$THREAD_NODE_ID"
```

If the verification still shows `isResolved=false`, the loop is not clean. Do
not report completion; resolve or classify the blocker under Needs attention.

## Replies

Reply to a threaded review comment:

```bash
gh api "repos/$OWNER_REPO/pulls/$PR_NUMBER/comments" \
  -f body="$BODY" \
  -F in_reply_to="$COMMENT_ID"
```

Resolve a processed review thread:

```bash
gh api graphql -f query='
mutation($id: ID!) {
  resolveReviewThread(input: {threadId: $id}) {
    thread {
      id
      isResolved
    }
  }
}' -f id="$THREAD_NODE_ID"
```

Reply to a top-level issue comment:

```bash
gh api "repos/$OWNER_REPO/issues/$PR_NUMBER/comments" \
  -f body="$BODY"
```

Reply to an actionable PR review body with a top-level issue comment that quotes
the review permalink and finding title:

```bash
gh api "repos/$OWNER_REPO/issues/$PR_NUMBER/comments" \
  -f body="$BODY"
```

Check whether an actionable review body can be minimized after the audit reply:

```bash
gh api graphql -f query='
query($id: ID!) {
  node(id: $id) {
    __typename
    id
    ... on Minimizable {
      isMinimized
      minimizedReason
      viewerCanMinimize
    }
  }
}' -f id="$REVIEW_NODE_ID"
```

Minimize a fixed review-body finding that has no resolvable thread:

```bash
gh api graphql -f query='
mutation($id: ID!) {
  minimizeComment(input: {subjectId: $id, classifier: RESOLVED}) {
    minimizedComment {
      isMinimized
      minimizedReason
    }
  }
}' -f id="$REVIEW_NODE_ID"
```

React to a review comment:

```bash
gh api "repos/$OWNER_REPO/pulls/comments/$COMMENT_ID/reactions" \
  -f content="+1"
```

React to an issue comment:

```bash
gh api "repos/$OWNER_REPO/issues/comments/$COMMENT_ID/reactions" \
  -f content="+1"
```
