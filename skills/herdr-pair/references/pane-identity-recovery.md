# Explicit pane identity recovery

Use this procedure when session-based `id` cannot resolve the caller, resolves
a pane that fails the agent/repository/transcript checks, or resolves a stale
owner after the user says the session moved to another pane.

1. Stop before every workspace, pane, agent, GitHub, branch, or worktree
   mutation. Report the stale `HERDR_PANE_ID` hint and the missing session
   match.
2. Require the user to explicitly confirm the intended pane ID, workspace ID,
   and repository. Do not infer them from focus, labels, pane numbers, cwd, or
   `herdr pane current`.
3. Resolve the task repository without relying on inherited cwd:

   ```bash
   git -C <task repository> rev-parse --show-toplevel
   ```

4. Retry the read-only identity lookup against the confirmed pane:

   ```bash
   node "$PAIR_SCRIPT" id \
     --pane <confirmed pane> --as <claude|codex> \
     --session <your session id>
   ```

5. Require all of these independent checks:

   - the helper returns the exact confirmed pane, agent kind, and workspace;
   - `herdr workspace get <workspace_id>` returns the confirmed workspace;
   - when the workspace exposes a worktree, its `worktree.checkout_path`
     (or `worktree.repo_root` on older metadata) equals the explicit task
     repository root;
   - `herdr agent read <pane_id> --source recent-unwrapped --lines 160` shows
     the same current conversation and repository task as the caller's own
     transcript.

   A same-kind agent or plausible workspace label is not transcript proof.
   When the workspace has no registered worktree, continue only if the user
   explicitly named the repository and the pane transcript independently
   confirms it. An absent, unreadable, or ambiguous transcript is a hard stop.

6. After every check passes, repair only Herdr's session metadata:

   ```bash
   node "$PAIR_SCRIPT" rebind-session \
     --pane <confirmed pane> --as <claude|codex> \
     --session <your session id> --workspace <confirmed workspace> \
     --repo-root <absolute task repo root> \
     --repo-validation <registered|transcript> \
     --transcript-verified true
   ```

   Use `registered` only when the registered checkout path exists and matches.
   Use `transcript` only when the workspace has no registered worktree and the
   confirmed transcript proves the repository. The helper claims the exact
   session on the confirmed pane and verifies that Herdr persisted the expected
   source, agent, and session. Only then does it clear one exact previous owner.
   A rejected claim leaves previous ownership intact; a failed cleanup rolls
   back the new claim; conflicting, multiple, or unverifiable ownership fails
   closed.

7. Rerun the normal session-based `id` lookup without `--pane`. Require one
   unique match for the confirmed pane before continuing.

This procedure never uses pane focus, `herdr pane current`, pane cwd, or the
caller's inherited cwd as identity authority.
