#!/usr/bin/env node

// Resolves which Herdr pane the calling agent is running in, and prints the
// pin every later Herdr mutation is scoped to. Agent-kind agnostic: `--as`
// takes whatever kind Herdr reports in `pane.agent` (claude, codex, grok, ...).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

function herdr(...args) {
  try {
    return execFileSync("herdr", args, { encoding: "utf8" });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    fail(`herdr ${args.join(" ")} failed: ${detail}`);
  }
}

function result(command, ...args) {
  const parsed = JSON.parse(herdr(command, ...args));
  return parsed.result;
}

function paneGet(paneId) {
  const pane = result("pane", "get", paneId).pane;
  if (!pane || pane.pane_id !== paneId) {
    fail(`herdr did not return the exact requested pane ${paneId}`);
  }
  return pane;
}

function workspaceGet(workspaceId) {
  const workspace = result("workspace", "get", workspaceId).workspace;
  if (!workspace || workspace.workspace_id !== workspaceId) {
    fail(`herdr did not return the exact requested workspace ${workspaceId}`);
  }
  return workspace;
}

function sessionSnapshot() {
  const snapshot = result("api", "snapshot").snapshot;
  if (!snapshot || !Array.isArray(snapshot.agents)) {
    fail("herdr api snapshot did not return .result.snapshot.agents");
  }
  return snapshot;
}

function processInfo(paneId) {
  const info = result("pane", "process-info", "--pane", paneId).process_info;
  if (
    !info ||
    info.pane_id !== paneId ||
    !Array.isArray(info.foreground_processes)
  ) {
    fail(`herdr did not return process info for exact pane ${paneId}`);
  }
  for (const entry of info.foreground_processes) {
    const validObject =
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry);
    // herdr omits argv for processes whose full command line it cannot read
    // (npx/bunx wrappers, some helpers). Identity still resolves through
    // name/argv0/cwd, so validate argv only when it is present.
    const validArgv =
      !Object.hasOwn(entry ?? {}, "argv") ||
      (Array.isArray(entry.argv) &&
        entry.argv.every((argument) => typeof argument === "string"));
    const validStrings = ["name", "argv0", "cwd"].every(
      (field) =>
        !Object.hasOwn(entry ?? {}, field) || typeof entry[field] === "string",
    );
    if (!validObject || !validArgv || !validStrings) {
      fail(`herdr returned malformed foreground process for pane ${paneId}`);
    }
  }
  return info;
}

function matchingForegroundProcess(info, agent, repoRoot) {
  return info.foreground_processes.find((entry) => {
    const executables = [entry.name, entry.argv0, entry.argv?.[0]]
      .filter((value) => typeof value === "string")
      .map((value) => basename(value).toLowerCase());
    return executables.includes(agent) && entry.cwd === repoRoot;
  });
}

