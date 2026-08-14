#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scriptPath = fileURLToPath(import.meta.url);
const schemaVersion = 2;
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
  if (!["claude", "codex"].includes(callerContext.agent)) {
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

function participantMatches(record, pane) {
  return (
    record?.pane_id === pane.pane_id &&
    (!record.terminal_id || record.terminal_id === pane.terminal_id)
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

function opposite(agent) {
  if (agent === "claude") return "codex";
  if (agent === "codex") return "claude";
  fail(`unsupported current agent: ${agent ?? "unknown"}`);
}

function sessionPath(self) {
  const slug = self.tab_id.replaceAll(":", "_");
  return join(homedir(), ".herdr-coworkers", self.workspace_id, slug, "session.json");
}

function emptyDelivery() {
  return {
    next: { claude: 0, codex: 0 },
    submitted: { claude: 0, codex: 0 },
    received: { claude: 0, codex: 0 },
    pending: { claude: null, codex: null },
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

  if (!normalized.participants && normalized.self && normalized.partner) {
    normalized.participants = {
      [normalized.self.agent]: { pane_id: normalized.self.pane_id },
      [normalized.partner.agent]: { pane_id: normalized.partner.pane_id },
    };
    delete normalized.self;
    delete normalized.partner;
    changed = true;
  }
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
  if (normalized.initiator !== "claude" && normalized.initiator !== "codex") {
    normalized.initiator = live?.self.agent ?? null;
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
        normalized.delivery[field] = { claude: 0, codex: 0 };
        changed = true;
      }
      for (const agent of ["claude", "codex"]) {
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
      normalized.delivery.pending = { claude: null, codex: null };
      changed = true;
    }
    for (const agent of ["claude", "codex"]) {
      const pending = normalized.delivery.pending[agent];
      if (
        pending !== null &&
        (!Number.isInteger(pending?.seq) || pending.seq < 1 || typeof pending.kind !== "string")
      ) {
        normalized.delivery.pending[agent] = null;
        changed = true;
      }
    }
    for (const agent of ["claude", "codex"]) {
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

function discover({ allowMissing = false, allowStalePartner = false } = {}) {
  const self = currentPane();
  const partnerAgent = opposite(self.agent);
  const tabAgents = paneList(self.workspace_id).filter(
    (pane) =>
      pane.tab_id === self.tab_id &&
      pane.workspace_id === self.workspace_id &&
      ["claude", "codex"].includes(pane.agent) &&
      !isGateProcessPane(pane, self.pane_id),
  );
  const selfMatches = tabAgents.filter((pane) => pane.pane_id === self.pane_id);
  const candidates = tabAgents.filter(
    (pane) => pane.agent === partnerAgent && pane.pane_id !== self.pane_id,
  );

  if (selfMatches.length !== 1) {
    fail(`current pane ${self.pane_id} is not uniquely present in current tab ${self.tab_id}`);
  }
  if (candidates.length === 0 && allowMissing && tabAgents.length === 1) {
    return { self, partner: null, partnerAgent };
  }
  if (candidates.length !== 1 || tabAgents.length !== 2) {
    fail(
      `expected exactly two agent panes in current tab ${self.tab_id} (self + one ${partnerAgent}); found ${tabAgents.length} agents and ${candidates.length} partners`,
    );
  }

  const partner = candidates[0];
  const partnerProcess = processInfo(partner.pane_id);
  if (!matchingForegroundProcess(partnerProcess, partner.agent, callerContext.repoRoot)) {
    if (allowStalePartner) {
      return {
        self,
        partner: null,
        partnerAgent,
        stalePartner: partner,
      };
    }
    fail(
      `pane ${partner.pane_id} has no live foreground ${partner.agent} process rooted at ${callerContext.repoRoot}`,
    );
  }
  return { self, partner, partnerAgent };
}

// herdr accepts an agent name of 1-32 characters, starting with a lowercase
// letter and holding only lowercase letters, digits, '-' and '_'. Tab ids
// break both halves of that: workspace ids carry uppercase (wY:t1), and a
// 16-character workspace id leaves no room once the prefix is added. A name
// that violates either rule fails the spawn outright, so derive it here and
// keep it deterministic — the same tab must always produce the same name.
function pairAgentName(partnerAgent, tabId) {
  const slug = tabId.toLowerCase().replaceAll(/[^a-z0-9_-]/gu, "_");
  const name = `pair-${partnerAgent}-${slug}`;
  if (name.length <= 32) return name;
  const digest = createHash("sha256").update(tabId).digest("hex").slice(0, 8);
  return `pair-${partnerAgent}-${digest}`.slice(0, 32);
}

async function spawn() {
  const binding = discover({ allowMissing: true });
  if (binding.partner) {
    process.stdout.write(`${JSON.stringify(binding, null, 2)}\n`);
    return;
  }

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
  const name = pairAgentName(binding.partnerAgent, binding.self.tab_id);
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
  );

  const pane = paneGet(split.pane_id);
  if (
    pane.workspace_id !== binding.self.workspace_id ||
    pane.tab_id !== binding.self.tab_id ||
    pane.agent !== binding.partnerAgent
  ) {
    const recent = readPartner(split.pane_id, "recent-unwrapped", "40");
    fail(`spawned pane did not come up as ${binding.partnerAgent} in the current tab:\n${recent}`);
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

async function initSession() {
  const binding = discover();
  const path = sessionPath(binding.self);
  const directory = dirname(path);
  mkdirSync(dirname(directory), { recursive: true });
  const lock = `${directory}.init.lock`;
  const lockOwner = await acquireLock(lock, 5000, "session init");
  try {
    if (existsSync(path)) {
      let resumed;
      try {
        resumed = await verifiedSession();
      } catch (error) {
        let sid = "<sid>";
        try {
          sid = JSON.parse(readFileSync(path, "utf8")).sid ?? sid;
        } catch {}
        fail(
          `cannot resume existing current-tab session: ${error.message}. With explicit user approval, recover it with: node ${shellQuote(scriptPath)} end ${pinnedCliText(binding.self, callerContext.repoRoot)} --sid ${shellQuote(sid)} --stale true`,
        );
      }
      await reconcileAcknowledged(resumed.path, resumed.session.sid);
      resumed.session = JSON.parse(readFileSync(resumed.path, "utf8"));
      process.stdout.write(
        `${JSON.stringify({ ...resumed.session, resumed: true }, null, 2)}\n`,
      );
      return;
    }

    const session = {
      schema_version: schemaVersion,
      sid: `${Math.floor(Date.now() / 1000)}-${execFileSync("openssl", ["rand", "-hex", "2"], { encoding: "utf8" }).trim()}`,
      workspace_id: binding.self.workspace_id,
      tab_id: binding.self.tab_id,
      initiator: binding.self.agent,
      active: true,
      participants: {
        claude: participantRecord(
          binding.self.agent === "claude" ? binding.self : binding.partner,
        ),
        codex: participantRecord(
          binding.self.agent === "codex" ? binding.self : binding.partner,
        ),
      },
      round: 0,
      last_status: { claude: null, codex: null },
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
}

async function verifiedSession() {
  const live = discover();
  const path = sessionPath(live.self);
  let session;
  try {
    session = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot load current-tab session ${path}: ${error.message}`);
  }

  validateSessionEnvelope(session, live);

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

  const selfRecord = session.participants[live.self.agent];
  const partnerRecord = session.participants[live.partner.agent];
  if (
    !participantMatches(selfRecord, live.self) ||
    !participantMatches(partnerRecord, live.partner)
  ) {
    fail("live panes do not match the participants recorded for this tab");
  }

  const partner = paneGet(partnerRecord.pane_id);
  if (
    partner.workspace_id !== live.self.workspace_id ||
    partner.tab_id !== live.self.tab_id ||
    partner.agent !== live.partner.agent ||
    !participantMatches(partnerRecord, partner)
  ) {
    fail("recorded partner is no longer the opposite agent in the caller's current tab");
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

function applyAcknowledgedStatus(session, agent, pending) {
  const wasComplete =
    session.last_status.claude === "accepted" &&
    session.last_status.codex === "accepted";
  session.round += 1;
  session.last_status[agent] = pending.kind;
  const isComplete =
    session.last_status.claude === "accepted" &&
    session.last_status.codex === "accepted";
  if (!wasComplete && isComplete) {
    session.completed_cycles += 1;
    session.last_completed_at = new Date().toISOString();
  }
}

function reconcileSessionState(session) {
  const reconciled = [];
  for (const agent of ["claude", "codex"]) {
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

  const binding = await verifiedSession();
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
    // than a stuck message. Land it the way herdr-orchestrate's send.mjs does:
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

async function resetSession() {
  const binding = await verifiedSession();
  await reconcileAcknowledged(binding.path, binding.session.sid);
  await withSessionLock(binding.path, (session) => {
    requireLockedSession(session, binding.session.sid, "reset");
    const pending = Object.entries(session.delivery.pending).find(([, value]) => value);
    if (pending) {
      fail(`cannot reset while ${pending[0]} seq ${pending[1].seq} awaits receipt`);
    }
    session.round = 0;
    session.last_status = { claude: null, codex: null };
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
  const binding = discover({
    allowMissing: allowStale,
    allowStalePartner: allowStale,
  });
  const path = sessionPath(binding.self);
  const directory = dirname(path);
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
      for (const agent of ["claude", "codex"]) {
        const expected =
          agent === binding.self.agent ? binding.self : binding.partner;
        if (!participantMatches(normalized.participants?.[agent], expected)) {
          participantMismatch = true;
        }
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
    try {
      execFileSync(trash, [directory]);
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

  try {
    rmdirSync(workspaceDirectory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
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

  let binding = await verifiedSession();
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
  binding = await verifiedSession();
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
    binding = await verifiedSession();
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
      receipt = deliveryReceipts.unproven;
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
  const binding = await verifiedSession();
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
      session.delivery.last_cleared_pending ??= { claude: null, codex: null };
      session.delivery.last_cleared_pending[agent] = record;
      return { reconciled: applied, cleared: { agent, ...record } };
    });
    reconciled = resolution.reconciled;
    cleared = resolution.cleared;
  } else if (options.sid !== undefined) {
    fail("--sid is only valid with --clear-pending true");
  } else {
    reconciled = await reconcileAcknowledged(binding.path, binding.session.sid);
  }
  const session = JSON.parse(readFileSync(binding.path, "utf8"));
  process.stdout.write(`${JSON.stringify({ reconciled, cleared, session }, null, 2)}\n`);
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
      "id could not resolve the caller from its own process ancestry (it matched zero or several panes) and therefore requires --conversation-markers-file",
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
  if (process.env.HERDR_ENV !== "1") fail("id requires HERDR_ENV=1");
  const agent = options.as;
  if (!["claude", "codex"].includes(agent ?? "")) {
    fail("id requires --as claude|codex (the agent you are)");
  }
  const repoRoot = options["repo-root"];
  if (!repoRoot || !repoRoot.startsWith("/")) {
    fail("id requires an absolute --repo-root resolved with git -C <task-repository>");
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

  if (command === "id") {
    identify(options);
  } else if (command === "discover") {
    process.stdout.write(`${JSON.stringify(discover(), null, 2)}\n`);
  } else if (command === "spawn") {
    await spawn();
  } else if (command === "init") {
    await initSession();
  } else if (command === "verify") {
    const binding = await verifiedSession();
    await reconcileAcknowledged(binding.path, binding.session.sid);
    binding.session = JSON.parse(readFileSync(binding.path, "utf8"));
    process.stdout.write(
      `${JSON.stringify({ self: binding.self, partner: binding.partner, session: binding.session }, null, 2)}\n`,
    );
  } else if (command === "receive") {
    await verifyInbound(args);
  } else if (command === "send") {
    await send(args);
  } else if (command === "reset") {
    await resetSession();
  } else if (command === "reconcile") {
    await reconcileSession(args);
  } else if (command === "end") {
    await endSession(args);
  } else {
    fail(
      "usage: herdr-pair.mjs id --as claude|codex --repo-root PATH --conversation-markers-file FILE, or COMMAND --pane ID --workspace ID --tab-id ID --as claude|codex --terminal-id ID --repo-root PATH [options]",
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
