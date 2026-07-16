#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
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

async function spawn() {
  const binding = discover({ allowMissing: true });
  if (binding.partner) {
    process.stdout.write(`${JSON.stringify(binding, null, 2)}\n`);
    return;
  }

  const executable = execFileSync("sh", ["-lc", `command -v ${binding.partnerAgent}`], {
    encoding: "utf8",
  }).trim();
  if (!executable) fail(`no ${binding.partnerAgent} executable on PATH`);

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
  herdr("pane", "run", split.pane_id, executable);

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const pane = paneGet(split.pane_id);
    if (
      pane.workspace_id === binding.self.workspace_id &&
      pane.tab_id === binding.self.tab_id &&
      pane.agent === binding.partnerAgent &&
      ["idle", "done"].includes(pane.agent_status)
    ) {
      process.stdout.write(
        `${JSON.stringify({ self: binding.self, partner: pane, partnerAgent: binding.partnerAgent }, null, 2)}\n`,
      );
      return;
    }
    await sleep(250);
  }

  const recent = readPartner(split.pane_id, "recent-unwrapped", "40");
  fail(`spawned pane did not become an idle ${binding.partnerAgent} in the current tab:\n${recent}`);
}

function initSession() {
  const binding = discover();
  const path = sessionPath(binding.self);
  if (existsSync(path)) fail(`current-tab session already exists: ${path}`);

  const session = {
    sid: `${Math.floor(Date.now() / 1000)}-${execFileSync("openssl", ["rand", "-hex", "2"], { encoding: "utf8" }).trim()}`,
    workspace_id: binding.self.workspace_id,
    tab_id: binding.self.tab_id,
    initiator: binding.self.agent,
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
    no_progress_count: 0,
    workbench: { tab_id: null, server_pane: null, logs_pane: null },
    created_at: new Date().toISOString(),
  };

  const directory = dirname(path);
  mkdirSync(dirname(directory), { recursive: true });
  // The tab directory itself is the boot lock. Existing or half-written state
  // fail-closes instead of being overwritten by a concurrent initiator.
  try {
    mkdirSync(directory);
  } catch (error) {
    fail(`current-tab session directory already exists or cannot be created: ${error.message}`);
  }
  const temp = `${path}.tmp.${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(session, null, 2)}\n`, { flag: "wx" });
  renameSync(temp, path);
  process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
}