function requireForegroundProcess(paneId, agent, repoRoot) {
  const info = processInfo(paneId);
  if (!matchingForegroundProcess(info, agent, repoRoot)) {
    fail(
      `pane ${paneId} has no live foreground ${agent} process rooted at ${repoRoot}`,
    );
  }
  return info;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function pinnedCliArguments(pane, repoRoot) {
  return [
    "--pane",
    pane.pane_id,
    "--workspace",
    pane.workspace_id,
    "--tab-id",
    pane.tab_id,
    "--as",
    pane.agent,
    "--terminal-id",
    pane.terminal_id,
    "--repo-root",
    repoRoot,
  ];
}

// The caller's own process ancestry is the one signal nothing can forge or
// stale out: it comes from the live process table, not from anything Herdr
// injected at start. `HERDR_PANE_ID` and the `agent_session` binding both
// derive from the same injected variable — the integration hook reports the
// session *to* `$HERDR_PANE_ID` — so after a pane move they agree on the wrong
// pane together. A parent process cannot be wrong about who its child is.
function ancestorPids() {
  const chain = new Set();
  let pid = process.pid;
  for (let depth = 0; depth < 16 && pid > 1; depth += 1) {
    chain.add(String(pid));
    let parent;
    try {
      parent = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
    } catch {
      break;
    }
    if (!/^\d+$/u.test(parent)) break;
    pid = Number(parent);
  }
  return chain;
}

// Panes share ancestors further up (every pane descends from the Herdr server),
// so a chain that matches more than one pane proves nothing and must fall back.
function identifyByAncestry(snapshot, agent, repoRoot) {
  const chain = ancestorPids();
  const matches = [];
  for (const pane of snapshot.agents) {
    let info;
    try {
      info = processInfo(pane.pane_id);
    } catch {
      // A pane we cannot read is not a pane we can rule out. Treating it as a
      // non-match would turn "one match plus one unknown" into false
      // uniqueness and authorize the remaining pane, so an unreadable
      // candidate abandons this path entirely.
      return null;
    }
    // Same for a pane whose processes report no pid: nothing here can say
    // whether we descend from it.
    if (info.foreground_processes.some((entry) => entry.pid === undefined)) return null;
    if (info.foreground_processes.some((entry) => chain.has(String(entry.pid)))) {
      matches.push(pane);
    }
  }
  if (matches.length !== 1) return null;
  const pane = matches[0];
  if (pane.agent !== agent) {
    fail(
      `the caller's process runs in a ${pane.agent} pane; --as ${agent} does not match`,
    );
  }
  if (pane.cwd !== repoRoot && pane.foreground_cwd !== repoRoot) {
    fail(
      `caller pane ${pane.pane_id} is rooted at ${pane.cwd}, not the declared --repo-root ${repoRoot}`,
    );
  }
  return pane;
}

function conversationMarkers(path) {
  if (!path) {
    fail(
      "the caller proof could not resolve the caller from its own process ancestry (it matched zero or several panes) and therefore requires --conversation-markers-file",
    );
  }
  let markers;
  try {
    markers = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read conversation markers from ${path}: ${error.message}`);
  }
  const values = [
    markers?.newest_user_request,
    markers?.recent_caller_output,
  ];
  if (
    typeof values[0] !== "string" ||
    values[0].trim().length === 0 ||
    typeof values[1] !== "string" ||
    values[1].trim().length < 12 ||
    values[0].trim() === values[1].trim()
  ) {
    fail(
      "conversation markers require a nonempty newest_user_request and a distinct recent_caller_output of at least 12 characters",
    );
  }
  return values.map((value) => value.trim());
}

// Resolve the caller from its own process ancestry, falling back to exact
// conversation evidence, and confirm it with foreground-process proof. Session
// bindings are diagnostic metadata only.
function identify(options) {
  if (process.env.HERDR_ENV !== "1") fail("the caller proof requires HERDR_ENV=1");
  const agent = options.as;
  // Any kind herdr reports in `pane.agent` is a valid caller: the proof reads
  // the live process table and the live snapshot, neither of which knows a
  // fixed roster of harnesses.
  if (typeof agent !== "string" || agent.trim().length === 0) {
    fail("the caller proof requires --as <agent-kind> (the agent kind you are, as herdr reports it)");
  }
  const repoRoot = options["repo-root"];
  if (!repoRoot || !repoRoot.startsWith("/")) {
    fail("the caller proof requires an absolute --repo-root resolved with git -C <task-repository>");
  }
  const snapshot = sessionSnapshot();

  const byAncestry = identifyByAncestry(snapshot, agent, repoRoot);
  if (byAncestry) {
    requireForegroundProcess(byAncestry.pane_id, agent, repoRoot);
    reportIdentity(snapshot, byAncestry, agent, repoRoot, options, "process-ancestry");
    return;
  }

  const markers = conversationMarkers(options["conversation-markers-file"]);
  const repositoryMatches = snapshot.agents.filter(
    (pane) =>
      pane.agent === agent &&
      (pane.cwd === repoRoot || pane.foreground_cwd === repoRoot),
  );
  if (repositoryMatches.length === 0) {
    fail(`snapshot has no ${agent} agent rooted at ${repoRoot}`);
  }

  const candidates = [];
  for (const pane of repositoryMatches) {
    let info;
    try {
      info = processInfo(pane.pane_id);
    } catch (error) {
      fail(`cannot prove foreground process for candidate ${pane.pane_id}: ${error.message}`);
    }
    if (matchingForegroundProcess(info, agent, repoRoot)) candidates.push(pane);
  }
  if (candidates.length === 0) {
    fail(`no snapshot candidate has a live foreground ${agent} process at ${repoRoot}`);
  }

  const transcriptMatches = [];
  for (const pane of candidates) {
    let transcript;
    try {
      transcript = herdr(
        "agent",
        "read",
        pane.pane_id,
        "--source",
        "recent-unwrapped",
        "--lines",
        "200",
      );
    } catch (error) {
      // A pane mid-tool-call refuses scrollback capture (`agent_not_idle`),
      // and the caller's own pane is always working while it runs this proof.
      // The visible screen is still an exact live read of that one pane, so it
      // proves the same binding over a shorter window.
      if (!/agent_not_idle/.test(error.message)) {
        fail(`cannot read candidate transcript ${pane.pane_id}: ${error.message}`);
      }
      try {
        transcript = herdr(
          "agent",
          "read",
          pane.pane_id,
          "--source",
          "visible",
          "--lines",
          "200",
        );
      } catch (visibleError) {
        fail(`cannot read candidate transcript ${pane.pane_id}: ${visibleError.message}`);
      }
    }
    if (!transcript.trim()) {
      fail(`candidate transcript ${pane.pane_id} is empty`);
    }
    if (markers.every((marker) => transcript.includes(marker))) {
      transcriptMatches.push(pane);
    }
  }
  if (transcriptMatches.length !== 1) {
    fail(
      `current conversation matched ${transcriptMatches.length} candidate transcripts; require exactly one`,
    );
  }

  const pane = transcriptMatches[0];
  requireForegroundProcess(pane.pane_id, agent, repoRoot);
  reportIdentity(snapshot, pane, agent, repoRoot, options, "conversation-markers");
}

// Re-read the resolved pane, refuse it if it drifted mid-proof, and emit the
// pin. `proof` names which of the two resolutions selected it.
function reportIdentity(snapshot, pane, agent, repoRoot, options, proof) {
  const livePane = paneGet(pane.pane_id);
  if (
    livePane.agent !== agent ||
    livePane.workspace_id !== pane.workspace_id ||
    livePane.tab_id !== pane.tab_id ||
    livePane.terminal_id !== pane.terminal_id
  ) {
    fail(`caller pane ${pane.pane_id} changed during identity proof`);
  }
  if (!livePane.terminal_id) {
    fail(`caller pane ${pane.pane_id} has no terminal_id; cannot pin identity`);
  }
  const workspace = workspaceGet(pane.workspace_id);

  const sessionId = pane.agent_session?.value ?? null;
  let sessionBindingWarning = null;
  if (sessionId) {
    const owners = snapshot.agents.filter(
      (candidate) => candidate.agent_session?.value === sessionId,
    );
    if (owners.length !== 1) {
      sessionBindingWarning =
        `agent_session ${sessionId} appears on ${owners.length} panes and was ignored`;
    }
  }

  const cli = pinnedCliArguments(livePane, repoRoot);
  if (options.format === "shell") {
    process.stdout.write(`${cli.map(shellQuote).join(" ")}\n`);
    return;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        pane: livePane.pane_id,
        workspace_id: livePane.workspace_id,
        workspace_label: workspace.label ?? null,
        tab_id: livePane.tab_id,
        terminal_id: livePane.terminal_id,
        as: agent,
        repo_root: repoRoot,
        proof,
        agent_session: sessionId,
        session_binding_warning: sessionBindingWarning,
        args: cli,
      },
      null,
      2,
    )}\n`,
  );
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${arg}`);
    options[arg.slice(2)] = value;
    index += 1;
  }
  return options;
}

try {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    fail(
      "usage: caller-proof.mjs --as AGENT-KIND --repo-root PATH [--conversation-markers-file FILE] [--format shell]",
    );
  }
  identify(parseOptions(args));
} catch (error) {
  const detail = error instanceof CliError ? error.message : error.stack ?? error.message;
  process.stderr.write(`${detail}\n`);
  process.exitCode = 1;
}
