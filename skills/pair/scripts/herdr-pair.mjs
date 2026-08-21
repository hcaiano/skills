#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { matchingForegroundProcess } from "./agent-process.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scriptPath = fileURLToPath(import.meta.url);
// Every agent kind `herdr agent start --kind` can bring up. A pair is always
// exactly two of them, and never twice the same one: two panes of one CLI echo
// each other instead of reviewing each other. One pane may hold several
// concurrent pairs — one sid-scoped session file each.
const agentKinds = ["claude", "codex", "cursor", "grok"];
const kindList = agentKinds.join("|");
const roles = ["peer", "executor"];
// Schema 3 keys participants by agent kind across four kinds and records the
// role. There is no migration from the two-kind schemas: an old session names
// panes a new one cannot place, so it is ended rather than rewritten.
const schemaVersion = 3;
const staleLockMs = 60000;
const pasteSettleMs = 400;
const processStartFormat = "ps-lstart-c-utc-v1";
let callerContext = null;

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

function paneList(workspaceId) {
  return result("pane", "list", "--workspace", workspaceId).panes;
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

function requireForegroundProcess(paneId, agent, repoRoot) {
  const info = processInfo(paneId);
  if (!matchingForegroundProcess(info, agent, repoRoot)) {
    fail(
      `pane ${paneId} has no live foreground ${agent} process rooted at ${repoRoot}`,
    );
  }
  return info;
}

function currentPane() {
  if (process.env.HERDR_ENV !== "1") {
    fail("herdr-pair requires HERDR_ENV=1");
  }
  if (
    !callerContext?.paneId ||
    !callerContext?.workspaceId ||
    !callerContext?.tabId ||
    !callerContext?.agent ||
    !callerContext?.terminalId ||
    !callerContext?.repoRoot
  ) {
    fail(
      "herdr-pair requires the transcript-proven --pane, --workspace, --tab-id, --as, --terminal-id, and --repo-root pin",
    );
  }
  if (!agentKinds.includes(callerContext.agent)) {
    fail(`unsupported caller agent: ${callerContext.agent}`);
  }

  const pane = paneGet(callerContext.paneId);
  if (pane.agent !== callerContext.agent) {
    fail(
      `caller identity mismatch: --pane ${callerContext.paneId} is ${pane.agent ?? "not an agent"}, not --as ${callerContext.agent}`,
    );
  }
  if (pane.workspace_id !== callerContext.workspaceId) {
    fail(
      `caller workspace mismatch: --pane ${pane.pane_id} belongs to ${pane.workspace_id ?? "none"}, not --workspace ${callerContext.workspaceId}`,
    );
  }
  if (pane.tab_id !== callerContext.tabId) {
    fail(
      `caller tab mismatch: --pane ${pane.pane_id} belongs to ${pane.tab_id ?? "none"}, not --tab-id ${callerContext.tabId}`,
    );
  }
  if (pane.terminal_id !== callerContext.terminalId) {
    fail(`caller terminal changed for ${pane.pane_id}; rerun transcript proof`);
  }
  requireForegroundProcess(pane.pane_id, callerContext.agent, callerContext.repoRoot);
  return pane;
}

function participantRecord(pane) {
  return {
    pane_id: pane.pane_id,
    terminal_id: pane.terminal_id ?? null,
    agent_session_id: pane.agent_session?.value ?? null,
  };
}

// A pane id alone does not identify a conversation: the same pane can hold a
// replacement agent session after the first one exits. terminal_id catches a
// recycled terminal. For Claude, Cursor, and Grok, agent_session_id catches a
// fresh conversation started in the SAME terminal, which would otherwise
// inherit the pair and receive session-bound sends. Codex is different: Herdr
// reports a new thread id after compaction and can report a subagent thread id
// while delegation runs, so its pane and terminal are the stable identity.
// A null recorded id stays tolerant — normalizeSession backfills it on the
// next verify, so sessions written before this check keep working.
function participantMatches(record, pane) {
  // Herdr can briefly report a live pane without its agent_session metadata
  // while the agent is restarting or before its binding has been re-reported.
  // The pane and terminal still prove which terminal we are talking to; a
  // missing live session id is unreported, not evidence of a replacement
  // conversation. Keep rejecting a live id that disagrees with the record for
  // CLIs whose ids are stable. A Codex id mismatch is a thread roll within the
  // already-pinned pane and terminal, not a replaced partner.
  const liveAgentSessionId = pane.agent_session?.value ?? null;
  return (
    record?.pane_id === pane.pane_id &&
    (!record.terminal_id || record.terminal_id === pane.terminal_id) &&
    (!record.agent_session_id ||
      liveAgentSessionId === null ||
      pane.agent === "codex" ||
      record.agent_session_id === liveAgentSessionId)
  );
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function pinnedCliText(pane, repoRoot) {
  return pinnedCliArguments(pane, repoRoot)
    .map(shellQuote)
    .join(" ");
}

// One file per pair, named after the partner's pane, so a lead pane can hold
// several concurrent pairs in one tab. `session.json` is the single-pair name
// written before this and keeps resolving and resuming.
function tabDirectory(self) {
  const slug = self.tab_id.replaceAll(":", "_");
  return join(homedir(), ".herdr-coworkers", self.workspace_id, slug);
}

function sessionPathFor(self, partnerPaneId) {
  return join(tabDirectory(self), `pair-${partnerPaneId.replaceAll(":", "_")}.json`);
}

function isSessionFileName(name) {
  return name === "session.json" || (name.startsWith("pair-") && name.endsWith(".json"));
}

function readSessionEntries(self) {
  const directory = tabDirectory(self);
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter(isSessionFileName)
    .sort()
    .map((name) => {
      const path = join(directory, name);
      try {
        return { path, session: JSON.parse(readFileSync(path, "utf8")) };
      } catch {
        return { path, session: null };
      }
    });
}

function partnerKindOf(session, selfAgent) {
  return (
    Object.keys(session?.participants ?? {}).find(
      (kind) => kind !== selfAgent && agentKinds.includes(kind),
    ) ?? null
  );
}

function describeEntry(entry, self) {
  const kind = partnerKindOf(entry.session, self.agent);
  return `sid ${entry.session?.sid ?? "unreadable"} (partner ${kind ?? "unknown"} in pane ${
    (kind && entry.session.participants[kind]?.pane_id) ?? "unknown"
  })`;
}

// Which pair the caller means. With a sid it is exact; without one it is
// unambiguous only while the tab holds a single session, and the refusal lists
// what to name instead.
function resolveSessionPath(self, sid = null) {
  const entries = readSessionEntries(self);
  if (entries.length === 0) {
    fail(`cannot load current-tab session in ${tabDirectory(self)}: no session file exists`);
  }
  if (sid) {
    const match = entries.find((entry) => entry.session?.sid === sid);
    if (!match) {
      fail(
        `no session with sid ${sid} in current tab ${self.tab_id}; this tab holds: ${entries
          .map((entry) => describeEntry(entry, self))
          .join("; ")}`,
      );
    }
    return match.path;
  }
  const active = entries.filter((entry) => entry.session && entry.session.active !== false);
  const chosen = active.length > 0 ? active : entries;
  if (chosen.length !== 1) {
    fail(
      `current tab ${self.tab_id} holds ${chosen.length} pair sessions; name one with --sid — ${chosen
        .map((entry) => describeEntry(entry, self))
        .join("; ")}`,
    );
  }
  return chosen[0].path;
}

function pairedPaneIds(entries) {
  const ids = new Set();
  for (const entry of entries) {
    if (!entry.session || entry.session.active === false) continue;
    for (const record of Object.values(entry.session.participants ?? {})) {
      if (record?.pane_id) ids.add(record.pane_id);
    }
  }
  return ids;
}

function byKind(value) {
  return Object.fromEntries(agentKinds.map((kind) => [kind, value]));
}

function emptyDelivery() {
  return {
    next: byKind(0),
    submitted: byKind(0),
    received: byKind(0),
    pending: byKind(null),
  };
}

function atomicWrite(path, value) {
  const temp = `${path}.tmp.${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temp, path);
}

function normalizeSession(session, live) {
  let changed = false;
  const normalized = structuredClone(session);

  if (normalized.participants && live?.self && live?.partner) {
    for (const pane of [live.self, live.partner]) {
      const record = normalized.participants[pane.agent];
      if (
        record?.pane_id === pane.pane_id &&
        ((record.terminal_id == null && pane.terminal_id) ||
          (record.agent_session_id == null && pane.agent_session?.value))
      ) {
        normalized.participants[pane.agent] = {
          ...participantRecord(pane),
          ...record,
          terminal_id: record.terminal_id ?? pane.terminal_id ?? null,
          agent_session_id:
            record.agent_session_id ?? pane.agent_session?.value ?? null,
        };
        changed = true;
      }
    }
  }
  if (normalized.schema_version !== schemaVersion) {
    normalized.schema_version = schemaVersion;
    changed = true;
  }
  if (!agentKinds.includes(normalized.initiator)) {
    normalized.initiator = live?.self.agent ?? null;
    changed = true;
  }
  if (!roles.includes(normalized.role)) {
    normalized.role = "peer";
    changed = true;
  }
  if (normalized.active === undefined) {
    normalized.active = true;
    changed = true;
  }
  if (!Number.isInteger(normalized.completed_cycles)) {
    normalized.completed_cycles = 0;
    changed = true;
  }
  if (!normalized.delivery) {
    normalized.delivery = emptyDelivery();
    changed = true;
  } else {
    for (const field of ["next", "submitted", "received"]) {
      if (!normalized.delivery[field]) {
        normalized.delivery[field] = byKind(0);
        changed = true;
      }
      for (const agent of agentKinds) {
        if (
          !Number.isInteger(normalized.delivery[field][agent]) ||
          normalized.delivery[field][agent] < 0
        ) {
          normalized.delivery[field][agent] = 0;
          changed = true;
        }
      }
    }
    if (!normalized.delivery.pending) {
      normalized.delivery.pending = byKind(null);
      changed = true;
    }
    for (const agent of agentKinds) {
      const pending = normalized.delivery.pending[agent];
      if (
        pending !== null &&
        (!Number.isInteger(pending?.seq) || pending.seq < 1 || typeof pending.kind !== "string")
      ) {
        normalized.delivery.pending[agent] = null;
        changed = true;
      }
    }
    for (const agent of agentKinds) {
      const pending = normalized.delivery.pending[agent];
      const pendingSequence = pending?.seq ?? 0;
      const next = Math.max(
        normalized.delivery.next[agent],
        normalized.delivery.submitted[agent],
        normalized.delivery.received[agent],
        pendingSequence,
      );
      if (normalized.delivery.next[agent] !== next) {
        normalized.delivery.next[agent] = next;
        changed = true;
      }
      const submitted = Math.max(
        normalized.delivery.submitted[agent],
        normalized.delivery.received[agent],
        pending?.submitted_at ? pendingSequence : 0,
      );
      if (normalized.delivery.submitted[agent] !== submitted) {
        normalized.delivery.submitted[agent] = submitted;
        changed = true;
      }
    }
  }

  return { session: normalized, changed };
}

// A ship-it review or simplify run is detected by Herdr as a third agent in
// this tab, which would make the pair look ambiguous and silence its channel
// for the whole gate. Such a pane declares itself with a `role=process-pane`
// token — but a token is written by whoever asks, so a stale or forged one
// must never be able to hide a real agent from the exact-two invariant. The
// declaration only says where to look; the authority is the pane's own live
// foreground process being the gate helper that owns those panes. Never
// exclude the caller.
function isGateProcessPane(pane, selfPaneId) {
  if (pane.pane_id === selfPaneId) return false;
  if (pane.tokens?.role !== "process-pane") return false;
  let info;
  try {
    info = processInfo(pane.pane_id);
  } catch {
    return false;
  }
  return info.foreground_processes.some((entry) => {
    const argv = Array.isArray(entry.argv) ? entry.argv.filter((part) => typeof part === "string") : [];
    // Match argv ELEMENTS, never a substring of a command line: an agent whose
    // prompt happens to name the wrapper (this very conversation does, dozens
    // of times) carries it inside one argument and can never satisfy this.
    const runsWrapper =
      [entry.name, entry.argv0, argv[0]]
        .filter((value) => typeof value === "string")
        .some((value) => basename(value).toLowerCase() === "node") &&
      argv.some((part) => basename(part) === "herdr-visible-run.mjs") &&
      argv.includes("exec");
    if (!runsWrapper) return false;
    // And it must be the wrapper for THIS pane, not some other pane's run.
    const paneFlag = argv.indexOf("--pane");
    return paneFlag !== -1 && argv[paneFlag + 1] === pane.pane_id;
  });
}

// Every other agent pane in the caller's tab. Any of them can become a
// partner: a tab holds as many pairs as the lead starts, one session each.
function tabAgentPanes(self) {
  const tabAgents = paneList(self.workspace_id).filter(
    (pane) =>
      pane.tab_id === self.tab_id &&
      pane.workspace_id === self.workspace_id &&
      agentKinds.includes(pane.agent) &&
      !isGateProcessPane(pane, self.pane_id),
  );
  if (tabAgents.filter((pane) => pane.pane_id === self.pane_id).length !== 1) {
    fail(`current pane ${self.pane_id} is not uniquely present in current tab ${self.tab_id}`);
  }
  return tabAgents.filter((pane) => pane.pane_id !== self.pane_id);
}

// A partner's kind is read off its own pane rather than derived from the
// caller's, which is what makes any of the four kinds pairable — and a pane of
// the caller's own kind is refused rather than accepted: two panes of one CLI
// echo each other instead of reviewing each other.
function requireLivePartner(self, partner) {
  if (partner.agent === self.agent) {
    fail(
      `refusing to pair ${self.agent} with itself: pane ${partner.pane_id} runs the same CLI — the partner must be one of ${agentKinds.filter((kind) => kind !== self.agent).join(", ")}`,
    );
  }
  requireForegroundProcess(partner.pane_id, partner.agent, callerContext.repoRoot);
  return partner;
}

function describePanes(panes) {
  return panes.map((pane) => `${pane.pane_id} (${pane.agent})`).join(", ") || "none";
}

// The pane a NEW pair forms with: an agent pane of this tab that no active
// session already holds. Ambiguity is never guessed away — it is named.
function choosePartnerPane(self, entries, requestedPane) {
  const paired = pairedPaneIds(entries);
  const candidates = tabAgentPanes(self).filter((pane) => !paired.has(pane.pane_id));
  if (requestedPane) {
    const chosen = candidates.find((pane) => pane.pane_id === requestedPane);
    if (!chosen) {
      fail(
        `--partner-pane ${requestedPane} is not an unpaired agent pane in current tab ${self.tab_id}; candidates: ${describePanes(candidates)}`,
      );
    }
    return requireLivePartner(self, chosen);
  }
  if (candidates.length === 0) {
    fail(
      `current tab ${self.tab_id} holds no unpaired agent pane to pair with; spawn one with: node ${shellQuote(scriptPath)} spawn ${pinnedCliText(self, callerContext.repoRoot)} --partner ${kindList}`,
    );
  }
  if (candidates.length > 1) {
    fail(
      `current tab ${self.tab_id} holds ${candidates.length} unpaired agent panes; name one with --partner-pane — ${describePanes(candidates)}`,
    );
  }
  return requireLivePartner(self, candidates[0]);
}

// `discover` is informational: it reports who the caller is, which panes it
// could still pair with, and which pairs this tab already runs. It keeps
// failing on caller-identity problems, which is what makes it the first probe.
function discover() {
  const self = currentPane();
  const entries = readSessionEntries(self);
  const paired = pairedPaneIds(entries);
  return {
    self,
    candidates: tabAgentPanes(self).map((pane) => ({
      pane_id: pane.pane_id,
      agent: pane.agent,
      paired: paired.has(pane.pane_id),
    })),
    sessions: entries
      .filter((entry) => entry.session)
      .map((entry) => {
        const kind = partnerKindOf(entry.session, self.agent);
        return {
          sid: entry.session.sid ?? null,
          active: entry.session.active !== false,
          partner_agent: kind,
          partner_pane: (kind && entry.session.participants[kind]?.pane_id) ?? null,
          path: entry.path,
        };
      }),
  };
}

// herdr accepts an agent name of 1-32 characters, starting with a lowercase
// letter and holding only lowercase letters, digits, '-' and '_'. Pane ids
// break both halves of that: workspace ids carry uppercase (wY:p1), and a
// 16-character workspace id leaves no room once the prefix is added. A name
// that violates either rule fails the spawn outright, so derive it here and
// keep it deterministic. It is derived from the NEW pane, not the tab: one tab
// can hold several spawned partners, and herdr rejects a duplicate name.
function pairAgentName(partnerAgent, paneId) {
  const slug = paneId.toLowerCase().replaceAll(/[^a-z0-9_-]/gu, "_");
  const name = `pair-${partnerAgent}-${slug}`;
  if (name.length <= 32) return name;
  const digest = createHash("sha256").update(paneId).digest("hex").slice(0, 8);
  return `pair-${partnerAgent}-${digest}`.slice(0, 32);
}

// The partner CLI's own arguments, after `--`. They reach a pane that is being
// created and nothing else: a live pane already runs the model it was started
// with, and restarting it to change that would discard its conversation.
// Interactive-CLI autonomy flags, verified against each CLI's own --help. The
// pair's default keeps every CLI on its normal permission prompts; a spawn
// that must run unattended opts in with --autonomy full.
const autonomyArguments = {
  // `acceptEdits` still prompts for shell actions. A pane partner must be
  // unattended for the transport to keep working, so full means Claude's
  // explicit bypass mode and Grok's explicit auto-approval switch.
  claude: ["--permission-mode", "bypassPermissions"],
  grok: ["--always-approve"],
  // The Herdr pane itself must be able to call the Herdr socket without a
  // human approval path. `workspace-write` denies that socket and `-a never`
  // otherwise has nowhere to ask, so the visible pane is the mitigation for
  // this deliberately broad pane-only permission.
  codex: ["-a", "never", "-s", "danger-full-access"],
  cursor: ["--force"],
};

function agentStartArguments(partnerAgent, options) {
  const model = options.model ?? null;
  const effort = options.effort ?? null;
  const autonomy = options.autonomy ?? null;
  if (autonomy && autonomy !== "full") {
    fail("--autonomy accepts only: full (omit it for the CLI's normal prompts)");
  }
  const autonomyArgs = autonomy === "full" ? autonomyArguments[partnerAgent] : [];
  if (partnerAgent === "cursor") {
    if (effort && !model) {
      fail("cursor carries effort inside the model name, so --effort needs --model");
    }
    const named = effort && !/\[/u.test(model) ? `${model}[effort=${effort}]` : model;
    return [...autonomyArgs, ...(named ? ["--model", named] : [])];
  }
  if (partnerAgent === "claude") {
    return [
      ...autonomyArgs,
      ...(effort ? ["--effort", effort] : []),
      ...(model ? ["--model", model] : []),
    ];
  }
  if (partnerAgent === "codex") {
    return [
      ...autonomyArgs,
      ...(model ? ["-m", model] : []),
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
    ];
  }
  return [
    ...autonomyArgs,
    ...(model ? ["-m", model] : []),
    ...(effort ? ["--reasoning-effort", effort] : []),
  ];
}

function agentStartFailure(error, paneId) {
  let tail = "";
  try {
    tail = readPartner(paneId, "recent-unwrapped", "40").trimEnd();
  } catch {
    // Keep the original Herdr error when the pane itself cannot be read.
  }
  if (!tail) return error;
  return new CliError(
    `${error.message}\nagent start pane ${paneId} tail:\n${tail}`,
  );
}

async function spawn(args) {
  const options = parseOptions(args);
  const requestedPartner = options.partner ?? null;
  if (requestedPartner && !agentKinds.includes(requestedPartner)) {
    fail(`unknown partner ${requestedPartner} — use one of ${kindList}`);
  }
  const self = currentPane();
  // A tab may hold several pairs, so spawn never refuses on tab shape. It only
  // reuses a pane the caller names explicitly and that already runs the
  // requested CLI — that is what makes a retried spawn idempotent.
  const requestedPane = options["partner-pane"] ?? null;
  if (requestedPane) {
    const existing = tabAgentPanes(self).find((pane) => pane.pane_id === requestedPane);
    if (existing && (!requestedPartner || existing.agent === requestedPartner)) {
      const live = processInfo(existing.pane_id);
      if (matchingForegroundProcess(live, existing.agent, callerContext.repoRoot)) {
        process.stdout.write(
          `${JSON.stringify({ self, partner: existing, partnerAgent: existing.agent }, null, 2)}\n`,
        );
        return;
      }
    }
  }
  const binding = { self, partnerAgent: requestedPartner };
  if (!binding.partnerAgent) {
    fail(`spawn requires --partner ${kindList} (any CLI other than ${binding.self.agent})`);
  }
  if (binding.partnerAgent === binding.self.agent) {
    fail(
      `refusing to pair ${binding.self.agent} with itself — choose one of ${agentKinds.filter((kind) => kind !== binding.self.agent).join(", ")}`,
    );
  }
  const agentArguments = agentStartArguments(binding.partnerAgent, options);

  const split = result(
    "pane",
    "split",
    binding.self.pane_id,
    "--direction",
    "right",
    "--cwd",
    callerContext.repoRoot,
    "--no-focus",
  ).pane;
  const name = pairAgentName(binding.partnerAgent, split.pane_id);
  let pane;
  try {
    // A fresh split can report agent_pane_busy while its shell is still
    // starting up — that is a readiness race, not a real occupant, so retry
    // it briefly instead of failing the spawn outright.
    const busyDeadline = Date.now() + 15000;
    for (;;) {
      try {
        herdr(
          "agent",
          "start",
          name,
          "--kind",
          binding.partnerAgent,
          "--pane",
          split.pane_id,
          "--timeout",
          "60000",
          ...(agentArguments.length > 0 ? ["--", ...agentArguments] : []),
        );
        break;
      } catch (error) {
        if (!error.message.includes("agent_pane_busy") || Date.now() >= busyDeadline) {
          throw agentStartFailure(error, split.pane_id);
        }
        await sleep(500);
      }
    }

    pane = paneGet(split.pane_id);
    if (
      pane.workspace_id !== binding.self.workspace_id ||
      pane.tab_id !== binding.self.tab_id ||
      pane.agent !== binding.partnerAgent
    ) {
      const recent = readPartner(split.pane_id, "recent-unwrapped", "40");
      fail(`spawned pane did not come up as ${binding.partnerAgent} in the current tab:\n${recent}`);
    }
  } catch (error) {
    // Never leave the split pane orphaned: a failed spawn cleans up after
    // itself so a retry starts from the same tab shape it found.
    try {
      herdr("pane", "close", split.pane_id);
    } catch {}
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({ self: binding.self, partner: pane, partnerAgent: binding.partnerAgent }, null, 2)}\n`,
  );
}

function processIsGone(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function processStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    }).trim() || null;
  } catch {
    return null;
  }
}