function verifiedSession() {
  const live = discover();
  const path = sessionPath(live.self);
  let session;
  try {
    session = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot load current-tab session ${path}: ${error.message}`);
  }

  if (
    session.workspace_id !== live.self.workspace_id ||
    session.tab_id !== live.self.tab_id ||
    !session.participants
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

function verifyInbound(args) {
  const options = parseOptions(args);
  const claimedSid = options.sid;
  const claimedFrom = options.from;
  if (!claimedSid || !claimedFrom) fail("receive requires --sid and --from");

  const binding = verifiedSession();
  if (claimedSid !== binding.session.sid) {
    fail(`inbound sid ${claimedSid} does not match current-tab session ${binding.session.sid}`);
  }
  if (claimedFrom !== binding.partner.agent) {
    fail(`inbound sender ${claimedFrom} is not current-tab partner ${binding.partner.agent}`);
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

function codexQueueVisible(paneId, header) {
  const visible = readPartner(paneId, "visible", "40");
  const normalized = visible.replace(/\s+/gu, " ");
  const normalizedHeader = header.replace(/\s+/gu, " ");
  // Measured on Codex 0.144.5: this marker appears only after Enter has
  // enqueued the message, not while text merely sits in the composer.
  return (
    normalized.includes("Messages to be submitted after next tool call") &&
    normalized.includes(normalizedHeader)
  );
}

function headerAtPrompt(paneId, header) {
  const visible = readPartner(paneId, "visible", "50");
  return visible
    .split("\n")
    .some((line) => /^\s*[›>❯]\s*/u.test(line) && line.includes(header));
}

async function verifySubmission(paneId, before, header, queuedToCodex) {
  const deadline = Date.now() + 15000;
  let sawAvailable = before.agent_status !== "working";
  while (Date.now() < deadline) {
    const pane = paneGet(paneId);
    if (queuedToCodex && codexQueueVisible(paneId, header)) return true;
    if (pane.agent_status !== "working") sawAvailable = true;
    if (sawAvailable && pane.agent_status === "working") return true;
    await sleep(25);
  }
  return false;
}

async function updateSession(path, agent, kind) {
  const lock = `${path}.lock`;
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) {
        fail(`cannot acquire session update lock: ${error.message}`);
      }
      await sleep(25);
    }
  }

  try {
    const session = JSON.parse(readFileSync(path, "utf8"));
    session.round += 1;
    session.last_status[agent] = kind;
    const temp = `${path}.tmp.${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(session, null, 2)}\n`);
    renameSync(temp, path);
  } finally {
    rmdirSync(lock);
  }
}

async function send(args) {
  const options = parseOptions(args);
  const kind = options.kind;
  const bodyFile = options["body-file"];
  if (!kind || !bodyFile) fail("send requires --kind and --body-file");

  let binding = verifiedSession();
  const body = readFileSync(bodyFile, "utf8").trimEnd();
  const header = `[agent ${binding.self.agent} -> ${binding.partner.agent} kind=${kind} sid=${binding.session.sid}]`;
  const message = `${header}\n\n${body}`;

  if (binding.partner.agent_status === "working" && binding.partner.agent !== "codex") {
    await waitUntilNotWorking(binding.partner.pane_id, Number(options["timeout-ms"] ?? 60000));
  }

  // Re-resolve immediately before the first write. Codex has a verified queue
  // indicator; Claude does not, so a busy Claude returns to the wait loop.
  while (true) {
    binding = verifiedSession();
    if (
      binding.partner.agent_status !== "working" ||
      binding.partner.agent === "codex"
    ) {
      break;
    }
    await waitUntilNotWorking(binding.partner.pane_id, Number(options["timeout-ms"] ?? 60000));
  }
  herdr("pane", "send-text", binding.partner.pane_id, message);
  await sleep(750);
  // Capture the delivery mode immediately before Enter. The partner may have
  // completed its previous turn after binding resolution but before submission.
  const before = paneGet(binding.partner.pane_id);
  if (
    before.workspace_id !== binding.self.workspace_id ||
    before.tab_id !== binding.self.tab_id ||
    before.agent !== binding.partner.agent
  ) {
    fail("partner binding changed after text entry; Enter not sent and session unchanged");
  }
  const queuedToCodex = before.agent === "codex" && before.agent_status === "working";
  herdr("pane", "send-keys", binding.partner.pane_id, "Enter");

  if (!(await verifySubmission(binding.partner.pane_id, before, header, queuedToCodex))) {
    // Retry only when the exact header is visibly still in the composer. An
    // ambiguous timeout must not risk a duplicate submission.
    if (headerAtPrompt(binding.partner.pane_id, header)) {
      herdr("pane", "send-keys", binding.partner.pane_id, "Enter");
      if (await verifySubmission(binding.partner.pane_id, before, header, queuedToCodex)) {
        await updateSession(binding.path, binding.self.agent, kind);
        process.stdout.write(`${header}\n`);
        return;
      }
    }
    fail("send failed: no positive evidence that Enter submitted the message; session unchanged");
  }

  await updateSession(binding.path, binding.self.agent, kind);
  process.stdout.write(`${header}\n`);
}

const [command, ...args] = process.argv.slice(2);

if (command === "discover") {
  process.stdout.write(`${JSON.stringify(discover(), null, 2)}\n`);
} else if (command === "spawn") {
  await spawn();
} else if (command === "init") {
  initSession();
} else if (command === "verify") {
  const binding = verifiedSession();
  process.stdout.write(
    `${JSON.stringify({ self: binding.self, partner: binding.partner, session: binding.session }, null, 2)}\n`,
  );
} else if (command === "receive") {
  verifyInbound(args);
} else if (command === "send") {
  await send(args);
} else {
  fail("usage: herdr-pair.mjs discover | spawn | init | verify | receive --sid SID --from AGENT | send --kind KIND --body-file FILE [--timeout-ms MS]");
}
