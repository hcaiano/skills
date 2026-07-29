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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scriptPath = fileURLToPath(import.meta.url);
const schemaVersion = 2;
const staleLockMs = 60000;
const pasteSettleMs = 400;
const processStartFormat = "ps-lstart-c-utc-v1";

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
  return result("pane", "get", paneId).pane;
}

function paneList(workspaceId) {
  return result("pane", "list", "--workspace", workspaceId).panes;
}

function currentPane() {
  const paneId = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== "1" || !paneId) {
    fail("herdr-pair requires HERDR_ENV=1 and HERDR_PANE_ID");
  }
  return paneGet(paneId);
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

function discover({ allowMissing = false } = {}) {
  const self = currentPane();
  const partnerAgent = opposite(self.agent);
  const tabAgents = paneList(self.workspace_id).filter(
    (pane) =>
      pane.tab_id === self.tab_id &&
      pane.workspace_id === self.workspace_id &&
      ["claude", "codex"].includes(pane.agent),
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

  return { self, partner: candidates[0], partnerAgent };
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
    binding.self.cwd,
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
          `cannot resume existing current-tab session: ${error.message}. With explicit user approval, recover it with: node ${JSON.stringify(scriptPath)} end --sid ${JSON.stringify(sid)} --stale true`,
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
        claude: {
          pane_id:
            binding.self.agent === "claude" ? binding.self.pane_id : binding.partner.pane_id,
        },
        codex: {
          pane_id: binding.self.agent === "codex" ? binding.self.pane_id : binding.partner.pane_id,
        },
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
    selfRecord?.pane_id !== live.self.pane_id ||
    partnerRecord?.pane_id !== live.partner.pane_id
  ) {
    fail("live panes do not match the participants recorded for this tab");
  }

  const partner = paneGet(partnerRecord.pane_id);
  if (
    partner.workspace_id !== live.self.workspace_id ||
    partner.tab_id !== live.self.tab_id ||
    partner.agent !== live.partner.agent
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
  fail(`partner ${paneId} stayed working for ${timeoutMs}ms; message not sent`);
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
  await withSessionLock(path, async (session) => {
    if (session.active !== true || session.sid !== sid) {
      fail("session ended or was replaced before submission; message not sent");
    }
    if (session.delivery.pending?.[agent]?.seq !== sequence) {
      fail(`delivery reservation ${agent} seq ${sequence} is no longer active; message not sent`);
    }
    herdr("agent", "prompt", paneId, message);
    // `agent prompt` returns before its Enter takes effect and does not always
    // deliver one, so the message can sit unsubmitted in the partner's
    // composer — and the ACK wait then reads that as a busy partner rather
    // than a stuck message. Send the Enter here until herdr closes the gap; on
    // an already-submitted composer it is a harmless no-op.
    await sleep(pasteSettleMs);
    herdr("agent", "send-keys", paneId, "enter");
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
  const binding = discover({ allowMissing: allowStale });
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
        const expected = agent === binding.self.agent ? binding.self.pane_id : binding.partner.pane_id;
        if (normalized.participants?.[agent]?.pane_id !== expected) {
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
  if (!kind || !bodyFile) fail("send requires --kind and --body-file");

  let binding = await verifiedSession();
  await reconcileAcknowledged(binding.path, binding.session.sid);
  const body = readFileSync(bodyFile, "utf8").trimEnd();

  // A working Claude cannot take a prompt mid-turn; Codex queues prompts
  // natively, so it may be prompted while working. Re-resolve after every
  // wait so the reservation binds to a current partner.
  while (true) {
    binding = await verifiedSession();
    if (
      binding.partner.agent_status !== "working" ||
      binding.partner.agent === "codex"
    ) {
      break;
    }
    await waitUntilNotWorking(binding.partner.pane_id, Number(options["timeout-ms"] ?? 60000));
  }
  const sequence = await reserveSequence(
    binding.path,
    binding.session.sid,
    binding.self.agent,
    kind,
  );
  const header = `[agent ${binding.self.agent} -> ${binding.partner.agent} kind=${kind} sid=${binding.session.sid}]`;
  const receiveCommand = `node ${JSON.stringify(scriptPath)} receive --sid ${JSON.stringify(binding.session.sid)} --from ${JSON.stringify(binding.self.agent)} --seq ${sequence}`;
  const control = `[herdr-pair control seq=${sequence}: run ${receiveCommand} before doing work. This is partner transport: reply only through this helper's send command, never as visible text in this pane. Keep the pair active until the user closes the tab or explicitly ends it.]`;
  const message = `${header}\n${control}\n\n${body}`;
  await promptReservedDelivery(
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
  process.stdout.write(
    `${header} seq=${sequence} receipt=${acknowledged ? "acknowledged" : "pending-partner-may-be-busy-do-not-retry"}\n`,
  );
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

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "discover") {
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
    fail("usage: herdr-pair.mjs discover | spawn | init | verify | reconcile [--sid SID --clear-pending true] | reset | end --sid SID [--stale true] | receive --sid SID --from AGENT [--seq N] | send --kind KIND --body-file FILE [--timeout-ms MS] [--ack-timeout-ms MS]");
  }
}

try {
  await main();
} catch (error) {
  const detail = error instanceof CliError ? error.message : error.stack ?? error.message;
  process.stderr.write(`${detail}\n`);
  process.exitCode = 1;
}
