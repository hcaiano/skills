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
    [.id, .user.login, .commit_id, .html_url, .body] | @json'
```

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

Treat unresolved, non-outdated threads as active unless the latest comment is clearly informational or already addressed by a later commit.

## Replies

Reply to a threaded review comment:

```bash
gh api "repos/$OWNER_REPO/pulls/$PR_NUMBER/comments" \
  -f body="$BODY" \
  -F in_reply_to="$COMMENT_ID"
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