function requireTrash() {
  try {
    const executable = execFileSync("/bin/sh", ["-c", "command -v trash"], {
      encoding: "utf8",
    }).trim();
    if (!executable) throw new Error("not found");
    return executable;
  } catch {
    fail("herdr-pair end requires trash on PATH before it can deactivate the session");
  }
}

function recordIsAbandoned(record) {
  if (processIsGone(record?.pid)) return true;
  if (
    typeof record?.process_start === "string" &&
    record.process_start_format === processStartFormat
  ) {
    const current = processStartIdentity(record.pid);
    return current !== null && current !== record.process_start;
  }
  return false;
}

function readLockOwner(lock) {
  try {
    return JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function lockIsAbandoned(lock, owner) {
  if (owner) return recordIsAbandoned(owner);
  try {
    return Date.now() - statSync(lock).mtimeMs >= staleLockMs;
  } catch {
    return true;
  }
}

function releaseReclaimClaim(lock, claim) {
  const claimPath = join(lock, "reclaim.json");
  try {
    const current = JSON.parse(readFileSync(claimPath, "utf8"));
    if (current.token === claim.token) unlinkSync(claimPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function reclaimLock(lock, observedOwner, label) {
  const claimPath = join(lock, "reclaim.json");
  const claim = {
    pid: process.pid,
    token: randomUUID(),
    owner_token: observedOwner?.token ?? null,
    process_start: processStartIdentity(process.pid),
    process_start_format: processStartFormat,
    created_at: new Date().toISOString(),
  };

  try {
    writeFileSync(claimPath, `${JSON.stringify(claim)}\n`, { flag: "wx" });
  } catch (error) {
    if (error.code === "ENOENT") return false;
    if (error.code !== "EEXIST") {
      fail(`cannot claim abandoned ${label} lock: ${error.message}`);
    }
    try {
      const existing = JSON.parse(readFileSync(claimPath, "utf8"));
      if (recordIsAbandoned(existing)) {
        const current = JSON.parse(readFileSync(claimPath, "utf8"));
        if (current.token === existing.token) unlinkSync(claimPath);
      }
    } catch {}
    return false;
  }

  try {
    const currentOwner = readLockOwner(lock);
    if ((currentOwner?.token ?? null) !== (observedOwner?.token ?? null)) return false;
    execFileSync("trash", [lock]);
    return true;
  } catch (error) {
    if (!existsSync(lock)) return true;
    fail(`cannot reclaim abandoned ${label} lock: ${error.message}`);
  } finally {
    if (existsSync(lock)) releaseReclaimClaim(lock, claim);
  }
}

function releaseLock(lock, owner) {
  const ownerPath = join(lock, "owner.json");
  try {
    const current = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (current.token !== owner.token) return;
    unlinkSync(ownerPath);
    rmdirSync(lock);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function acquireLock(lock, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      mkdirSync(lock);
    } catch (error) {
      if (error.code !== "EEXIST") {
        fail(`cannot acquire ${label} lock: ${error.message}`);
      }
      if (process.env.HERDR_PAIR_TEST_LOCK_WAIT_MARKER) {
        writeFileSync(process.env.HERDR_PAIR_TEST_LOCK_WAIT_MARKER, `${lock}\n`);
      }
      const observedOwner = readLockOwner(lock);
      if (lockIsAbandoned(lock, observedOwner)) {
        if (reclaimLock(lock, observedOwner, label)) continue;
      }
      if (Date.now() >= deadline) fail(`cannot acquire ${label} lock: already owned`);
      await sleep(25);
      continue;
    }

    const owner = {
      pid: process.pid,
      token: randomUUID(),
      process_start: processStartIdentity(process.pid),
      process_start_format: processStartFormat,
      created_at: new Date().toISOString(),
    };
    try {
      writeFileSync(join(lock, "owner.json"), `${JSON.stringify(owner)}\n`, { flag: "wx" });
      return owner;
    } catch (error) {
      try {
        execFileSync("trash", [lock]);
      } catch {}
      fail(`cannot record ${label} lock owner: ${error.message}`);
    }
  }
}

async function initSession(args) {
  const options = parseOptions(args);
  const role = options.role ?? "peer";
  if (!roles.includes(role)) fail(`unknown role ${role} — use ${roles.join(" or ")}`);
  // Resolve the caller's own pane first. Partner discovery runs on the create
  // path alone: an established session resolves through its own recorded
  // panes, so `init` keeps resuming after other agents join the tab — the very
  // case verify/send/end already tolerate.
  const self = currentPane();
  const requestedPane = options["partner-pane"] ?? null;
  const directory = tabDirectory(self);
  mkdirSync(dirname(directory), { recursive: true });
  const lock = `${directory}.init.lock`;
  const lockOwner = await acquireLock(lock, 5000, "session init");
  try {
    const entries = readSessionEntries(self);
    // Which existing pair, if any, this init means. A tab that already holds
    // sessions resumes rather than silently forming another: adding a pair is
    // an explicit act, named by --partner-pane.
    let resumePath = null;
    if (options.sid) {
      resumePath = resolveSessionPath(self, options.sid);
    } else if (requestedPane) {
      resumePath =
        entries.find(
          (entry) =>
            entry.session?.active !== false &&
            Object.values(entry.session?.participants ?? {}).some(
              (record) => record?.pane_id === requestedPane,
            ),
        )?.path ?? null;
    } else if (entries.length > 0) {
      resumePath = resolveSessionPath(self);
    }

    if (resumePath) {
      let resumed;
      try {
        resumed = await verifiedSessionAt(self, resumePath);
      } catch (error) {
        let sid = "<sid>";
        try {
          sid = JSON.parse(readFileSync(resumePath, "utf8")).sid ?? sid;
        } catch {}
        fail(
          `cannot resume existing current-tab session: ${error.message}. That session cannot be recovered — with explicit user approval, DISCARD it with: node ${shellQuote(scriptPath)} end ${pinnedCliText(self, callerContext.repoRoot)} --sid ${shellQuote(sid)} --stale true, then init a fresh pair`,
        );
      }
      await reconcileAcknowledged(resumed.path, resumed.session.sid);
      resumed.session = JSON.parse(readFileSync(resumed.path, "utf8"));
      process.stdout.write(
        `${JSON.stringify({ ...resumed.session, resumed: true }, null, 2)}\n`,
      );
      return;
    }

    const binding = { self, partner: choosePartnerPane(self, entries, requestedPane) };
    const path = sessionPathFor(self, binding.partner.pane_id);
    const session = {
      schema_version: schemaVersion,
      sid: `${Math.floor(Date.now() / 1000)}-${execFileSync("openssl", ["rand", "-hex", "2"], { encoding: "utf8" }).trim()}`,
      workspace_id: binding.self.workspace_id,
      tab_id: binding.self.tab_id,
      initiator: binding.self.agent,
      role,
      active: true,
      participants: {
        [binding.self.agent]: participantRecord(binding.self),
        [binding.partner.agent]: participantRecord(binding.partner),
      },
      round: 0,
      last_status: byKind(null),
      completed_cycles: 0,
      no_progress_count: 0,
      delivery: emptyDelivery(),
      workbench: { tab_id: null, server_pane: null, logs_pane: null },
      created_at: new Date().toISOString(),
    };

    mkdirSync(directory, { recursive: true });
    atomicWrite(path, session);
    process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
  } finally {
    releaseLock(lock, lockOwner);
  }
}

function validateSessionEnvelope(session, live) {
  if (
    session.workspace_id !== live.self.workspace_id ||
    session.tab_id !== live.self.tab_id
  ) {
    fail("session does not belong to the caller's exact workspace and tab");
  }
  if (
    Number.isInteger(session.schema_version) &&
    session.schema_version > schemaVersion
  ) {
    fail(`session schema ${session.schema_version} is newer than supported schema ${schemaVersion}`);
  }
  // A pre-universal session records two fixed kinds and, in the oldest shape,
  // no participants at all. It is not rewritten: end that pair first, then
  // start a new one with the partner you want.
  if (!Number.isInteger(session.schema_version) || session.schema_version < schemaVersion) {
    fail(
      `session schema ${session.schema_version ?? "unset"} predates the universal pair (schema ${schemaVersion}) — end that pair with: node ${shellQuote(scriptPath)} end ${pinnedCliText(live.self, callerContext.repoRoot)} --sid ${shellQuote(session.sid ?? "<sid>")} --stale true, then init a new one`,
    );
  }
}

// An established session is resolved through its own recorded participants,
// not through tab-wide discovery: the tab may legitimately hold other agent
// panes (reviews, extra workers, the caller's OTHER pairs) and none of them
// may hijack or silence this one. Every check below is per session.
async function verifiedSession(sid = null) {
  const self = currentPane();
  return verifiedSessionAt(self, resolveSessionPath(self, sid));
}

async function verifiedSessionAt(self, path) {
  let session;
  try {
    session = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot load current-tab session ${path}: ${error.message}`);
  }

  validateSessionEnvelope(session, { self });

  const partnerAgent = Object.keys(session.participants ?? {}).find(
    (kind) => kind !== self.agent && agentKinds.includes(kind),
  );
  const selfRecord = session.participants?.[self.agent];
  const partnerRecord = partnerAgent ? session.participants[partnerAgent] : null;
  if (!partnerRecord?.pane_id || !participantMatches(selfRecord, self)) {
    fail("live panes do not match the participants recorded for this tab");
  }
  let partnerPane;
  try {
    partnerPane = paneGet(partnerRecord.pane_id);
  } catch (error) {
    fail(`recorded partner pane ${partnerRecord.pane_id} is gone: ${error.message}`);
  }
  if (
    partnerPane.workspace_id !== self.workspace_id ||
    partnerPane.tab_id !== self.tab_id ||
    partnerPane.agent !== partnerAgent ||
    partnerPane.pane_id === self.pane_id ||
    !participantMatches(partnerRecord, partnerPane)
  ) {
    fail("recorded partner is no longer the partner agent in the caller's current tab");
  }
  requireForegroundProcess(partnerPane.pane_id, partnerAgent, callerContext.repoRoot);
  const live = { self, partner: partnerPane, partnerAgent };

  const normalized = normalizeSession(session, live);
  if (normalized.changed) {
    await withSessionLock(path, (latest) => {
      validateSessionEnvelope(latest, live);
      const migrated = normalizeSession(latest, live);
      if (migrated.changed) {
        for (const key of Object.keys(latest)) delete latest[key];
        Object.assign(latest, migrated.session);
      }
    });
    session = JSON.parse(readFileSync(path, "utf8"));
  } else {
    session = normalized.session;
  }

  if (
    session.workspace_id !== live.self.workspace_id ||
    session.tab_id !== live.self.tab_id ||
    !session.participants ||
    session.active !== true
  ) {
    fail("session does not belong to the caller's exact workspace and tab");
  }

  // Re-check against the normalized session: normalization may have filled in
  // terminal or session ids, and the pane may have changed under the lock.
  const normalizedSelf = session.participants[live.self.agent];
  const normalizedPartner = session.participants[live.partner.agent];
  if (
    !participantMatches(normalizedSelf, live.self) ||
    !participantMatches(normalizedPartner, live.partner)
  ) {
    fail("live panes do not match the participants recorded for this tab");
  }

  const partner = paneGet(normalizedPartner.pane_id);
  if (
    partner.workspace_id !== live.self.workspace_id ||
    partner.tab_id !== live.self.tab_id ||
    partner.agent !== live.partner.agent ||
    !participantMatches(normalizedPartner, partner)
  ) {
    fail("recorded partner is no longer the partner agent in the caller's current tab");
  }

  return { ...live, partner, path, session };
}

async function withSessionLock(path, mutate) {
  const lock = `${path}.lock`;
  const lockOwner = await acquireLock(lock, 5000, "session update");

  try {
    const session = JSON.parse(readFileSync(path, "utf8"));
    const result = await mutate(session);
    atomicWrite(path, session);
    return result;
  } finally {
    releaseLock(lock, lockOwner);
  }
}

function requireLockedSession(session, sid, action) {
  if (session.active !== true || session.sid !== sid) {
    fail(`${action} requires active session ${sid}; locked session is ${session.sid ?? "unknown"}`);
  }
}

async function acknowledgeInbound(path, sid, from, sequence) {
  await withSessionLock(path, (session) => {
    if (session.active !== true || session.sid !== sid) {
      fail(`inbound sid ${sid} does not match the active locked session ${session.sid ?? "unknown"}`);
    }
    const maximum = session.delivery?.next?.[from] ?? 0;
    if (!Number.isInteger(sequence) || sequence < 1 || sequence > maximum) {
      fail(`inbound sequence ${sequence} is outside the reserved range for ${from} (1-${maximum})`);
    }
    session.delivery.received[from] = Math.max(
      session.delivery.received[from] ?? 0,
      sequence,
    );
  });
}

// A cycle completes when both of THIS pair's participants have accepted, so
// the check reads the participants the session records rather than a fixed
// pair of kinds — the other two kinds are absent, not pending.
function bothAccepted(session) {
  const participants = Object.keys(session.participants ?? {});
  return (
    participants.length === 2 &&
    participants.every((agent) => session.last_status[agent] === "accepted")
  );
}

function applyAcknowledgedStatus(session, agent, pending) {
  const wasComplete = bothAccepted(session);
  session.round += 1;
  session.last_status[agent] = pending.kind;
  const isComplete = bothAccepted(session);
  if (!wasComplete && isComplete) {
    session.completed_cycles += 1;
    session.last_completed_at = new Date().toISOString();
  }
}

function reconcileSessionState(session) {
  const reconciled = [];
  for (const agent of agentKinds) {
    const pending = session.delivery?.pending?.[agent];
    if (pending && (session.delivery.received[agent] ?? 0) >= pending.seq) {
      session.delivery.submitted[agent] = Math.max(
        session.delivery.submitted[agent] ?? 0,
        pending.seq,
      );
      applyAcknowledgedStatus(session, agent, pending);
      session.delivery.pending[agent] = null;
      reconciled.push({ agent, seq: pending.seq, kind: pending.kind });
    }
  }
  return reconciled;
}

async function reconcileAcknowledged(path, sid) {
  return withSessionLock(path, (session) => {
    requireLockedSession(session, sid, "reconcile");
    return reconcileSessionState(session);
  });
}

async function verifyInbound(args) {
  const options = parseOptions(args);
  const claimedSid = options.sid;
  const claimedFrom = options.from;
  if (!claimedSid || !claimedFrom) fail("receive requires --sid and --from");

  const binding = await verifiedSession(claimedSid);
  if (claimedSid !== binding.session.sid) {
    fail(`inbound sid ${claimedSid} does not match current-tab session ${binding.session.sid}`);
  }
  if (claimedFrom !== binding.partner.agent) {
    fail(`inbound sender ${claimedFrom} is not current-tab partner ${binding.partner.agent}`);
  }

  if (options.seq !== undefined) {
    await acknowledgeInbound(binding.path, claimedSid, claimedFrom, Number(options.seq));
    await reconcileAcknowledged(binding.path, claimedSid);
    binding.session = JSON.parse(readFileSync(binding.path, "utf8"));
  }

  process.stdout.write(
    `${JSON.stringify({ self: binding.self, partner: binding.partner, session: binding.session }, null, 2)}\n`,
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

function readPartner(paneId, source, lines = "80") {
  return herdr("pane", "read", paneId, "--source", source, "--lines", lines, "--format", "text");
}

async function waitUntilNotWorking(paneId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = paneGet(paneId);
    if (pane.agent_status !== "working") return pane;
    await sleep(250);
  }
  // A grace period, not a gate: the caller delivers anyway. Blocking until
  // idle used to drop messages to a partner that never idled (a STOP lost on
  // 2026-07-29 while its recipient held "working" for 1h18m).
  return null;
}

const composerConfirmMs = 3000;
const composerPollMs = 200;
const deliveryReceipts = Object.freeze({
  acknowledged: "receipt=acknowledged",
  pending: "receipt=pending-partner-may-be-busy-do-not-retry",
  unproven: "receipt=unproven-working-inspect-that-pane-then-reconcile",
  lost: "receipt=lost-partner-idle-inspect-that-pane-then-reconcile",
});

// `--source recent` returns an empty string on a live pane, so a composer
// check that omits the source reads "clear" no matter what is on screen.
function visibleTail(paneId) {
  return herdr("pane", "read", paneId, "--source", "visible", "--lines", "40", "--format", "text");
}

// The last prompt line on screen (`›` in Codex, `>` in Claude Code), or null
// when the pane shows none.
function composerContent(paneId) {
  const lines = visibleTail(paneId).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (/^[›>]\s/.test(line)) return line.slice(2).trim();
  }
  return null;
}

// True while our text still sits unsubmitted.
function composerHolds(paneId, head) {
  const content = composerContent(paneId);
  return content !== null && content.startsWith(head);
}

// Absence is not delivery. A composer that never received the paste looks
// exactly like one that already submitted it, so proving only "the text is
// gone" reports a lost message as a delivered one — which is how a `ready`
// vanished on 2026-08-07: submitted in 443 ms, never in the partner's session.
// Arrival must be proved positively first, and both harnesses collapse a large
// multi-line paste into a summary line, so the pasted text itself is usually
// NOT what appears. What is reliable is that the composer stopped being what it
// was. A paste that submits itself before the first poll leaves the composer
// unchanged, so the idle partner turning to work counts as arrival too.
async function composerArrived(paneId, head, before) {
  const arrived = () => {
    const content = composerContent(paneId);
    if (content !== null && (content.startsWith(head) || content !== before)) return true;
    return paneGet(paneId).agent_status === "working";
  };
  for (let waited = 0; waited < composerConfirmMs; waited += composerPollMs) {
    if (arrived()) return true;
    await sleep(composerPollMs);
  }
  return arrived();
}

async function composerSettled(paneId, head) {
  for (let waited = 0; waited < composerConfirmMs; waited += composerPollMs) {
    if (!composerHolds(paneId, head)) return true;
    await sleep(composerPollMs);
  }
  return !composerHolds(paneId, head);
}

async function reserveSequence(path, sid, agent, kind) {
  return withSessionLock(path, (session) => {
    if (session.active !== true || session.sid !== sid) {
      fail("cannot reserve delivery for an inactive or replaced session");
    }
    const pending = session.delivery.pending?.[agent];
    if (pending) {
      fail(
        `previous ${agent} message seq ${pending.seq} is still awaiting receipt; run reconcile and do not send another message yet`,
      );
    }
    session.delivery.next[agent] += 1;
    const sequence = session.delivery.next[agent];
    session.delivery.pending[agent] = {
      seq: sequence,
      kind,
      reserved_at: new Date().toISOString(),
      submitted_at: null,
    };
    return sequence;
  });
}

async function promptReservedDelivery(path, sid, agent, sequence, paneId, message) {
  return withSessionLock(path, async (session) => {
    if (session.active !== true || session.sid !== sid) {
      fail("session ended or was replaced before submission; message not sent");
    }
    if (session.delivery.pending?.[agent]?.seq !== sequence) {
      fail(`delivery reservation ${agent} seq ${sequence} is no longer active; message not sent`);
    }
    // `agent prompt` returns before its Enter takes effect and does not always
    // deliver one, so the message can sit unsubmitted in the partner's
    // composer — and the ACK wait then reads that as a busy partner rather
    // than a stuck message. Land it through the same proved composer path:
    // paste, Enter until the composer no longer holds the text, one full
    // resend, then a loud failure instead of a silent stall. Prose rewrites of
    // the skill have shaved this off four times; it lives in code on purpose.
    const head = (message.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, 40);
    const before = composerContent(paneId);
    const wasWorking = paneGet(paneId).agent_status === "working";
    herdr("agent", "prompt", paneId, message);
    await sleep(pasteSettleMs);
    // A working target has no reliable visible arrival signal. Keep the
    // harmless Enter protection measured for multi-line Codex prompts, but do
    // not resend a body that Herdr may already have queued. Only the later
    // sequence ACK proves this path; without it the receipt stays unproven.
    if (wasWorking) {
      let settled = false;
      for (let attempt = 0; attempt < 3 && !settled; attempt += 1) {
        herdr("agent", "send-keys", paneId, "enter");
        settled = await composerSettled(paneId, head);
      }
      if (!settled) {
        fail(
          `message for ${paneId} seq ${sequence} never left the partner composer; the reservation stays pending — inspect that pane, then reconcile before sending again`,
        );
      }
      return "working-unproven";
    }

    let arrived = await composerArrived(paneId, head, before);
    if (!arrived) {
      herdr("agent", "prompt", paneId, message);
      await sleep(pasteSettleMs);
      arrived = await composerArrived(paneId, head, before);
    }
    if (!arrived) {
      fail(
        `message for ${paneId} seq ${sequence} never reached the partner composer; the reservation stays pending — inspect that pane, then reconcile before sending again`,
      );
    }
    let landed = false;
    for (let attempt = 0; attempt < 3 && !landed; attempt += 1) {
      herdr("agent", "send-keys", paneId, "enter");
      landed = await composerSettled(paneId, head);
    }
    if (!landed) {
      herdr("agent", "prompt", paneId, message);
      await sleep(pasteSettleMs);
      herdr("agent", "send-keys", paneId, "enter");
      landed = await composerSettled(paneId, head);
    }
    if (!landed) {
      fail(
        `message for ${paneId} seq ${sequence} never left the partner composer; the reservation stays pending — inspect that pane, then reconcile before sending again`,
      );
    }
    return "composer-proved";
  });
}

async function recordSubmission(path, sid, agent, kind, sequence) {
  await withSessionLock(path, (session) => {
    requireLockedSession(session, sid, "record submission");
    session.delivery.submitted[agent] = Math.max(
      session.delivery.submitted[agent] ?? 0,
      sequence,
    );
    const pending = session.delivery.pending[agent];
    if (pending?.seq === sequence && pending.kind === kind) {
      pending.submitted_at = new Date().toISOString();
    } else if ((session.delivery.received[agent] ?? 0) < sequence) {
      fail(`delivery reservation for ${agent} seq ${sequence} no longer matches submission`);
    }
  });
}

async function waitForReceipt(path, agent, sequence, partnerPaneId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = JSON.parse(readFileSync(path, "utf8"));
    if ((session.delivery?.received?.[agent] ?? 0) >= sequence) return true;
    // The receipt lands via the partner's receive; observing the pane too
    // ends the wait early when the partner is gone instead of timing out.
    try {
      paneGet(partnerPaneId);
    } catch {
      return false;
    }
    await sleep(50);
  }
  return false;
}

// The obligation the partner still owes, read from the session alone — or
// null when the pair owes nothing. Two shapes: an unacknowledged delivery
// from self (the partner never ran receive), and an open cycle (the partner
// never closed its half with an accepted status). The signature names the
// exact obligation so a watcher can cap nudges per obligation instead of
// hammering one forever.
function partnerObligation(session, selfAgent, partnerAgent) {
  const pending = session.delivery?.pending?.[selfAgent];
  if (pending?.submitted_at) {
    return {
      signature: `receive:${pending.seq}`,
      reminder: `message seq=${pending.seq} from ${selfAgent} awaits your receive — run the [herdr-pair control seq=${pending.seq}: ...] line from that message, then act on it`,
    };
  }
  if (session.round > 0 && session.last_status?.[partnerAgent] !== "accepted") {
    return {
      signature: `cycle:${session.round}:${session.last_status?.[partnerAgent] ?? "none"}`,
      reminder:
        "your half of the work cycle is still open — continue now, and close it by sending your status (ready, then accepted) through the pair helper",
    };
  }
  return null;
}

// Out-of-band delivery for a nudge: no sequence reservation — a nudge is a
// reminder about existing obligations, never new protocol traffic — but the
// same landing proof as an idle-partner send, because a nudge sitting unseen
// in the composer is worse than none.
async function deliverNudge(paneId, message) {
  const head = (message.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, 40);
  const before = composerContent(paneId);
  herdr("agent", "prompt", paneId, message);
  await sleep(pasteSettleMs);
  let arrived = await composerArrived(paneId, head, before);
  if (!arrived) {
    herdr("agent", "prompt", paneId, message);
    await sleep(pasteSettleMs);
    arrived = await composerArrived(paneId, head, before);
  }
  let landed = false;
  for (let attempt = 0; attempt < 3 && !landed; attempt += 1) {
    herdr("agent", "send-keys", paneId, "enter");
    landed = await composerSettled(paneId, head);
  }
  if (!landed) fail(`nudge for ${paneId} never left the partner composer`);
}

// One heartbeat tick: nudge only a provably idle partner that still owes the
// pair something. A working partner is left alone — mid-turn traffic is what
// the send path already handles.
async function nudgeOnce(binding) {
  const { session, partner, self } = binding;
  const obligation = partnerObligation(session, self.agent, partner.agent);
  if (!obligation) return { nudged: false, reason: "no open obligation" };
  const status = paneGet(partner.pane_id).agent_status;
  if (status === "working") return { nudged: false, reason: "partner working", obligation };
  await deliverNudge(
    partner.pane_id,
    `[herdr-pair control nudge sid=${session.sid}]: you are the ${partner.agent} half of an active pair; ${obligation.reminder}.`,
  );
  return { nudged: true, obligation };
}

async function nudgeSession(args) {
  const binding = await verifiedSession(parseOptions(args).sid ?? null);
  await reconcileAcknowledged(binding.path, binding.session.sid);
  binding.session = JSON.parse(readFileSync(binding.path, "utf8"));
  const outcome = await nudgeOnce(binding);
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
}

// The heartbeat for transient partner stalls: run it in a BACKGROUND
// terminal (guardrail 4 — never hold the pair pane in a foreground loop).
// Each tick re-verifies the session, and an obligation is only nudged once
// it has survived two consecutive ticks — a partner that just went idle gets
// one interval to close its half on its own. Ends with the session, or after
// --max-nudges per obligation.
async function watchSession(args) {
  const options = parseOptions(args);
  const intervalMs = Number(options["interval-ms"] ?? 60000);
  const maxNudges = Number(options["max-nudges"] ?? 3);
  if (!Number.isInteger(intervalMs) || intervalMs < 5000) {
    fail("--interval-ms must be an integer of at least 5000");
  }
  if (!Number.isInteger(maxNudges) || maxNudges < 1) {
    fail("--max-nudges must be a positive integer");
  }
  let previousSignature = null;
  const nudgesBySignature = new Map();
  for (;;) {
    let binding;
    try {
      binding = await verifiedSession(options.sid ?? null);
    } catch (error) {
      process.stdout.write(`watch: session over or unverifiable (${error.message}); stopping\n`);
      return;
    }
    await reconcileAcknowledged(binding.path, binding.session.sid);
    binding.session = JSON.parse(readFileSync(binding.path, "utf8"));
    const obligation = partnerObligation(
      binding.session,
      binding.self.agent,
      binding.partner.agent,
    );
    const signature = obligation?.signature ?? null;
    if (
      signature &&
      signature === previousSignature &&
      (nudgesBySignature.get(signature) ?? 0) < maxNudges
    ) {
      const outcome = await nudgeOnce(binding);
      if (outcome.nudged) {
        nudgesBySignature.set(signature, (nudgesBySignature.get(signature) ?? 0) + 1);
        process.stdout.write(
          `watch: nudged ${binding.partner.agent} (${signature}, ${nudgesBySignature.get(signature)}/${maxNudges})\n`,
        );
      }
    }
    previousSignature = signature;
    await sleep(intervalMs);
  }
}

async function resetSession(args) {
  const binding = await verifiedSession(parseOptions(args).sid ?? null);
  await reconcileAcknowledged(binding.path, binding.session.sid);
  await withSessionLock(binding.path, (session) => {
    requireLockedSession(session, binding.session.sid, "reset");
    const pending = Object.entries(session.delivery.pending).find(([, value]) => value);
    if (pending) {
      fail(`cannot reset while ${pending[0]} seq ${pending[1].seq} awaits receipt`);
    }
    session.round = 0;
    session.last_status = byKind(null);
    session.no_progress_count = 0;
    session.last_reset_at = new Date().toISOString();
  });
  process.stdout.write(
    `${JSON.stringify({ ...JSON.parse(readFileSync(binding.path, "utf8")), reset: true }, null, 2)}\n`,
  );
}

async function endSession(args) {
  const options = parseOptions(args);
  if (!options.sid) fail("end requires --sid and explicit user intent");
  const allowStale = options.stale === "true";
  if (options.stale !== undefined && !allowStale) {
    fail("--stale must be true when explicitly authorized");
  }
  const trash = requireTrash();
  // Ending resolves through the session's own recorded participants, like
  // verifiedSession, but tolerantly: a dead or replaced partner must not make
  // the session impossible to end — it becomes a participant mismatch that
  // --stale true can override.
  const self = currentPane();
  const path = resolveSessionPath(self, options.sid);
  let partner = null;
  {
    let recorded = null;
    try {
      recorded = JSON.parse(readFileSync(path, "utf8")).participants ?? null;
    } catch {}
    const partnerAgent = Object.keys(recorded ?? {}).find(
      (kind) => kind !== self.agent && agentKinds.includes(kind),
    );
    const record = partnerAgent ? recorded[partnerAgent] : null;
    if (record?.pane_id) {
      let pane = null;
      try {
        pane = paneGet(record.pane_id);
      } catch {
        pane = null;
      }
      if (
        pane &&
        pane.workspace_id === self.workspace_id &&
        pane.tab_id === self.tab_id &&
        pane.agent === partnerAgent &&
        participantMatches(record, pane)
      ) {
        // Infra failures reading the process MUST propagate even for stale
        // recovery — only a provably absent partner process is stale, an
        // unreadable one is unknown.
        const info = processInfo(pane.pane_id);
        if (matchingForegroundProcess(info, partnerAgent, callerContext.repoRoot)) {
          partner = pane;
        } else if (!allowStale) {
          fail(
            `pane ${pane.pane_id} has no live foreground ${partnerAgent} process rooted at ${callerContext.repoRoot}`,
          );
        }
      }
    }
  }
  const binding = { self, partner };
  const directory = tabDirectory(self);
  const workspaceDirectory = dirname(directory);
  if (!existsSync(path)) fail(`cannot load current-tab session ${path}: file does not exist`);
  const lock = `${path}.lock`;
  const lockOwner = await acquireLock(lock, 5000, "session termination");
  let session;
  try {
    session = JSON.parse(readFileSync(path, "utf8"));
    if (
      session.sid !== options.sid ||
      session.workspace_id !== binding.self.workspace_id ||
      session.tab_id !== binding.self.tab_id
    ) {
      fail("refusing to end a session that does not match the caller's exact sid, workspace, and tab");
    }

    const normalized = normalizeSession(session, binding).session;
    let participantMismatch = binding.partner === null;
    if (binding.partner) {
      for (const pane of [binding.self, binding.partner]) {
        if (!participantMatches(normalized.participants?.[pane.agent], pane)) {
          participantMismatch = true;
        }
      }
      if (Object.keys(normalized.participants ?? {}).length !== 2) {
        participantMismatch = true;
      }
    }
    if (!allowStale && participantMismatch) {
      fail("refusing to end a session whose recorded participants do not match this tab; explicit stale recovery requires --stale true");
    }

    const pending = Object.entries(session.delivery?.pending ?? {}).find(([, value]) => value);
    if (pending && !(allowStale && participantMismatch)) {
      fail(`cannot end while ${pending[0]} seq ${pending[1].seq} awaits receipt or explicit clear`);
    }
    session.active = false;
    atomicWrite(path, session);
    // Only this pair's own file goes: the tab's other pairs keep running.
    try {
      execFileSync(trash, [path]);
    } catch (error) {
      if (existsSync(path)) {
        session.active = true;
        atomicWrite(path, session);
        const detail = error.stderr?.toString().trim() || error.message;
        fail(`cannot trash herdr-pair session; restored active state: ${detail}`);
      }
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail(`cannot load current-tab session ${path}: ${error.message}`);
  } finally {
    releaseLock(lock, lockOwner);
  }

  for (const stale of [directory, workspaceDirectory]) {
    try {
      rmdirSync(stale);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
    }
  }
  process.stdout.write(`ended herdr-pair session ${session.sid} for tab ${binding.self.tab_id}\n`);
}

async function send(args) {
  const options = parseOptions(args);
  const kind = options.kind;
  const bodyFile = options["body-file"];
  const claimedSid = options.sid;
  if (!kind || !bodyFile || !claimedSid) {
    fail("send requires --sid, --kind, and --body-file");
  }

  let binding = await verifiedSession(claimedSid);
  if (binding.session.sid !== claimedSid) {
    fail(
      `send sid ${claimedSid} does not match current-tab session ${binding.session.sid}`,
    );
  }
  await reconcileAcknowledged(binding.path, binding.session.sid);
  const body = readFileSync(bodyFile, "utf8").trimEnd();

  // Prefer handing to an idle partner, but never trade delivery for
  // idleness: both harnesses queue a submitted prompt while working, and
  // promptReservedDelivery proves landing from the composer itself. The wait
  // is a short grace period; on timeout the message is delivered queued.
  binding = await verifiedSession(claimedSid);
  if (binding.session.sid !== claimedSid) {
    fail(
      `send sid ${claimedSid} no longer matches current-tab session ${binding.session.sid}`,
    );
  }
  if (binding.partner.agent_status === "working") {
    await waitUntilNotWorking(
      binding.partner.pane_id,
      Number(options["timeout-ms"] ?? 10000),
    );
    binding = await verifiedSession(claimedSid);
    if (binding.session.sid !== claimedSid) {
      fail(
        `send sid ${claimedSid} no longer matches current-tab session ${binding.session.sid}`,
      );
    }
  }
  const sequence = await reserveSequence(
    binding.path,
    binding.session.sid,
    binding.self.agent,
    kind,
  );
  const header = `[agent ${binding.self.agent} -> ${binding.partner.agent} kind=${kind} sid=${binding.session.sid}]`;
  const receiveCommand = `node ${shellQuote(scriptPath)} receive ${pinnedCliText(binding.partner, callerContext.repoRoot)} --sid ${shellQuote(binding.session.sid)} --from ${shellQuote(binding.self.agent)} --seq ${sequence}`;
  const control = `[herdr-pair control seq=${sequence}: run ${receiveCommand} before doing work. This is partner transport: reply only through this helper's send command, never as visible text in this pane. Keep the pair active until the user closes the tab or explicitly ends it.]`;
  const message = `${header}\n${control}\n\n${body}`;
  const deliveryProof = await promptReservedDelivery(
    binding.path,
    binding.session.sid,
    binding.self.agent,
    sequence,
    binding.partner.pane_id,
    message,
  );

  await recordSubmission(
    binding.path,
    binding.session.sid,
    binding.self.agent,
    kind,
    sequence,
  );
  const acknowledged = await waitForReceipt(
    binding.path,
    binding.self.agent,
    sequence,
    binding.partner.pane_id,
    Number(options["ack-timeout-ms"] ?? 15000),
  );
  if (acknowledged) await reconcileAcknowledged(binding.path, binding.session.sid);
  // "Busy, do not retry" is only true of a partner that is actually busy. One
  // sitting idle without an acknowledgement never got the message, and telling
  // the sender to wait hides that loss behind a wait that never ends.
  let receipt = deliveryReceipts.acknowledged;
  if (!acknowledged) {
    let status = null;
    try {
      status = paneGet(binding.partner.pane_id).agent_status;
    } catch {
      status = null;
    }
    if (deliveryProof === "working-unproven") {
      // The paste went to a working partner, but the receipt reports the
      // partner's status NOW: one that has since settled idle without acking
      // provably did not run receive, so "wait, it may be busy" would hide
      // the loss. Only a proven idle downgrades; unknown stays unproven.
      receipt = status === "idle" ? deliveryReceipts.lost : deliveryReceipts.unproven;
    } else {
      receipt =
        status === "working"
          ? deliveryReceipts.pending
          : deliveryReceipts.lost;
    }
  }
  process.stdout.write(`${header} seq=${sequence} ${receipt}\n`);
}

async function reconcileSession(args) {
  const options = parseOptions(args);
  const binding = await verifiedSession(options.sid ?? null);
  let reconciled;
  let cleared = null;
  if (options["clear-pending"] !== undefined) {
    if (options["clear-pending"] !== "true" || options.sid !== binding.session.sid) {
      fail("clearing pending delivery requires --clear-pending true and the exact --sid");
    }
    const resolution = await withSessionLock(binding.path, (session) => {
      requireLockedSession(session, binding.session.sid, "clear pending");
      const applied = reconcileSessionState(session);
      const agent = binding.self.agent;
      const pending = session.delivery.pending[agent];
      if (!pending) {
        if (applied.some((item) => item.agent === agent)) {
          return { reconciled: applied, cleared: null };
        }
        fail(`no unacknowledged ${agent} delivery is pending`);
      }
      const record = { ...pending, cleared_at: new Date().toISOString() };
      session.delivery.pending[agent] = null;
      session.delivery.last_cleared_pending ??= byKind(null);
      session.delivery.last_cleared_pending[agent] = record;
      return { reconciled: applied, cleared: { agent, ...record } };
    });
    reconciled = resolution.reconciled;
    cleared = resolution.cleared;
  } else {
    reconciled = await reconcileAcknowledged(binding.path, binding.session.sid);
  }
  const session = JSON.parse(readFileSync(binding.path, "utf8"));
  process.stdout.write(`${JSON.stringify({ reconciled, cleared, session }, null, 2)}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = parseOptions(args);
  callerContext = {
    paneId: options.pane ?? null,
    workspaceId: options.workspace ?? null,
    tabId: options["tab-id"] ?? null,
    agent: options.as ?? null,
    terminalId: options["terminal-id"] ?? null,
    repoRoot: options["repo-root"] ?? null,
  };

  if (command === "discover") {
    process.stdout.write(`${JSON.stringify(discover(), null, 2)}\n`);
  } else if (command === "spawn") {
    await spawn(args);
  } else if (command === "init") {
    await initSession(args);
  } else if (command === "verify") {
    const binding = await verifiedSession(options.sid ?? null);
    await reconcileAcknowledged(binding.path, binding.session.sid);
    binding.session = JSON.parse(readFileSync(binding.path, "utf8"));
    process.stdout.write(
      `${JSON.stringify({ self: binding.self, partner: binding.partner, session: binding.session }, null, 2)}\n`,
    );
  } else if (command === "receive") {
    await verifyInbound(args);
  } else if (command === "send") {
    await send(args);
  } else if (command === "nudge") {
    await nudgeSession(args);
  } else if (command === "watch") {
    await watchSession(args);
  } else if (command === "reset") {
    await resetSession(args);
  } else if (command === "reconcile") {
    await reconcileSession(args);
  } else if (command === "end") {
    await endSession(args);
  } else {
    fail(
      `usage: herdr-pair.mjs COMMAND --pane ID --workspace ID --tab-id ID --as ${kindList} --terminal-id ID --repo-root PATH [--sid ID] [--partner ${kindList}] [--partner-pane ID] [--model NAME] [--effort LEVEL] [--role peer|executor] [options]`,
    );
  }
}

try {
  await main();
} catch (error) {
  const detail = error instanceof CliError ? error.message : error.stack ?? error.message;
  process.stderr.write(`${detail}\n`);
  process.exitCode = 1;
}
