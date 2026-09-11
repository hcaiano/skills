#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENT_KINDS,
  CLAUDE_ALIASES,
  LEAD_MARKERS,
  acquireMarker,
  bootstrapPrompt,
  clearMarker,
  compareVersions,
  cursorModel,
  defaultIdleMinutes,
  detectSelf,
  extractReply,
  isHeavyAgentRun,
  locate,
  markerAlive,
  messagePrompt,
  minutesToMs,
  newSessionId,
  parseClaudeInit,
  parseClaudeResult,
  parseCursorSessionId,
  parseGrokStream,
  parseModelRequest,
  parseOpenCodeStream,
  parseSessionId,
  parseTextReply,
  partnerEnv,
  partnerIdentity,
  pickLatestCodex,
  pickLatestCursor,
  pickLatestGrok,
  processAlive,
  queuedHeavyJob,
  readProcessTable,
  releaseMarker,
  resolvePartner,
  resolveWrite,
  selfHome,
  sessionKnown,
  summarizeRateLimits,
  throttleSignals,
  turnCommand,
} from "./pair-headless.mjs";
import { CODEX_READ_METHODS, codexHomeFor, codexModelCatalog, codexRead, listCodexHomes, verifyCodexBinary } from "./codex-rpc.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const helper = join(directory, "pair-headless.mjs");
const fixtures = join(directory, "fixtures");
const root = mkdtempSync(join(tmpdir(), "pair-headless-test-"));
const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });

// Fake CLIs record every invocation — argv, stdin, and cwd — so the tests can
// prove the exact command surface without a live codex or claude session.
const CODEX_SID = "11111111-2222-3333-4444-555555555555";
const CLAUDE_SID = "claude-session-abc";
const CURSOR_SID = "cursor-chat-7f3a";
const OPENCODE_SID = "ses_0123456789abcdef";
const log = join(root, "invocations.jsonl");

// Every fake CLI records the in-flight marker it can see while it runs — the
// only window in which a completed turn's marker is observable — and can steal
// it, standing in for another run taking the lock over mid-turn.
const markerProbe = `
const markerPath = require("node:path").join(process.cwd(), ".git", "pair", "in-flight.json");
try { fs.copyFileSync(markerPath, process.env.FAKE_MARKER_SEEN); } catch {}
if (mode === "steal") {
  fs.writeFileSync(markerPath, JSON.stringify({ seq: 99, pid: 4242, child_pid: null, started_at: "z" }));
}
`;

// The fake app-server answers the documented handshake and the three read
// methods with a catalog shaped like the live one (2026-09-07 probe): visible
// families at several versions, a hidden entry, a promo ID, and per-model
// effort lists. The catalog is paginated — Astra lives on the second page —
// and an "old" binary publishes only the first page, as the 0.147.0 install
// on this machine did.
const CODEX_PAGE_ONE = [
  { id: "gpt-5.6-sol", model: "gpt-5.6-sol", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] },
  { id: "gpt-5.5-sol", model: "gpt-5.5-sol", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
  { id: "gpt-5.10-sol", model: "gpt-5.10-sol", hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  { id: "gpt-5.6-luna", model: "gpt-5.6-luna", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }, { reasoningEffort: "max" }] },
  { id: "gpt-5.6-terra", model: "gpt-5.6-terra", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  { id: "gpt-daybreak-blue-latest", model: "gpt-daybreak-blue-latest", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
];
const CODEX_PAGE_TWO = [
  { id: "gpt-6-astra", model: "gpt-6-astra", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }, { reasoningEffort: "max" }, { reasoningEffort: "ultra" }] },
  { id: "gpt-7-nova", model: "gpt-7-nova", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  { id: "gpt-7-nova", model: "gpt-7-nova", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
];
const CODEX_CATALOG = JSON.stringify({ data: [...CODEX_PAGE_ONE, ...CODEX_PAGE_TWO], nextCursor: null });
// Which lead markers the child can still see: the helper must have stripped
// every one of them before spawning a partner.
const markerReport = `
const lead_markers = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "CODEX_SANDBOX", "CURSOR_AGENT", "CURSOR_AGENT_CHAT_ID", "GROK_SESSION_ID", "GROK_AGENT", "OPENCODE_CLIENT", "OPENCODE_PID", "OPENCODE_WORKSPACE_ID"].filter((name) => process.env[name]);
`;
const codexFake = ({ old }) => `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE || "ok";
${markerReport}
if (argv[0] === "--version") { process.stdout.write("codex-cli ${old ? "0.147.0-fake" : "9.9.9-fake"}\\n"); process.exit(0); }
if (argv[0] === "app-server") {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "codex", argv, cwd: process.cwd(), codex_home: process.env.CODEX_HOME ?? null, bin_path: process.argv[1], pid: process.pid, lead_markers }) + "\\n");
  if (mode === "rpc-silent") { setInterval(() => {}, 1000); return; }
  if (mode === "rpc-ignore-term") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); return; }
  let pending = "";
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    let nl;
    while ((nl = pending.indexOf("\\n")) !== -1) {
      const line = pending.slice(0, nl); pending = pending.slice(nl + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "fake", codexHome: process.env.CODEX_HOME ?? null } }) + "\\n");
      else if (message.method === "initialized") process.stdout.write(JSON.stringify({ method: "remoteControl/status/changed", params: { status: "disabled" } }) + "\\n");
      else if (message.method === "model/list") {
        const one = JSON.parse(${JSON.stringify(JSON.stringify(CODEX_PAGE_ONE))});
        const two = JSON.parse(${JSON.stringify(JSON.stringify(CODEX_PAGE_TWO))});
        const page = message.params?.cursor === "page-2" ? { data: two, nextCursor: mode === "rpc-loop" ? "page-2" : null } : { data: one, nextCursor: ${old ? "null" : '"page-2"'} };
        process.stdout.write(JSON.stringify({ id: message.id, result: page }) + "\\n");
      }
      else if (message.method === "account/read") process.stdout.write(JSON.stringify({ id: message.id, result: { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: true } }) + "\\n");
      else if (message.method === "account/rateLimits/read") process.stdout.write(JSON.stringify({ id: message.id, result: { rateLimits: { limitId: "codex", primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1789362109 } } } }) + "\\n");
      else process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "unknown method " + message.method } }) + "\\n");
    }
  });
  return;
}
${markerProbe}
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "codex", argv, stdin, cwd: process.cwd(), codex_home: process.env.CODEX_HOME ?? null, bin_path: process.argv[1], lead_markers }) + "\\n");
if (mode === "hang") { setInterval(() => {}, 1000); return; }
if (mode !== "nosid") process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "${CODEX_SID}" }) + "\\n");
// A queued turn: the partner's validation sits in the devbox heavy queue
// (a fake agent-run with no child) for FAKE_HEAVY_WAIT_MS, then replies.
if (mode === "queued" || mode === "queued-task") {
  require("node:child_process").spawnSync(process.execPath, [require("node:path").join(__dirname, "agent-run"), mode === "queued" ? "heavy" : "task", "--", "bun", "test"], { stdio: "ignore" });
}
const out = argv[argv.indexOf("-o") + 1];
if (mode === "fail") { process.stderr.write("rate limit\\n"); process.exit(1); }
if (mode === "empty") { fs.writeFileSync(out, "   \\n"); process.exit(0); }
if (mode === "big") { fs.writeFileSync(out, "[agent codex -> claude kind=ready sid=${CODEX_SID}]\\n\\n" + "x".repeat(300000) + "\\n"); process.exit(0); }
fs.writeFileSync(out, "[agent codex -> claude kind=ready sid=${CODEX_SID}]\\n\\nlease accepted\\n");
process.exit(0);
`;
writeFileSync(join(bin, "codex"), codexFake({ old: false }));
// The devbox launcher, reduced to what the supervisor observes: a process
// whose argv names agent-run and a mode, blocking with no child of its own
// until the slot is granted (here: until the wait elapses).
writeFileSync(
  join(bin, "agent-run"),
  `#!/usr/bin/env node
setTimeout(() => process.exit(0), Number(process.env.FAKE_HEAVY_WAIT_MS ?? 5000));
`,
);
const oldCodexBin = join(root, "old-install", "codex");
mkdirSync(dirname(oldCodexBin), { recursive: true });
writeFileSync(oldCodexBin, codexFake({ old: true }));
chmodSync(oldCodexBin, 0o755);
writeFileSync(
  join(bin, "claude"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE || "ok";
${markerProbe}
${markerReport}
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "claude", argv, stdin, cwd: process.cwd(), lead_markers }) + "\\n");
if (mode === "fail") { process.stderr.write("auth expired\\n"); process.exit(1); }
// stream-json: a system init event, an assistant event, then the final result.
// The init event reports the exact model, as the live CLI does: an alias
// resolves to the current family member, an explicit ID echoes back.
const asked = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : "claude-opus-5";
const model = { fable: "claude-fable-5-1", opus: "claude-opus-5", sonnet: "claude-sonnet-5" }[asked] ?? asked;
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "${CLAUDE_SID}", model: mode === "moved-alias" ? "claude-opus-5" : model, tools: [] }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", session_id: "${CLAUDE_SID}", message: { content: [{ type: "text", text: "thinking" }] } }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result",
  session_id: "${CLAUDE_SID}",
  is_error: mode === "error",
  result: mode === "empty" ? "" : "[agent claude -> codex kind=ready sid=${CLAUDE_SID}]\\n\\nreviewed",
}) + "\\n");
process.exit(0);
`,
);
// Cursor prints one JSON object holding the chat id and the answer; Grok
// prints the answer only, because its session id was handed to it.
writeFileSync(
  join(bin, "cursor-agent"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE || "ok";
if (argv[0] === "--list-models") {
  process.stdout.write([
    "Available models",
    "",
    "auto - Auto (current, default)",
    "gpt-5.6-sol-high - GPT-5.6 Sol 1M High",
    "gpt-5.6-sol-high-fast - GPT-5.6 Sol 1M High Fast",
    "gpt-5.6-sol-xhigh - GPT-5.6 Sol 1M Extra High",
    "claude-fable-5-thinking-high - Claude Fable 5 1M Thinking (NO ZDR)",
    "claude-fable-5-high - Claude Fable 5 1M (NO ZDR)",
    "claude-fable-5-1-high - Claude Fable 5.1 1M (NO ZDR)",
    "claude-fable-5-1-thinking-high - Claude Fable 5.1 1M Thinking (NO ZDR)",
    "claude-fable-5-1-xhigh - Claude Fable 5.1 1M Extra High (NO ZDR)",
    "claude-sonnet-5-thinking-high - Claude Sonnet 5 1M Thinking",
    "kimi-k3-high - Kimi K3 High",
    "kimi-k3-max - Kimi K3",
    "cursor-grok-4.6-high - Cursor Grok 4.6",
    "",
  ].join("\\n"));
  process.exit(0);
}
${markerProbe}
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "cursor-agent", argv, stdin, cwd: process.cwd() }) + "\\n");
if (mode === "fail") { process.stderr.write("cursor auth expired\\n"); process.exit(1); }
process.stdout.write(JSON.stringify({
  type: "result",
  session_id: "${CURSOR_SID}",
  is_error: false,
  result: mode === "empty" ? "" : "[agent cursor -> claude kind=ready sid=${CURSOR_SID}]\\n\\ncursor reviewed",
}) + "\\n");
process.exit(0);
`,
);
writeFileSync(
  join(bin, "grok"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE || "ok";
if (argv[0] === "models") {
  process.stdout.write("You are logged in with grok.com.\\n\\nDefault model: grok-4.6\\n\\nAvailable models:\\n  * grok-4.6 (default)\\n  - grok-4.5\\n  - grok-4.10\\n  - grok-4.10\\n  - grok-4.11-preview\\n");
  process.exit(0);
}
${markerProbe}
const promptFile = argv[argv.indexOf("--prompt-file") + 1];
const stdin = fs.readFileSync(promptFile, "utf8");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "grok", argv, stdin, cwd: process.cwd() }) + "\\n");
if (mode === "fail") { process.stderr.write("grok rate limit\\n"); process.exit(1); }
if (mode === "hang-partial") {
  process.stdout.write(JSON.stringify({ type: "text", data: "partial answer" }) + "\\n");
  setInterval(() => {}, 1000);
  return;
}
if (mode === "live") {
  let n = 0;
  const timer = setInterval(() => {
    process.stdout.write(JSON.stringify({ type: "thought", data: String(n++) }) + "\\n");
    if (n === 5) {
      clearInterval(timer);
      process.stdout.write(JSON.stringify({ type: "text", data: "grok reviewed" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: argv.includes("--session-id") ? argv[argv.indexOf("--session-id") + 1] : argv[argv.indexOf("--resume") + 1] }) + "\\n");
      process.exit(0);
    }
  }, 300);
  return;
}
if (mode !== "empty") process.stdout.write(JSON.stringify({ type: "text", data: "grok reviewed" }) + "\\n");
const sessionId = argv.includes("--session-id") ? argv[argv.indexOf("--session-id") + 1] : argv[argv.indexOf("--resume") + 1];
process.stdout.write(JSON.stringify({ type: "end", stopReason: mode === "cancel" ? "cancelled" : "end_turn", sessionId }) + "\\n");
process.exit(0);
`,
);
writeFileSync(
  join(bin, "opencode"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE || "ok";
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "opencode", argv, stdin, cwd: process.cwd() }) + "\\n");
if (mode === "fail") { process.stderr.write("opencode rate limit\\n"); process.exit(1); }
const sid = argv.includes("--session") ? argv[argv.indexOf("--session") + 1] : "${OPENCODE_SID}";
process.stdout.write(JSON.stringify({ type: "step_start", sessionID: sid, part: { type: "step-start", sessionID: sid } }) + "\\n");
if (mode !== "empty") {
  process.stdout.write(JSON.stringify({
    type: "text",
    sessionID: sid,
    part: { type: "text", sessionID: sid, text: "[agent opencode -> claude kind=ready sid=" + sid + "]\\n\\nopencode reviewed" },
  }) + "\\n");
}
process.stdout.write(JSON.stringify({ type: "step_finish", sessionID: sid, part: { type: "step-finish", sessionID: sid, reason: "stop" } }) + "\\n");
process.exit(0);
`,
);
for (const name of ["codex", "claude", "cursor-agent", "grok", "opencode", "agent-run"]) chmodSync(join(bin, name), 0o755);

const newRepo = (name) => {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" });
  return repo;
};

const newLinkedWorktree = (name) => {
  const repo = newRepo(`${name}-main`);
  const commit = spawnSync(
    "git",
    ["-C", repo, "-c", "user.name=Pair Tests", "-c", "user.email=pair@example.test", "commit", "--allow-empty", "-q", "-m", "init"],
    { encoding: "utf8" },
  );
  assert.equal(commit.status, 0, commit.stderr);
  const worktree = join(root, `${name}-linked`);
  const added = spawnSync("git", ["-C", repo, "worktree", "add", "-q", "-b", `${name}-branch`, worktree], { encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);
  return { repo, worktree };
};

const env = (mode, self = "claude") => ({
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  FAKE_MODE: mode,
  FAKE_LOG: log,
  FAKE_MARKER_SEEN: join(root, "marker-seen.json"),
  HOME: root,
  CLAUDECODE: self === "claude" ? "1" : "",
  CODEX_SANDBOX: self === "codex" ? "seatbelt" : "",
  CODEX_HOME: "",
  CLAUDE_CODE_ENTRYPOINT: "",
  CURSOR_AGENT: self === "cursor" ? "1" : "",
  CURSOR_AGENT_CHAT_ID: "",
  GROK_SESSION_ID: self === "grok" ? "grok-lead" : "",
  GROK_AGENT: "",
  GROK_HOME: "",
  OPENCODE_CLIENT: self === "opencode" ? "cli" : "",
  OPENCODE_PID: "",
  OPENCODE_WORKSPACE_ID: "",
});

const runThrough = (entry, mode, self, ...args) => {
  writeFileSync(log, "");
  try {
    return {
      ok: true,
      receipt: JSON.parse(
        execFileSync(process.execPath, [entry, ...args], {
          encoding: "utf8",
          env: env(mode, self),
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
    };
  } catch (error) {
    if (!error.stdout) throw error;
    return { ok: false, receipt: JSON.parse(error.stdout) };
  }
};
const run = (mode, self, ...args) => runThrough(helper, mode, self, ...args);
const invocations = () =>
  readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const bodyFile = (text) => {
  const path = join(root, `body-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(path, text);
  return path;
};

test("the partner is chosen, and never the CLI the lead is already running", () => {
  assert.equal(detectSelf({ CLAUDECODE: "1" }), "claude");
  assert.equal(detectSelf({ CODEX_SANDBOX: "seatbelt" }), "codex");
  assert.equal(detectSelf({ CURSOR_AGENT: "1" }), "cursor");
  assert.equal(detectSelf({ GROK_SESSION_ID: "s" }), "grok");
  assert.equal(detectSelf({ OPENCODE_CLIENT: "cli" }), "opencode");
  assert.equal(detectSelf({}), null);
  assert.deepEqual(resolvePartner("grok", { CLAUDECODE: "1" }), { partner: "grok", self: "claude", identity: "default", identity_home: null });
  assert.deepEqual(resolvePartner("cursor", { CODEX_THREAD_ID: "t" }), { partner: "cursor", self: "codex", identity: "default", identity_home: null });
  // An undetectable harness still pairs: the choice is explicit either way.
  // The default Codex identity is the CLI's own home even before it exists.
  assert.deepEqual(resolvePartner("codex", {}, { home: root }), {
    partner: "codex",
    self: "lead",
    identity: "default",
    identity_home: realpathSync(join(root, ".codex")),
  });
  assert.equal(resolvePartner("codex", {}, { home: join(root, "fresh-machine") }).identity_home, join(root, "fresh-machine", ".codex"));
  for (const self of AGENT_KINDS) {
    const env = {
      claude: { CLAUDECODE: "1" },
      codex: { CODEX_SANDBOX: "s" },
      cursor: { CURSOR_AGENT: "1" },
      grok: { GROK_SESSION_ID: "s" },
      opencode: { OPENCODE_CLIENT: "cli" },
    }[self];
    assert.match(resolvePartner(self, env, { home: root }).error, new RegExp(`refusing to pair ${self} with itself`, "u"));
  }
  assert.match(resolvePartner("gemini", {}).error, /unknown partner gemini/u);
  assert.match(resolvePartner(null, {}).error, /missing --partner/u);
});

// Three Codex homes on one machine: the default one (no session store yet,
// so its probes stay inconclusive as the older tests expect), a named profile
// with a store, and an empty named store that can prove an absence.
const codexHome = join(root, ".codex");
const laisHome = join(root, ".codex-profiles", "lais");
const emptyHome = join(root, ".codex-profiles", "empty");
mkdirSync(codexHome, { recursive: true });
mkdirSync(join(laisHome, "sessions"), { recursive: true });
mkdirSync(join(emptyHome, "sessions"), { recursive: true });
writeFileSync(join(root, ".codex-profiles", "not-a-home"), "");

test("a Codex identity is a home, and only a different home makes a Codex peer", () => {
  assert.deepEqual(codexHomeFor("default", { home: root }), { identity: "default", codexHome: realpathSync(codexHome) });
  assert.deepEqual(codexHomeFor("lais", { home: root }), { identity: "lais", codexHome: realpathSync(laisHome) });
  assert.match(codexHomeFor("ghost", { home: root }).error, /identity ghost has no Codex home/u);
  assert.match(codexHomeFor("not-a-home", { home: root }).error, /no Codex home|not a directory/u);
  assert.match(codexHomeFor("../lais", { home: root }).error, /invalid identity name/u);
  assert.match(codexHomeFor("", { home: root }).error, /invalid identity name/u);
  assert.deepEqual(listCodexHomes({ home: root }), { default: realpathSync(codexHome), empty: realpathSync(emptyHome), lais: realpathSync(laisHome) });

  assert.deepEqual(partnerIdentity("codex", "lais", { home: root }), { identity: "lais", identity_home: realpathSync(laisHome) });
  assert.deepEqual(partnerIdentity("codex", undefined, { home: root }), { identity: "default", identity_home: realpathSync(codexHome) });
  assert.deepEqual(partnerIdentity("claude", "default", { home: root }), { identity: "default", identity_home: null });
  assert.match(partnerIdentity("claude", "work", { home: root }).error, /claude has no named identities/u);

  // The lead's own home is read from its environment, before any override.
  assert.equal(selfHome("codex", { CODEX_HOME: laisHome }, root), realpathSync(laisHome));
  assert.equal(selfHome("codex", {}, root), realpathSync(codexHome));
  assert.equal(selfHome("claude", { CODEX_HOME: laisHome }, root), null);

  // A Codex lead pairs with the other account, and refuses its own by home,
  // not by label: `default` named from a lead that runs under the default home
  // is the same login.
  const codexLead = { CODEX_SANDBOX: "seatbelt" };
  assert.equal(resolvePartner("codex", codexLead, { identity: "lais", home: root }).identity_home, realpathSync(laisHome));
  assert.match(resolvePartner("codex", codexLead, { identity: "default", home: root }).error, /refusing to pair codex with itself[\s\S]*--identity/u);
  const laisLead = { CODEX_SANDBOX: "seatbelt", CODEX_HOME: laisHome };
  assert.match(resolvePartner("codex", laisLead, { identity: "lais", home: root }).error, /refusing to pair codex with itself/u);
  assert.equal(resolvePartner("codex", laisLead, { identity: "default", home: root }).identity_home, realpathSync(codexHome));
  // A Claude lead has one account, so a Claude partner is still an echo.
  assert.match(resolvePartner("claude", { CLAUDECODE: "1" }, { identity: "default", home: root }).error, /refusing to pair claude with itself/u);

  // The child always gets its account spelled out, so a lead under a named
  // home never leaks that home into its partner.
  assert.equal(partnerEnv({ partner: "codex", identity_home: laisHome }, { CODEX_HOME: codexHome, PATH: "p" }).CODEX_HOME, laisHome);
  // The lead's own markers never reach the child; provider variables do. A
  // pre-identity Codex session keeps the CODEX_HOME it always inherited.
  const inherited = { CODEX_HOME: laisHome, PATH: "p", OPENAI_BASE_URL: "https://example.test", CLAUDECODE: "1", CODEX_SANDBOX: "seatbelt", CODEX_THREAD_ID: "t" };
  assert.deepEqual(partnerEnv({ partner: "claude", identity_home: null }, inherited), { CODEX_HOME: laisHome, PATH: "p", OPENAI_BASE_URL: "https://example.test" });
  assert.deepEqual(partnerEnv({ partner: "codex", identity_home: null }, inherited), { CODEX_HOME: laisHome, PATH: "p", OPENAI_BASE_URL: "https://example.test" });
  assert.equal(partnerEnv({ partner: "codex", identity_home: null }, { PATH: "p" }).CODEX_HOME, undefined, "no home is invented for a legacy session");
  for (const marker of LEAD_MARKERS) assert.equal(marker in partnerEnv({ partner: "grok", identity_home: null }, Object.fromEntries(LEAD_MARKERS.map((name) => [name, "1"]))), false);
});

test("a headless Codex partner runs as its named identity across init, send, status, and resume", () => {
  const repo = newRepo("identity-lais");
  const created = run("ok", "codex", "init", "--repo", repo, "--partner", "codex", "--identity", "lais", "--model", "gpt-5.6-luna", "--effort", "max");
  assert.equal(created.receipt.status, "created", created.receipt.reason);
  assert.equal(created.receipt.identity, "lais");
  assert.equal(created.receipt.identity_home, realpathSync(laisHome));
  assert.equal(created.receipt.model, "gpt-5.6-luna");
  assert.equal(created.receipt.model_resolved, "gpt-5.6-luna");
  assert.equal(created.receipt.model_source, "explicit");
  const [init] = invocations();
  assert.equal(init.codex_home, realpathSync(laisHome), "the partner CLI ran under the named home");
  assert.deepEqual(init.argv.slice(init.argv.indexOf("-m"), init.argv.indexOf("-m") + 4), ["-m", "gpt-5.6-luna", "-c", 'model_reasoning_effort="max"']);
  const state = JSON.parse(readFileSync(created.receipt.state_file, "utf8"));
  assert.equal(state.identity, "lais");
  assert.equal(state.identity_home, realpathSync(laisHome));

  // The session store probed is the identity's own, so a resume that only
  // exists in the other home would read as absent. Record it where it lives.
  writeFileSync(join(laisHome, "sessions", `rollout-${CODEX_SID}.jsonl`), "");
  const resumed = run("ok", "codex", "init", "--repo", repo, "--partner", "codex", "--identity", "lais");
  assert.equal(resumed.receipt.status, "resumed");
  assert.equal(resumed.receipt.identity, "lais");
  assert.equal(resumed.receipt.model_resolved, "gpt-5.6-luna");
  // A different account is a different login: its store cannot hold this sid.
  const changed = run("ok", "claude", "init", "--repo", repo, "--partner", "codex", "--identity", "default");
  assert.match(changed.receipt.reason, /runs as codex identity lais[\s\S]*end it first/u);
  assert.deepEqual(invocations(), [], "no partner turn was spent on the refused change");

  // Every later turn is resumed under the recorded home, not the caller's.
  const sent = run("ok", "codex", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("go"));
  assert.equal(sent.receipt.status, "replied");
  const [turn] = invocations();
  assert.equal(turn.codex_home, realpathSync(laisHome));
  assert.deepEqual(turn.argv.slice(0, 3), ["exec", "resume", CODEX_SID]);
  const status = run("ok", "codex", "status", "--repo", repo).receipt;
  assert.equal(status.identity, "lais");
  assert.equal(status.identity_home, realpathSync(laisHome));
  assert.equal(status.session_known, true);
  assert.equal(sessionKnown("codex", CODEX_SID, repo, {}, root, realpathSync(emptyHome)), false, "another account's readable store does not hold it");

  // The same-home refusal and the name checks spend nothing.
  const same = run("ok", "codex", "init", "--repo", newRepo("identity-same"), "--partner", "codex", "--identity", "default").receipt;
  assert.match(same.reason, /refusing to pair codex with itself/u);
  const missing = run("ok", "claude", "init", "--repo", newRepo("identity-missing"), "--partner", "codex", "--identity", "ghost").receipt;
  assert.match(missing.reason, /identity ghost has no Codex home/u);
  const claudeNamed = run("ok", "codex", "init", "--repo", newRepo("identity-claude"), "--partner", "claude", "--identity", "work").receipt;
  assert.match(claudeNamed.reason, /claude has no named identities/u);
  assert.deepEqual(invocations(), []);
});

test("a Claude lead's default Codex partner is pinned to the default home even under a stray CODEX_HOME", () => {
  const repo = newRepo("identity-default");
  writeFileSync(log, "");
  const receipt = JSON.parse(execFileSync(process.execPath, [helper, "init", "--repo", repo, "--partner", "codex"], {
    encoding: "utf8",
    env: { ...env("ok", "claude"), CODEX_HOME: laisHome },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  assert.equal(receipt.identity, "default");
  assert.equal(receipt.identity_home, realpathSync(codexHome));
  assert.equal(invocations()[0].codex_home, realpathSync(codexHome));
});

test("a resumed pair takes its identity and home from the record, and a lost session stops instead of being replaced", () => {
  const repo = newRepo("identity-resume");
  const created = run("ok", "codex", "init", "--repo", repo, "--partner", "codex", "--identity", "lais", "--model", "gpt-5.6-luna", "--effort", "max").receipt;
  assert.equal(created.status, "created", created.reason);
  writeFileSync(join(laisHome, "sessions", `rollout-${CODEX_SID}.jsonl`), "");
  const before = readFileSync(created.state_file, "utf8");

  // Omitting --identity resumes as recorded — not as a defaulted `default`,
  // which a Codex lead on the default home would even be refused for.
  const omitted = run("ok", "codex", "init", "--repo", repo, "--partner", "codex").receipt;
  assert.equal(omitted.status, "resumed", omitted.reason);
  assert.equal(omitted.identity, "lais");
  assert.equal(omitted.identity_home, realpathSync(laisHome));
  assert.deepEqual(invocations(), []);

  // A lead whose own environment moved to the partner's home still resumes:
  // the record, not the caller, is the pair.
  writeFileSync(log, "");
  const movedLead = JSON.parse(execFileSync(process.execPath, [helper, "init", "--repo", repo, "--partner", "codex"], {
    encoding: "utf8",
    env: { ...env("ok", "codex"), CODEX_HOME: laisHome },
    stdio: ["ignore", "pipe", "pipe"],
  }));
  assert.equal(movedLead.status, "resumed");
  assert.equal(movedLead.identity_home, realpathSync(laisHome));
  assert.equal(readFileSync(created.state_file, "utf8"), before, "the record is untouched");

  // A session proved absent from its own store is a loss to inspect, not a
  // slot to recreate under whatever identity the caller defaulted to.
  unlinkSync(join(laisHome, "sessions", `rollout-${CODEX_SID}.jsonl`));
  const lost = run("ok", "codex", "init", "--repo", repo, "--partner", "codex").receipt;
  assert.equal(lost.ok, false);
  assert.match(lost.reason, /recorded codex session .* \(identity lais\) is absent from its session store[\s\S]*end the pair before creating a new one/u);
  assert.deepEqual(invocations(), [], "no partner turn, no replacement");
  assert.equal(readFileSync(created.state_file, "utf8"), before, "the lost session's record and history survive");
  const changed = run("ok", "claude", "init", "--repo", repo, "--partner", "codex", "--identity", "default").receipt;
  assert.match(changed.reason, /runs as codex identity lais/u);
});

test("the Codex binary is verified once, recorded, and used for the catalog and every turn", () => {
  const repo = newRepo("codex-bin");
  const withOld = (mode, ...args) => {
    writeFileSync(log, "");
    try {
      return JSON.parse(execFileSync(process.execPath, [helper, ...args], {
        encoding: "utf8",
        env: { ...env(mode, "claude"), CODEX_BIN: oldCodexBin },
        stdio: ["ignore", "pipe", "pipe"],
      }));
    } catch (error) {
      return JSON.parse(error.stdout);
    }
  };
  // The old install's catalog has no Astra: the refusal names that binary and
  // its one page, so the reader knows which install answered.
  const noAstra = withOld("ok", "init", "--repo", repo, "--partner", "codex", "--model", "latest:astra", "--effort", "high");
  assert.equal(noAstra.ok, false);
  assert.match(noAstra.reason, new RegExp(`no visible Codex model in family astra — the catalog has sol, luna, terra \\(catalog of ${oldCodexBin.replaceAll(".", "\\.")}, 1 page, home `, "u"));
  assert.deepEqual(invocations().map((call) => [call.argv[0], call.bin_path]), [["app-server", oldCodexBin]]);

  // An explicit binary is pinned into the session and used on every resume,
  // even when the later caller no longer sets CODEX_BIN.
  const created = withOld("ok", "init", "--repo", repo, "--partner", "codex", "--model", "latest:luna", "--effort", "max");
  assert.equal(created.status, "created", created.reason);
  assert.equal(created.partner_bin, oldCodexBin);
  assert.equal(created.partner_bin_version, "0.147.0-fake");
  assert.equal(created.model_resolved, "gpt-5.6-luna");
  assert.ok(invocations().every((call) => call.bin_path === oldCodexBin));
  const sent = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("go")).receipt;
  assert.equal(sent.status, "replied");
  assert.equal(invocations()[0].bin_path, oldCodexBin, "the turn ran the recorded binary, not PATH's");
  assert.equal(run("ok", "claude", "status", "--repo", repo).receipt.partner_bin, oldCodexBin);
  // PATH discovery is portable, but its selected executable is pinned.
  const defaultRepo = newRepo("codex-bin-default");
  const fromPath = run("ok", "claude", "init", "--repo", defaultRepo, "--partner", "codex").receipt;
  assert.equal(fromPath.partner_bin, join(bin, "codex"));
  writeFileSync(log, "");
  const changedPath = JSON.parse(execFileSync(process.execPath, [helper, "send", "--repo", defaultRepo, "--kind", "task", "--body-file", bodyFile("go")], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...env("ok", "claude"), PATH: `${dirname(oldCodexBin)}:${env("ok", "claude").PATH}` },
  }));
  assert.equal(changedPath.status, "replied");
  assert.equal(invocations()[0].bin_path, join(bin, "codex"), "a changed PATH cannot replace the recorded executable");
  const missing = JSON.parse((() => { try { return execFileSync(process.execPath, [helper, "init", "--repo", newRepo("codex-bin-none"), "--partner", "codex"], { encoding: "utf8", env: { ...env("ok", "claude"), CODEX_BIN: join(root, "no-such-codex") }, stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { return error.stdout; } })());
  assert.match(missing.reason, /the Codex binary could not be verified — set CODEX_BIN to an installed codex: cannot run .*no-such-codex --version/u);
  assert.deepEqual(verifyCodexBinary(join(bin, "codex"), { env: env("ok", "claude") }), { bin: join(bin, "codex"), version: "9.9.9-fake" });
});

test("a partner never inherits the lead's own harness markers", () => {
  const repo = newRepo("markers");
  const spawnWith = (leadEnv, ...args) => {
    writeFileSync(log, "");
    return JSON.parse(execFileSync(process.execPath, [helper, ...args], {
      encoding: "utf8",
      env: { ...env("ok", "claude"), ...leadEnv },
      stdio: ["ignore", "pipe", "pipe"],
    }));
  };
  // A Claude lead with every marker set still detects itself as Claude — the
  // markers are read before the child env is built — and the child sees none.
  const created = spawnWith({ CLAUDE_CODE_ENTRYPOINT: "cli", CURSOR_AGENT_CHAT_ID: "c", GROK_AGENT: "g" }, "init", "--repo", repo, "--partner", "codex");
  assert.equal(created.status, "created", created.reason);
  assert.deepEqual(invocations().map((call) => call.lead_markers), [[]]);
  assert.match(JSON.parse(readFileSync(created.state_file, "utf8")).self, /claude/u);
  spawnWith({ CODEX_THREAD_ID: "t" }, "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("go"));
  assert.deepEqual(invocations()[0].lead_markers, []);
  const claudeRepo = newRepo("markers-claude");
  spawnWith({ CLAUDECODE: "", CODEX_SANDBOX: "seatbelt", CODEX_THREAD_ID: "t" }, "init", "--repo", claudeRepo, "--partner", "claude");
  assert.deepEqual(invocations()[0].lead_markers, []);

  // A session recorded before identities existed keeps the CODEX_HOME it
  // always inherited; the helper does not move it to another account.
  const legacyRepo = newRepo("markers-legacy");
  spawnWith({}, "init", "--repo", legacyRepo, "--partner", "codex");
  const statePath = join(realpathSync(legacyRepo), ".git", "pair", "session.json");
  const legacy = JSON.parse(readFileSync(statePath, "utf8"));
  for (const key of ["identity", "identity_home", "partner_bin", "partner_bin_version", "model_resolved", "model_source", "resolved_at"]) delete legacy[key];
  writeFileSync(statePath, JSON.stringify(legacy));
  const legacySend = spawnWith({ CODEX_HOME: laisHome }, "send", "--repo", legacyRepo, "--kind", "task", "--body-file", bodyFile("go"));
  assert.equal(legacySend.status, "replied");
  assert.equal(invocations()[0].codex_home, laisHome, "the inherited home is preserved for a legacy session");
  assert.equal(invocations()[0].bin_path, join(bin, "codex"));
  const status = run("ok", "claude", "status", "--repo", legacyRepo).receipt;
  assert.equal(status.identity, "default");
  assert.equal(status.identity_home, null);
  assert.equal(status.partner_bin, null);
});

test("latest:<family> resolves by exact family and numeric version, never by guess", () => {
  assert.deepEqual(parseModelRequest(null), { kind: "default" });
  assert.deepEqual(parseModelRequest("gpt-5.6-sol"), { kind: "explicit", model: "gpt-5.6-sol" });
  assert.deepEqual(parseModelRequest("latest:Sol"), { kind: "latest", family: "sol" });
  assert.match(parseModelRequest("latest").error, /plain `latest` names no family/u);
  assert.match(parseModelRequest("latest:").error, /not a family/u);
  assert.match(parseModelRequest("latest:gpt-5.6-sol").error, /not a family/u);
  assert.ok(compareVersions("6", "5.6") > 0);
  assert.ok(compareVersions("5.10", "5.6") > 0, "numeric, not lexical");
  assert.equal(compareVersions("5.0", "5"), 0);
  assert.deepEqual(CLAUDE_ALIASES, ["fable", "opus", "sonnet"]);

  const catalog = JSON.parse(CODEX_CATALOG);
  assert.equal(pickLatestCodex(catalog, "sol", "high").model, "gpt-5.6-sol", "5.10-sol is hidden, 5.5 is older");
  assert.deepEqual(pickLatestCodex(catalog, "sol").considered, ["gpt-5.6-sol", "gpt-5.5-sol"]);
  assert.equal(pickLatestCodex(catalog, "astra", "ultra").model, "gpt-6-astra");
  assert.equal(pickLatestCodex(catalog, "luna", "max").model, "gpt-5.6-luna");
  assert.match(pickLatestCodex(catalog, "luna", "ultra").error, /gpt-5\.6-luna does not accept effort ultra/u);
  assert.match(pickLatestCodex(catalog, "daybreak").error, /no visible Codex model in family daybreak/u, "promo IDs never match a family");
  assert.match(pickLatestCodex(catalog, "mars").error, /no visible Codex model in family mars — the catalog has sol, luna, terra, astra, nova/u, "no neighbouring family is substituted");
  assert.match(pickLatestCodex(catalog, "nova").error, /ambiguous at its newest version: gpt-7-nova, gpt-7-nova/u);
  assert.match(pickLatestCodex({ data: [] }, "sol").error, /no gpt-<version>-<family> entries/u);

  const grokListing = "Available models:\n  * grok-4.6 (default)\n  - grok-4.5\n  - grok-4.10\n  - grok-4.10\n  - grok-4.11-preview\n  - grok-5 beta\n";
  assert.equal(pickLatestGrok(grokListing, "grok").model, "grok-4.10", "a suffixed ID is another model, never truncated; a repeated ID is not an ambiguity");
  assert.deepEqual(pickLatestGrok(grokListing, "grok").considered, ["grok-4.6", "grok-4.5", "grok-4.10"]);
  assert.match(pickLatestGrok(grokListing, "grokx").error, /no grokx model/u);
  assert.match(pickLatestGrok("  * grok-4.7-preview (default)\n", "grok").error, /no grok model/u);

  const cursorListing = spawnSync(join(bin, "cursor-agent"), ["--list-models"], { encoding: "utf8" }).stdout;
  assert.equal(pickLatestCursor(cursorListing, "fable", "high").model, "claude-fable-5-1-high", "5.1 beats 5; thinking variants are not the seat");
  assert.equal(pickLatestCursor(cursorListing, "fable", "xhigh").model, "claude-fable-5-1-xhigh");
  assert.equal(pickLatestCursor(cursorListing, "sol", "high").model, "gpt-5.6-sol-high", "the -fast variant is not the seat");
  assert.equal(pickLatestCursor(cursorListing, "kimi", "max").model, "kimi-k3-max");
  assert.equal(pickLatestCursor(cursorListing, "grok", "high").model, "cursor-grok-4.6-high");
  assert.match(pickLatestCursor(cursorListing, "sonnet", "high").error, /no plain sonnet ID in the catalog — only thinking or fast variants/u);
  assert.match(pickLatestCursor(cursorListing, "fable", "low").error, /the newest plain fable \(claude-fable-5-1\) offers high, xhigh, not low$/u);
  assert.match(pickLatestCursor(cursorListing, "fable").error, /needs --effort/u);
  assert.match(pickLatestCursor(cursorListing, "astra", "high").error, /no astra model/u);
  // The newest version is chosen first; an effort it lacks is a refusal that
  // names the older ID, never a silent downgrade to the version that has it.
  const downgradeTrap = "claude-fable-5-2-medium - Fable 5.2 Medium\nclaude-fable-5-1-high - Fable 5.1\nclaude-fable-5-1-high - Fable 5.1 again\n";
  assert.match(pickLatestCursor(downgradeTrap, "fable", "high").error, /the newest plain fable \(claude-fable-5-2\) offers medium, not high — name claude-fable-5-1-high explicitly to take an older version/u);
  assert.equal(pickLatestCursor(downgradeTrap, "fable", "medium").model, "claude-fable-5-2-medium");
  assert.match(pickLatestCursor("composer-2.5 - Composer 2.5\ncomposer-2.5-fast - Composer 2.5 Fast\n", "composer", "high").error, /no composer model/u, "an ID without an effort token is outside the parser; name it exactly");

  assert.equal(parseClaudeInit('{"type":"system","subtype":"init","model":"claude-fable-5-1"}\n{"type":"result"}').model, "claude-fable-5-1");
  assert.equal(parseClaudeInit('{"type":"result"}'), null);
});

test("init resolves latest:<family> from each partner's live catalog and records the exact pick", () => {
  const codexRepo = newRepo("latest-codex");
  const sol = run("ok", "claude", "init", "--repo", codexRepo, "--partner", "codex", "--identity", "lais", "--model", "latest:sol", "--effort", "high").receipt;
  assert.equal(sol.status, "created", sol.reason);
  assert.equal(sol.model, "latest:sol", "the requested form stays the recorded model");
  assert.equal(sol.model_resolved, "gpt-5.6-sol");
  assert.equal(sol.model_source, "codex app-server model/list");
  assert.ok(sol.resolved_at);
  const calls = invocations();
  // Both catalog pages are read from the identity's own account, then the
  // session runs there too.
  assert.deepEqual(calls.map((call) => [call.argv[0], call.codex_home]), [["app-server", realpathSync(laisHome)], ["app-server", realpathSync(laisHome)], ["exec", realpathSync(laisHome)]], "the catalog is read from the identity's own account");
  assert.ok(calls[2].argv.includes("gpt-5.6-sol") && !calls[2].argv.includes("latest:sol"));
  const state = JSON.parse(readFileSync(sol.state_file, "utf8"));
  assert.deepEqual(state.model_evidence, { considered: ["gpt-5.6-sol", "gpt-5.5-sol"], efforts: ["low", "high", "xhigh"], codex_home: realpathSync(laisHome), codex_bin: join(bin, "codex"), pages: 2 });
  assert.equal(state.partner_bin, join(bin, "codex"));
  assert.equal(state.partner_bin_version, "9.9.9-fake");
  assert.equal(run("ok", "claude", "status", "--repo", codexRepo).receipt.model_resolved, "gpt-5.6-sol");
  // Astra is on the second page: a one-page read would miss it.
  const astra = run("ok", "claude", "init", "--repo", newRepo("latest-astra"), "--partner", "codex", "--model", "latest:astra", "--effort", "high").receipt;
  assert.equal(astra.model_resolved, "gpt-6-astra", astra.reason);
  assert.match(run("rpc-loop", "claude", "init", "--repo", newRepo("latest-loop"), "--partner", "codex", "--model", "latest:astra", "--effort", "high").receipt.reason, /repeated cursor "page-2" on page 2 — refusing to loop/u);

  const refused = run("ok", "claude", "init", "--repo", newRepo("latest-bad-effort"), "--partner", "codex", "--model", "latest:luna", "--effort", "ultra").receipt;
  assert.match(refused.reason, /does not accept effort ultra/u);
  assert.match(run("ok", "claude", "init", "--repo", newRepo("latest-plain"), "--partner", "codex", "--model", "latest", "--effort", "high").receipt.reason, /plain `latest`/u);
  assert.match(run("rpc-silent", "claude", "init", "--repo", newRepo("latest-silent"), "--partner", "codex", "--model", "latest:sol", "--effort", "high", "--idle-min", "1").receipt.reason, /cannot read the Codex model catalog/u);
  assert.match(run("ok", "claude", "init", "--repo", newRepo("latest-opencode"), "--partner", "opencode", "--model", "latest:sol").receipt.reason, /opencode has no latest:<family> resolution/u);

  const grokRepo = newRepo("latest-grok");
  const grok = run("ok", "claude", "init", "--repo", grokRepo, "--partner", "grok", "--model", "latest:grok", "--effort", "high").receipt;
  assert.equal(grok.model_resolved, "grok-4.10");
  assert.equal(grok.model_source, "grok models");
  assert.ok(invocations()[0].argv.includes("grok-4.10"));

  const cursorRepo = newRepo("latest-cursor");
  const cursor = run("ok", "claude", "init", "--repo", cursorRepo, "--partner", "cursor", "--model", "latest:fable", "--effort", "high").receipt;
  assert.equal(cursor.model_resolved, "claude-fable-5-1-high");
  assert.equal(cursor.effort, "high");
  const cursorArgs = invocations()[0].argv;
  assert.equal(cursorArgs[cursorArgs.indexOf("--model") + 1], "claude-fable-5-1-high", "the catalog ID already carries the effort; no [effort=] suffix");
});

test("a Claude partner records the exact model its init event reports and is re-pinned on resume", () => {
  const repo = newRepo("latest-claude");
  const created = run("ok", "codex", "init", "--repo", repo, "--partner", "claude", "--model", "latest:fable", "--effort", "high").receipt;
  assert.equal(created.status, "created", created.reason);
  assert.equal(created.model, "latest:fable");
  assert.equal(created.model_resolved, "claude-fable-5-1");
  assert.equal(created.model_source, "claude system.init.model");
  const [init] = invocations();
  assert.equal(init.argv[init.argv.indexOf("--model") + 1], "fable", "the documented alias goes to the CLI");
  run("ok", "codex", "send", "--repo", repo, "--kind", "review", "--body-file", bodyFile("look"));
  const [turn] = invocations();
  assert.deepEqual(turn.argv.slice(0, 3), ["-p", "--resume", CLAUDE_SID]);
  assert.equal(turn.argv[turn.argv.indexOf("--model") + 1], "claude-fable-5-1", "the resumed turn pins the exact ID, not the alias");

  // A CLI default is still pinned once the init event names it.
  const defaulted = run("ok", "codex", "init", "--repo", newRepo("claude-default"), "--partner", "claude").receipt;
  assert.equal(defaulted.model, null);
  assert.equal(defaulted.model_resolved, "claude-opus-5");
  // An alias that lands outside its family is a moved default, not the seat.
  const moved = run("moved-alias", "codex", "init", "--repo", newRepo("claude-moved"), "--partner", "claude", "--model", "latest:fable").receipt;
  assert.match(moved.reason, /claude resolved alias fable to claude-opus-5 — not a fable model/u);
  assert.match(run("ok", "codex", "init", "--repo", newRepo("claude-haiku"), "--partner", "claude", "--model", "latest:haiku").receipt.reason, /claude resolves only the documented aliases fable, opus, sonnet/u);

  // The bare alias is the same request: it goes to the CLI as given, the
  // init report is recorded, and a report outside the family refuses.
  const bare = run("ok", "codex", "init", "--repo", newRepo("claude-bare-alias"), "--partner", "claude", "--model", "fable").receipt;
  assert.equal(bare.model, "fable");
  assert.equal(bare.model_resolved, "claude-fable-5-1");
  const bareMoved = run("moved-alias", "codex", "init", "--repo", newRepo("claude-bare-moved"), "--partner", "claude", "--model", "opus").receipt;
  assert.equal(bareMoved.ok, true, "opus resolving to claude-opus-5 is in family");
  assert.match(run("moved-alias", "codex", "init", "--repo", newRepo("claude-bare-moved-2"), "--partner", "claude", "--model", "sonnet").receipt.reason, /claude resolved alias sonnet to claude-opus-5 — not a sonnet model; the bootstrap session claude-session-abc exists in Claude's store but no pair was recorded/u);
  const explicit = run("ok", "codex", "init", "--repo", newRepo("claude-explicit"), "--partner", "claude", "--model", "claude-fable-5-1").receipt;
  assert.equal(explicit.model_resolved, "claude-fable-5-1");
  // A bootstrap the CLI marks as an error is not a created pair.
  const errored = run("error", "codex", "init", "--repo", newRepo("claude-init-error"), "--partner", "claude").receipt;
  assert.equal(errored.ok, false);
  assert.match(errored.reason, /reported is_error during init — the claude session claude-session-abc exists in its store but no pair was recorded/u);
  assert.equal(existsSync(join(realpathSync(newRepo("claude-init-error")), ".git", "pair", "session.json")), false);
});

test("codexRead speaks the app-server handshake for the three read methods and nothing else", async () => {
  const options = { codexHome: laisHome, env: env("ok", "claude"), timeoutMs: 5000 };
  writeFileSync(log, "");
  const catalog = await codexRead("model/list", {}, options);
  assert.equal(catalog.data[0].id, "gpt-5.6-sol");
  assert.equal(catalog.nextCursor, "page-2");
  assert.equal(invocations()[0].codex_home, laisHome, "the account is selected by CODEX_HOME");
  const whole = await codexModelCatalog(options);
  assert.deepEqual(whole.data.map((entry) => entry.id).slice(-3), ["gpt-6-astra", "gpt-7-nova", "gpt-7-nova"]);
  assert.equal(whole.pages, 2);
  await assert.rejects(codexModelCatalog({ ...options, env: env("rpc-loop", "claude") }), /repeated cursor "page-2"/u);
  const oldCatalog = await codexModelCatalog({ ...options, bin: oldCodexBin });
  assert.equal(oldCatalog.pages, 1);
  assert.ok(!oldCatalog.data.some((entry) => entry.id === "gpt-6-astra"), "the old install publishes no Astra");
  const account = await codexRead("account/read", {}, options);
  assert.equal(account.account.planType, "pro");
  const limits = await codexRead("account/rateLimits/read", {}, options);
  assert.equal(limits.rateLimits.limitId, "codex");
  assert.deepEqual([...CODEX_READ_METHODS], ["account/read", "account/rateLimits/read", "model/list"]);
  await assert.rejects(codexRead("thread/start", {}, options), /allows only account\/read, account\/rateLimits\/read, model\/list, not thread\/start/u);
  await assert.rejects(codexRead("model/list", {}, { ...options, env: env("rpc-silent", "claude"), timeoutMs: 300 }), /did not answer model\/list within 300ms/u);
  await assert.rejects(codexRead("model/list", {}, { ...options, bin: join(root, "no-such-codex") }), /cannot run/u);
  await assert.rejects(codexRead("model/list", {}, { ...options, timeoutMs: 0 }), /positive finite timeoutMs/u);
  // A server that ignores TERM is killed within the grace period, and the
  // timeout error carries no stderr.
  writeFileSync(log, "");
  const started = Date.now();
  await assert.rejects(codexRead("model/list", {}, { ...options, env: env("rpc-ignore-term", "claude"), timeoutMs: 300 }), /^Error: codex app-server did not answer model\/list within 300ms$/u);
  const stubborn = invocations().find((call) => call.argv[0] === "app-server");
  const deadline = Date.now() + 3000;
  while (processAlive(stubborn.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(processAlive(stubborn.pid), false, "the TERM-ignoring server was killed");
  assert.ok(Date.now() - started < 3000);
  // Nothing from the log line above names a token or a login; the helper
  // only ever forwards the server's own JSON answer.
  assert.doesNotMatch(readFileSync(log, "utf8"), /auth\.json|token/u);
});

test("the role sets the default lease and any turn may override it", () => {
  assert.deepEqual(resolveWrite("peer", {}), { write: false });
  assert.deepEqual(resolveWrite("executor", {}), { write: true });
  assert.deepEqual(resolveWrite("peer", { write: true }), { write: true });
  assert.deepEqual(resolveWrite("executor", { readOnly: true }), { write: false });
  assert.match(resolveWrite("peer", { write: true, readOnly: true }).error, /contradict/u);
});

test("the command dispatcher runs when the helper is invoked through a symlink", () => {
  const linkedHelper = join(root, "pair-headless-linked.mjs");
  symlinkSync(helper, linkedHelper);
  const repo = newRepo("symlink-dispatch");

  const created = runThrough(linkedHelper, "ok", "claude", "init", "--repo", repo, "--partner", "codex");
  assert.equal(created.receipt.status, "created");
  const sent = runThrough(
    linkedHelper,
    "ok",
    "claude",
    "send",
    "--repo",
    repo,
    "--kind",
    "task",
    "--body-file",
    bodyFile("run through the link"),
  );
  assert.equal(sent.receipt.status, "replied");
});

test("git worktrees and plain directories get stable, separate state locations", () => {
  const plain = join(root, "not-a-repo");
  mkdirSync(plain, { recursive: true });
  const plainPlace = locate(plain, root, "");
  const plainHash = createHash("sha256").update(realpathSync(plain)).digest("hex").slice(0, 12);
  assert.equal(
    plainPlace.statePath,
    join(root, ".local", "state", "pair", `not-a-repo-${plainHash}`, "session.json"),
  );
  assert.equal(plainPlace.root, realpathSync(plain));
  const repo = newRepo("located");
  const place = locate(repo);
  assert.equal(place.error, undefined);
  assert.match(place.statePath, /\.git\/pair\/session\.json$/u);
  assert.match(place.transcripts, /\.git\/pair\/transcripts$/u);
});

test("a plain directory honors XDG_STATE_HOME", () => {
  const plain = join(root, "xdg-state-directory");
  const stateHome = join(root, "redirected-state");
  mkdirSync(plain, { recursive: true });
  const plainHash = createHash("sha256").update(realpathSync(plain)).digest("hex").slice(0, 12);

  const place = locate(plain, join(root, "unused-home"), stateHome);

  assert.equal(
    place.statePath,
    join(stateHome, "pair", `xdg-state-directory-${plainHash}`, "session.json"),
  );

  const created = JSON.parse(execFileSync(
    process.execPath,
    [helper, "init", "--repo", plain, "--partner", "codex"],
    {
      encoding: "utf8",
      env: { ...env("ok", "claude"), XDG_STATE_HOME: stateHome },
    },
  ));
  assert.equal(created.state_file, place.statePath);
  const ended = JSON.parse(execFileSync(
    process.execPath,
    [helper, "end", "--repo", plain],
    {
      encoding: "utf8",
      env: { ...env("ok", "claude"), XDG_STATE_HOME: stateHome },
    },
  ));
  assert.equal(ended.status, "ended");
});

test("a plain directory supports the full headless pair lifecycle", () => {
  const plain = join(root, "plain-lifecycle");
  mkdirSync(plain, { recursive: true });
  const expectedPlace = locate(plain, root, "");

  const created = run("ok", "claude", "init", "--repo", plain, "--partner", "codex");
  assert.equal(created.receipt.status, "created");
  assert.equal(created.receipt.state_file, expectedPlace.statePath);
  const sent = run("ok", "claude", "send", "--repo", plain, "--kind", "task", "--body-file", bodyFile("plain task"), "--write");
  assert.equal(sent.receipt.status, "replied");
  assert.equal(sent.receipt.seq, 1);
  assert.ok(invocations()[0].argv.includes('sandbox_mode="danger-full-access"'));
  const status = run("ok", "claude", "status", "--repo", plain).receipt;
  assert.equal(status.sid, CODEX_SID);
  assert.equal(status.seq, 1);
  assert.equal(status.state_file, expectedPlace.statePath);
  const ended = run("ok", "claude", "end", "--repo", plain).receipt;
  assert.equal(ended.status, "ended");
  assert.equal(existsSync(expectedPlace.stateDir), false);
});

test("each turn's command matches the flags the installed CLIs accept", () => {
  const create = turnCommand({ partner: "codex", sid: null, resume: false, replyFile: "/r", root: "/repo", write: false });
  assert.deepEqual(create, {
    bin: "codex",
    args: ["exec", "-s", "read-only", "-C", "/repo", "--json", "-o", "/r", "-"],
    promptVia: "stdin",
  });
  // Model and effort are session settings: they go in when it is created.
  assert.deepEqual(
    turnCommand({ partner: "codex", sid: null, resume: false, replyFile: "/r", root: "/repo", write: false, model: "gpt-5", effort: "high" }).args,
    ["exec", "-s", "read-only", "-C", "/repo", "-m", "gpt-5", "-c", 'model_reasoning_effort="high"', "--json", "-o", "/r", "-"],
  );
  const resume = turnCommand({ partner: "codex", sid: "S", resume: true, replyFile: "/r", root: "/repo", write: true });
  // `codex exec resume` accepts neither -C nor -s, so the sandbox arrives as a
  // config override and the directory through the spawn's cwd. Writable turns
  // run the full bypass (danger-full-access) by the 2026-08-22 decision, and
  // force approval_policy=never because the machine config may keep approvals
  // on-request.
  assert.deepEqual(resume.args, [
    "exec",
    "resume",
    "S",
    "-c",
    'sandbox_mode="danger-full-access"',
    "-c",
    'approval_policy="never"',
    "--json",
    "-o",
    "/r",
    "-",
  ]);
  const claudeCreate = turnCommand({ partner: "claude", sid: null, resume: false, replyFile: "/r", root: "/repo", write: false });
  // stream-json, not json: a `json` run stays silent until it finishes, which
  // would make the idle deadline kill a long working turn.
  assert.deepEqual(claudeCreate.args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.ok(claudeCreate.args.includes("--strict-mcp-config"));
  assert.equal(claudeCreate.args.at(-1), "plan");
  const claudeResume = turnCommand({ partner: "claude", sid: "S", resume: true, replyFile: "/r", root: "/repo", write: true });
  assert.deepEqual(claudeResume.args.slice(0, 3), ["-p", "--resume", "S"]);
  // acceptEdits alone lets a headless partner edit but never validate — every
  // Bash call would die on an approval nobody can give — so writable turns
  // bypass permissions outright.
  assert.deepEqual(claudeResume.args.slice(-2), ["--permission-mode", "bypassPermissions"]);
});

test("cursor, grok, and OpenCode turns carry each CLI's own mode and resume flags", () => {
  // `-p` writes by default, so read-only is the mode that has to be asked for.
  assert.deepEqual(
    turnCommand({ partner: "cursor", sid: null, resume: false, write: false, model: "claude-opus-4-8", effort: "high" }),
    {
      bin: "cursor-agent",
      args: ["-p", "--trust", "--output-format", "stream-json", "--model", "claude-opus-4-8[effort=high]", "--mode", "plan"],
      promptVia: "stdin",
    },
  );
  // --force is cursor's bypass; without it a writable headless turn stalls on
  // command approvals.
  assert.deepEqual(
    turnCommand({ partner: "cursor", sid: "chat-1", resume: true, write: true }).args,
    ["-p", "--trust", "--output-format", "stream-json", "--resume", "chat-1", "--force"],
  );
  // Cursor parameterizes the model itself, so effort has nowhere to go without one.
  assert.equal(cursorModel(null, "high"), null);
  assert.equal(cursorModel("m[context=1m]", "high"), "m[context=1m]");

  // Grok takes its prompt from a file and names a NEW session itself.
  assert.deepEqual(
    turnCommand({ partner: "grok", sid: "u-1", resume: false, promptFile: "/p", write: false, model: "grok-5", effort: "high" }),
    {
      bin: "grok",
      args: [
        "--prompt-file", "/p", "--output-format", "streaming-json", "--session-id", "u-1",
        "--permission-mode", "plan", "-m", "grok-5", "--reasoning-effort", "high",
      ],
      promptVia: "file",
    },
  );
  // Writable turns bypass and auto-approve together: acceptEdits made
  // grok 1.0.5 cancel its own tool calls with no user present, so both of
  // grok's asking paths are closed.
  assert.deepEqual(
    turnCommand({ partner: "grok", sid: "u-1", resume: true, promptFile: "/p", write: true }).args,
    ["--prompt-file", "/p", "--output-format", "streaming-json", "--resume", "u-1", "--permission-mode", "bypassPermissions", "--always-approve"],
  );

  // OpenCode takes the prompt as the final argv item, which the runner adds
  // after these flags. Its JSON events carry the session id and text reply.
  assert.deepEqual(
    turnCommand({
      partner: "opencode",
      sid: null,
      resume: false,
      root: "/repo",
      write: false,
      model: "provider/model",
      effort: "high",
    }),
    {
      bin: "opencode",
      args: [
        "run", "--format", "json", "--dir", "/repo", "-m", "provider/model",
        "--variant", "high", "--agent", "plan",
      ],
      promptVia: "argv",
    },
  );
  assert.deepEqual(
    turnCommand({
      partner: "opencode",
      sid: "ses_1",
      resume: true,
      root: "/repo",
      write: true,
      model: "ignored/on-resume",
      effort: "max",
    }).args,
    ["run", "--format", "json", "--dir", "/repo", "--session", "ses_1", "--variant", "max", "--auto"],
  );
  assert.match(newSessionId("grok"), /^[0-9a-f-]{36}$/u);
  for (const partner of ["claude", "codex", "cursor", "opencode"]) assert.equal(newSessionId(partner), null);
});

test("every flag the five CLIs are sent is one they accept", (t) => {
  // Both leases per CLI: the writable bypass flags (--force, --always-approve,
  // --auto) only appear on write turns, so a read-only-only sweep never
  // exercises them against the installed help.
  const surfaces = [
    ["cursor-agent", ["--help"], turnCommand({ partner: "cursor", sid: "S", resume: true, write: false }).args],
    ["cursor-agent", ["--help"], turnCommand({ partner: "cursor", sid: "S", resume: true, write: true }).args],
    ["grok", ["--help"], turnCommand({ partner: "grok", sid: "S", resume: true, promptFile: "/p", write: false }).args],
    ["grok", ["--help"], turnCommand({ partner: "grok", sid: "S", resume: true, promptFile: "/p", write: true }).args],
    ["opencode", ["run", "--help"], turnCommand({ partner: "opencode", sid: "S", resume: true, root: "/repo", write: false, effort: "high" }).args],
    ["opencode", ["run", "--help"], turnCommand({ partner: "opencode", sid: "S", resume: true, root: "/repo", write: true, effort: "high" }).args],
  ];
  for (const [binary, helpArgs, args] of surfaces) {
    const help = spawnSync(binary, helpArgs, { encoding: "utf8" });
    if (help.status !== 0) {
      t.diagnostic(`${binary} is not installed`);
      continue;
    }
    const helpText = `${help.stdout ?? ""}${help.stderr ?? ""}`;
    const accepted = new Set(helpText.match(/--[a-z][a-z-]+/gu));
    accepted.add("-p");
    accepted.add("-m");
    for (const token of args.filter((part) => part.startsWith("-"))) {
      assert.ok(accepted.has(token), `${binary} does not accept ${token}`);
    }
    const expectedFormat = binary === "grok" ? "streaming-json" : binary === "opencode" ? "json" : "stream-json";
    assert.match(helpText, new RegExp(`\\b${expectedFormat}\\b`, "u"));
  }
});

test("every flag the helper sends is one the installed CLIs accept", (t) => {
  const help = spawnSync("codex", ["exec", "resume", "--help"], { encoding: "utf8" });
  if (help.status !== 0) return t.skip("codex is not installed");
  const accepted = new Set(help.stdout.match(/--[a-z][a-z-]+/gu));
  accepted.add("-c");
  accepted.add("-o");
  for (const write of [false, true]) {
    const { args } = turnCommand({ partner: "codex", sid: "S", resume: true, replyFile: "/r", root: "/repo", write });
    for (const token of args.filter((part) => part.startsWith("-") && part !== "-")) {
      assert.ok(accepted.has(token), `codex exec resume does not accept ${token}`);
    }
  }
  assert.match(help.stdout, /--json[\s\S]*JSONL/u);

  const claudeHelp = spawnSync("claude", ["--help"], { encoding: "utf8" });
  if (claudeHelp.status !== 0) return t.skip("claude is not installed");
  const claudeAccepted = new Set(claudeHelp.stdout.match(/--[a-z][a-z-]+/gu));
  claudeAccepted.add("-p");
  const claudeArgs = turnCommand({ partner: "claude", sid: "S", resume: true, replyFile: "/r", root: "/repo", write: true }).args;
  for (const token of claudeArgs.filter((part) => part.startsWith("-"))) {
    assert.ok(claudeAccepted.has(token), `claude does not accept ${token}`);
  }
  assert.ok(
    /stream-json/u.test(claudeHelp.stdout),
    "claude must still offer stream-json — it is what makes the idle deadline measure real liveness",
  );
});

test("session ids come out of each CLI's own report", () => {
  assert.equal(parseSessionId("codex", '{"type":"thread.started","thread_id":"abc-123"}'), "abc-123");
  assert.equal(parseSessionId("codex", "no id here"), null);
  assert.equal(parseSessionId("claude", `noise\n${JSON.stringify({ type: "result", session_id: "s1", result: "hi" })}`), "s1");
  assert.equal(
    parseSessionId("opencode", JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } })),
    "ses_1",
  );
  assert.equal(parseClaudeResult("not json"), null);
});

test("the claude reply comes from the final result event, never the init event", () => {
  // A realistic stream-json transcript: the system init event carries a
  // session_id of its own, so a reader that takes the first id it sees reports
  // the wrong session and no reply at all.
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "init-event-id", tools: ["Read"] }),
    JSON.stringify({ type: "assistant", session_id: "init-event-id", message: { content: [{ type: "text", text: "looking" }] } }),
    JSON.stringify({ type: "user", session_id: "init-event-id", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    JSON.stringify({ type: "result", subtype: "success", session_id: "final-result-id", is_error: false, result: "[agent claude -> codex kind=ready sid=S]\n\nreviewed" }),
    "",
  ].join("\n");
  const parsed = parseClaudeResult(stream);
  assert.equal(parsed.type, "result");
  assert.equal(parsed.session_id, "final-result-id");
  assert.match(parsed.result, /reviewed$/u);
  assert.equal(parseSessionId("claude", stream), "final-result-id");
  assert.equal(parsed.is_error, false);

  const errored = parseClaudeResult(
    `${JSON.stringify({ type: "system", session_id: "init-event-id" })}\n${JSON.stringify({ type: "result", session_id: "final-result-id", is_error: true, result: "refused" })}`,
  );
  assert.equal(errored.is_error, true);

  // A run that died before its result event still names the session it left.
  assert.equal(parseSessionId("claude", JSON.stringify({ type: "system", subtype: "init", session_id: "init-event-id" })), "init-event-id");
});

test("a deadline that is not a positive number is a usage error", () => {
  assert.match(minutesToMs("abc", "idle-min").error, /--idle-min must be a positive number of minutes, got abc/u);
  assert.match(minutesToMs("0", "idle-min").error, /positive number/u);
  assert.match(minutesToMs("-3", "total-min").error, /--total-min/u);
  assert.match(minutesToMs("", "idle-min").error, /positive number/u);
  assert.match(minutesToMs("Infinity", "idle-min").error, /positive number/u);
  assert.equal(minutesToMs("0.5", "idle-min").ms, 30000);

  const repo = newRepo("deadline-guard");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  const bad = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("go"), "--idle-min", "abc");
  assert.equal(bad.receipt.ok, false);
  assert.match(bad.receipt.reason, /--idle-min must be a positive number/u);
  // The refusal happens before anything is spawned or recorded.
  assert.deepEqual(invocations(), []);
  assert.equal(JSON.parse(readFileSync(join(realpathSync(repo), ".git", "pair", "session.json"), "utf8")).seq, 0);
});

test("writable task turns get a larger default idle budget", () => {
  assert.equal(defaultIdleMinutes({ kind: "task", write: true }), 45);
  assert.equal(defaultIdleMinutes({ kind: "task", write: false }), 20);
  assert.equal(defaultIdleMinutes({ kind: "review", write: true }), 20);
  assert.equal(defaultIdleMinutes(), 20);
});

test("the bootstrap and message prompts carry the protocol literally", () => {
  const boot = bootstrapPrompt({ self: "claude", partner: "codex", root: "/repo" });
  assert.match(boot, /\[agent <from> -> <to> kind=<kind> sid=<sid>\]/u);
  assert.match(boot, /half-duplex/u);
  assert.match(boot, /write lease/u);
  assert.match(boot, /keep tool output flowing so the idle watchdog can see progress/u);
  for (const kind of ["task", "review", "question", "ready", "accepted", "blocked", "stalemate", "handoff"]) {
    assert.match(boot, new RegExp(`\\b${kind}\\b`, "u"));
  }
  assert.equal(
    messagePrompt({ self: "claude", partner: "codex", kind: "task", sid: "S", body: "split the work\n\n" }),
    "[agent claude -> codex kind=task sid=S]\n\nsplit the work\n",
  );
});

test("a positive absence is the only thing that discards a recorded session", () => {
  const store = join(root, "codex-home", "sessions", "2026", "08");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, `rollout-2026-08-14T10-00-00-${CODEX_SID}.jsonl`), "{}\n");
  const codexEnv = { CODEX_HOME: join(root, "codex-home") };
  assert.equal(sessionKnown("codex", CODEX_SID, "/repo", codexEnv, root), true);
  assert.equal(sessionKnown("codex", "no-such-sid", "/repo", codexEnv, root), false);
  // An unreadable store cannot disprove the session, so the pair keeps it.
  assert.equal(sessionKnown("codex", "no-such-sid", "/repo", { CODEX_HOME: join(root, "absent") }, root), true);

  const home = join(root, "claude-home");
  mkdirSync(join(home, ".claude", "projects", "-repo-work"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", "-repo-work", `${CLAUDE_SID}.jsonl`), "{}\n");
  assert.equal(sessionKnown("claude", CLAUDE_SID, "/repo/work", {}, home), true);
  assert.equal(sessionKnown("claude", "other", "/repo/work", {}, home), false);
});

test("an unreadable session store never reads as an absent session", (t) => {
  const sealed = join(root, "sealed-home", "sessions");
  mkdirSync(sealed, { recursive: true });
  chmodSync(sealed, 0o000);
  t.after(() => chmodSync(sealed, 0o755));
  try {
    readdirSync(sealed);
    return t.skip("this user can read a 000 directory");
  } catch {
    /* the store is genuinely unreadable, which is the case under test */
  }
  // The store exists but cannot be walked, so the recorded session survives:
  // reporting "absent" here would make init replace a live session.
  assert.equal(sessionKnown("codex", "any-sid", "/repo", { CODEX_HOME: join(root, "sealed-home") }, root), true);
});

test("an unreadable claude store never reads as an absent session", (t) => {
  // existsSync answers false for a path it was not allowed to look at, so an
  // EACCES here used to read as a positive absence and discard a live session.
  const home = join(root, "sealed-claude-home");
  const projects = join(home, ".claude", "projects");
  mkdirSync(join(projects, "-repo-work"), { recursive: true });
  writeFileSync(join(projects, "-repo-work", `${CLAUDE_SID}.jsonl`), "{}\n");
  assert.equal(sessionKnown("claude", CLAUDE_SID, "/repo/work", {}, home), true);
  assert.equal(sessionKnown("claude", "other", "/repo/work", {}, home), false);

  chmodSync(join(projects, "-repo-work"), 0o000);
  t.after(() => {
    // The parent has to be searchable again before its child can be chmodded.
    chmodSync(projects, 0o755);
    chmodSync(join(projects, "-repo-work"), 0o755);
  });
  try {
    readdirSync(join(projects, "-repo-work"));
    return t.skip("this user can read a 000 directory");
  } catch {
    /* the project directory is genuinely unreadable, which is the case under test */
  }
  assert.equal(sessionKnown("claude", "other", "/repo/work", {}, home), true);

  chmodSync(projects, 0o000);
  assert.equal(sessionKnown("claude", CLAUDE_SID, "/repo/work", {}, home), true);
});

test("init creates the session, records it, and is idempotent afterwards", () => {
  const repo = newRepo("init-codex");
  const created = run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  assert.equal(created.receipt.ok, true);
  assert.equal(created.receipt.status, "created");
  assert.equal(created.receipt.sid, CODEX_SID);
  assert.equal(created.receipt.partner, "codex");
  assert.equal(created.receipt.state_file, join(realpathSync(repo), ".git", "pair", "session.json"));
  const first = invocations();
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].argv.slice(0, 3), ["exec", "-s", "read-only"]);
  assert.match(first[0].stdin, /You are the pair partner for a claude lead/u);

  const state = JSON.parse(readFileSync(created.receipt.state_file, "utf8"));
  assert.deepEqual(
    { partner: state.partner, self: state.self, sid: state.sid, seq: state.seq },
    { partner: "codex", self: "claude", sid: CODEX_SID, seq: 0 },
  );

  // The second init spends no partner turn: the recorded session is resumed.
  const again = run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  assert.equal(again.receipt.status, "resumed");
  assert.equal(again.receipt.sid, CODEX_SID);
  assert.deepEqual(invocations(), []);
});

test("send resumes the exact session, sequences it, and returns the reply", () => {
  const repo = newRepo("send-codex");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  const sent = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("own scripts/"));
  assert.equal(sent.receipt.ok, true);
  assert.equal(sent.receipt.status, "replied");
  assert.equal(sent.receipt.seq, 1);
  assert.match(sent.receipt.reply, /lease accepted/u);
  assert.equal(readFileSync(sent.receipt.reply_file, "utf8").trim().split("\n").at(-1), "lease accepted");
  assert.ok(existsSync(sent.receipt.transcript));

  const [call] = invocations();
  assert.deepEqual(call.argv.slice(0, 5), ["exec", "resume", CODEX_SID, "-c", 'sandbox_mode="read-only"']);
  // No -C on `codex exec resume`: the repository has to arrive as the cwd.
  assert.equal(call.cwd, spawnSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim());
  assert.equal(call.stdin, `[agent claude -> codex kind=task sid=${CODEX_SID}]\n\nown scripts/\n`);

  const second = run("ok", "claude", "send", "--repo", repo, "--kind", "review", "--body-file", bodyFile("look"));
  assert.equal(second.receipt.seq, 2);
});

test("--write is the only thing that lifts the sandbox for a turn", () => {
  const repo = newRepo("write-lease");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("implement"), "--write");
  // Writable turns run the full bypass — no writable-roots plumbing to get
  // wrong per machine — and only --write selects it.
  assert.deepEqual(invocations()[0].argv.slice(3, 7), ["-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"']);
  const reviewed = run("ok", "claude", "send", "--repo", repo, "--kind", "review", "--body-file", bodyFile("look"));
  assert.equal(reviewed.receipt.write, false);
  assert.deepEqual(invocations()[0].argv.slice(3, 5), ["-c", 'sandbox_mode="read-only"']);
});

test("a linked worktree holds its own pair session", () => {
  const { repo, worktree } = newLinkedWorktree("linked-state");
  run("ok", "claude", "init", "--repo", worktree, "--partner", "codex");
  const place = locate(worktree);
  assert.ok(place.stateDir.includes(join(".git", "worktrees")), `worktree state stays in its own git dir: ${place.stateDir}`);
  // The main checkout is a different pair slot: no session recorded there.
  const status = run("ok", "claude", "status", "--repo", repo).receipt;
  assert.match(status.reason, /no pair session/u);
});

test("send refuses a body or kind the protocol does not define", () => {
  const repo = newRepo("send-guards");
  const noSession = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("x"));
  assert.match(noSession.receipt.reason, /no pair session/u);
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  const badKind = run("ok", "claude", "send", "--repo", repo, "--kind", "gossip", "--body-file", bodyFile("x"));
  assert.match(badKind.receipt.reason, /unknown kind gossip/u);
  const empty = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("   \n"));
  assert.match(empty.receipt.reason, /body file is empty/u);
  const missing = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", join(root, "absent.md"));
  assert.match(missing.receipt.reason, /no body file/u);
});

test("a clean exit with nothing in it is a failed turn, not a reply", () => {
  const repo = newRepo("empty-reply");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  const empty = run("empty", "claude", "send", "--repo", repo, "--kind", "question", "--body-file", bodyFile("q"));
  assert.equal(empty.receipt.ok, false);
  assert.equal(empty.receipt.status, "empty-reply");
  assert.equal(empty.receipt.exit_code, 0);
});

test("a nonzero exit fails the turn and keeps the transcript", () => {
  const repo = newRepo("failed-turn");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  const failed = run("fail", "claude", "send", "--repo", repo, "--kind", "question", "--body-file", bodyFile("q"));
  assert.equal(failed.receipt.status, "failed");
  assert.match(readFileSync(failed.receipt.transcript, "utf8"), /rate limit/u);
});

test("a partner that cannot spawn returns a failed receipt before running", (t) => {
  const repo = newRepo("spawn-failure");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  const binary = join(bin, "codex");
  const hidden = join(bin, "codex.hidden");
  renameSync(binary, hidden);
  t.after(() => renameSync(hidden, binary));
  let receipt;
  try {
    execFileSync(
      process.execPath,
      [helper, "send", "--repo", repo, "--kind", "question", "--body-file", bodyFile("q")],
      {
        encoding: "utf8",
        env: { ...env("ok", "claude"), PATH: `${bin}:/usr/bin:/bin` },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    receipt = JSON.parse(error.stdout);
  }
  assert.equal(receipt.status, "failed");
  assert.ok(receipt.reason.startsWith(`cannot run ${binary}:`), receipt.reason);
  assert.equal(existsSync(join(realpathSync(repo), ".git", "pair", "in-flight.json")), false);
});

test("init fails loudly when the CLI reports no resumable session", () => {
  const repo = newRepo("no-sid");
  const receipt = run("nosid", "claude", "init", "--repo", repo, "--partner", "codex").receipt;
  assert.equal(receipt.ok, false);
  assert.match(receipt.reason, /no session id/u);
  assert.equal(existsSync(join(repo, ".git", "pair", "session.json")), false);
});

test("a hung turn is killed on its idle deadline", () => {
  const repo = newRepo("hang");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  const hung = run("hang", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("q"), "--idle-min", "0.05");
  assert.equal(hung.receipt.status, "hang-killed");
  assert.match(hung.receipt.reason, /hang: no output for/u);
});

test("stream activity keeps a turn alive past its idle window", () => {
  const repo = newRepo("stream-liveness");
  run("ok", "claude", "init", "--repo", repo, "--partner", "grok");
  const receipt = run(
    "live",
    "claude",
    "send",
    "--repo",
    repo,
    "--kind",
    "question",
    "--body-file",
    bodyFile("keep streaming"),
    "--idle-min",
    "0.01",
  ).receipt;
  assert.equal(receipt.status, "replied");
  assert.match(receipt.reply, /grok reviewed/u);
});

test("a killed stream keeps assistant text as a partial reply", () => {
  const repo = newRepo("partial-hang");
  run("ok", "claude", "init", "--repo", repo, "--partner", "grok");
  const receipt = run(
    "hang-partial",
    "claude",
    "send",
    "--repo",
    repo,
    "--kind",
    "task",
    "--body-file",
    bodyFile("work"),
    "--idle-min",
    "0.01",
  ).receipt;
  assert.equal(receipt.status, "hang-killed");
  assert.equal(receipt.partial_reply, true);
  assert.equal(readFileSync(receipt.reply_file, "utf8").trim(), "partial answer");
});

test("background send survives its launcher and wait reads the atomic receipt", () => {
  const repo = newRepo("background-send");
  run("ok", "claude", "init", "--repo", repo, "--partner", "grok");
  const running = run(
    "live",
    "claude",
    "send",
    "--repo",
    repo,
    "--kind",
    "question",
    "--body-file",
    bodyFile("background"),
    "--background",
    "--idle-min",
    "0.01",
  ).receipt;
  assert.equal(running.status, "running");
  assert.ok(running.supervisor_pid > 0);
  assert.ok(running.partner_pid > 0);
  const final = run("live", "claude", "wait", "--repo", repo, "--seq", String(running.seq), "--timeout-min", "0.1").receipt;
  assert.equal(final.status, "replied");
  assert.equal(JSON.parse(readFileSync(final.receipt_file, "utf8")).status, "replied");
  assert.equal(existsSync(join(realpathSync(repo), ".git", "pair", "in-flight.json")), false);
  const after = run("live", "claude", "wait", "--repo", repo, "--timeout-min", "0.1").receipt;
  assert.equal(after.status, "replied", "wait defaults to state.seq after the marker is gone");
});

test("the worker waits when it runs before the launcher publishes ownership", (t) => {
  const repo = newRepo("worker-first-handoff");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  process.env.PAIR_HEADLESS_TEST_HANDOFF_DELAY_MS = "250";
  t.after(() => delete process.env.PAIR_HEADLESS_TEST_HANDOFF_DELAY_MS);
  const receipt = run("ok", "claude", "send", "--repo", repo, "--kind", "question", "--body-file", bodyFile("race")).receipt;
  assert.equal(receipt.status, "replied");
  assert.equal(existsSync(join(realpathSync(repo), ".git", "pair", "in-flight.json")), false);
});

test("wait reports a lost supervisor without spending its timeout", () => {
  const repo = newRepo("worker-lost");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  const pairDir = join(realpathSync(repo), ".git", "pair");
  const statePath = join(pairDir, "session.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  writeFileSync(statePath, `${JSON.stringify({ ...state, seq: 1 }, null, 2)}\n`);
  writeFileSync(
    join(pairDir, "in-flight.json"),
    `${JSON.stringify({ seq: 1, supervisor_pid: 999999, partner_pid: null }, null, 2)}\n`,
  );
  const started = Date.now();
  const receipt = run("ok", "claude", "wait", "--repo", repo, "--timeout-min", "0.1").receipt;
  assert.equal(receipt.status, "worker-lost");
  assert.ok(Date.now() - started < 2000, "a dead worker returns before the wait timeout");
});

test("Grok cancellations are classified and two consecutive turns suggest a fork", () => {
  const repo = newRepo("grok-cancelled");
  run("ok", "claude", "init", "--repo", repo, "--partner", "grok");
  const send = () => run("cancel", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("continue")).receipt;
  const first = send();
  assert.equal(first.status, "failed");
  assert.equal(first.reason, "grok-cancelled");
  assert.equal(first.recovery, undefined);
  const second = send();
  assert.equal(second.reason, "grok-cancelled");
  assert.match(second.recovery, /two consecutive/u);
  const recovered = run("ok", "claude", "send", "--repo", repo, "--kind", "question", "--body-file", bodyFile("health")).receipt;
  assert.equal(recovered.status, "replied");
  assert.equal(run("ok", "claude", "status", "--repo", repo).receipt.grok_cancelled_consecutive, 0);
});

test("a scheduled Grok fork commits only after the new session is proved", () => {
  const repo = newRepo("grok-fork");
  const created = run("ok", "claude", "init", "--repo", repo, "--partner", "grok").receipt;
  const scheduled = run("ok", "claude", "fork", "--repo", repo).receipt;
  assert.equal(scheduled.status, "fork-scheduled");
  assert.equal(scheduled.sid, created.sid);
  const forked = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("continue")).receipt;
  assert.equal(forked.sid, scheduled.pending_sid);
  const call = invocations()[0];
  assert.deepEqual(
    call.argv.slice(2, 9),
    ["--output-format", "streaming-json", "--resume", created.sid, "--fork-session", "--session-id", scheduled.pending_sid],
  );
  assert.match(call.stdin, new RegExp(`Session fork: ${created.sid} is now ${scheduled.pending_sid}`, "u"));
  const status = run("ok", "claude", "status", "--repo", repo).receipt;
  assert.equal(status.sid, scheduled.pending_sid);
  assert.equal(status.pending_fork, null);
  assert.deepEqual(status.forked[0], {
    sid: created.sid,
    forked_at: status.forked[0].forked_at,
    successor_sid: scheduled.pending_sid,
  });
  assert.deepEqual(status.lineage, {
    current_sid: scheduled.pending_sid,
    forks: status.forked,
  });
  const resumed = run("ok", "claude", "send", "--repo", repo, "--kind", "question", "--body-file", bodyFile("again")).receipt;
  assert.equal(resumed.status, "replied");
  assert.ok(invocations()[0].argv.includes(scheduled.pending_sid));
});

test("a cancelled fork commits the proved new sid and ends the ladder at capability miss", () => {
  const repo = newRepo("grok-fork-cancelled");
  const created = run("ok", "claude", "init", "--repo", repo, "--partner", "grok").receipt;
  const scheduled = run("ok", "claude", "fork", "--repo", repo).receipt;
  const cancelled = run("cancel", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("continue")).receipt;
  assert.equal(cancelled.status, "failed");
  assert.equal(cancelled.reason, "grok-cancelled");
  // A fork is the cure for cancellations, so cancellation on the proved fresh
  // fork is the ladder's terminal state: restaff, never another fork.
  assert.match(cancelled.recovery, /capability miss[\s\S]*restaff[\s\S]*do not fork again/u);
  const status = run("ok", "claude", "status", "--repo", repo).receipt;
  assert.equal(status.sid, scheduled.pending_sid);
  assert.equal(status.pending_fork, null);
  assert.equal(status.grok_cancelled_consecutive, 1);
  assert.match(status.capability_miss, /fresh forked session/u);
  assert.deepEqual(status.forked.map(({ sid, successor_sid: successorSid }) => ({ sid, successorSid })), [
    { sid: created.sid, successorSid: scheduled.pending_sid },
  ]);
  const refused = run("ok", "claude", "fork", "--repo", repo).receipt;
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /capability miss[\s\S]*restaff/u);
  // A turn that fails for another reason proves nothing about the
  // cancellation behavior: the miss stays and fork stays refused.
  const failed = run("fail", "claude", "send", "--repo", repo, "--kind", "question", "--body-file", bodyFile("probe")).receipt;
  assert.equal(failed.status, "failed");
  assert.match(run("ok", "claude", "status", "--repo", repo).receipt.capability_miss, /fresh forked session/u);
  assert.match(run("ok", "claude", "fork", "--repo", repo).receipt.reason, /capability miss/u);
  // Only a successful replied turn is contrary evidence: it clears the miss
  // so a recovered session forks again.
  const recovered = run("ok", "claude", "send", "--repo", repo, "--kind", "question", "--body-file", bodyFile("health")).receipt;
  assert.equal(recovered.status, "replied");
  assert.equal(run("ok", "claude", "status", "--repo", repo).receipt.capability_miss, null);
  assert.equal(run("ok", "claude", "fork", "--repo", repo).receipt.status, "fork-scheduled");
});

test("cancellations recurring after a committed fork advise restaff, not another fork", () => {
  const repo = newRepo("grok-post-fork-cancels");
  run("ok", "claude", "init", "--repo", repo, "--partner", "grok");
  run("ok", "claude", "fork", "--repo", repo);
  const forked = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("continue")).receipt;
  assert.equal(forked.status, "replied");
  const send = () => run("cancel", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("go")).receipt;
  assert.equal(send().recovery, undefined);
  const second = send();
  // Without the fork history this would advise a fork; with it, the loop ends.
  assert.match(second.recovery, /capability miss[\s\S]*restaff[\s\S]*do not fork again/u);
  const refused = run("ok", "claude", "fork", "--repo", repo).receipt;
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /capability miss/u);
});

test("a failed fork keeps recovery state and retry chooses a fresh target", () => {
  const repo = newRepo("grok-fork-failure");
  run("ok", "claude", "init", "--repo", repo, "--partner", "grok");
  const first = run("ok", "claude", "fork", "--repo", repo).receipt;
  const failed = run("fail", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("fork now")).receipt;
  assert.equal(failed.status, "failed");
  const status = run("ok", "claude", "status", "--repo", repo).receipt;
  assert.notEqual(status.sid, first.pending_sid);
  assert.equal(status.pending_fork.new_sid, first.pending_sid);
  assert.equal(run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("unsafe retry")).receipt.ok, false);
  const retry = run("ok", "claude", "fork", "--repo", repo, "--retry").receipt;
  assert.notEqual(retry.pending_sid, first.pending_sid);
});

test("a Codex lead pairs with a headless Claude partner", () => {
  const repo = newRepo("claude-partner");
  const created = run("ok", "codex", "init", "--repo", repo, "--partner", "claude");
  assert.equal(created.receipt.partner, "claude");
  assert.equal(created.receipt.sid, CLAUDE_SID);
  const sent = run("ok", "codex", "send", "--repo", repo, "--kind", "review", "--body-file", bodyFile("review this"));
  assert.equal(sent.receipt.status, "replied");
  assert.match(readFileSync(sent.receipt.reply_file, "utf8"), /reviewed/u);
  const [call] = invocations();
  assert.deepEqual(call.argv.slice(0, 3), ["-p", "--resume", CLAUDE_SID]);
  assert.equal(call.stdin, `[agent codex -> claude kind=review sid=${CLAUDE_SID}]\n\nreview this\n`);
  const errored = run("error", "codex", "send", "--repo", repo, "--kind", "question", "--body-file", bodyFile("q"));
  assert.equal(errored.receipt.status, "failed");
  assert.match(errored.receipt.reason, /is_error/u);
});

test("a cursor partner's chat id comes out of its JSON, and its reply with it", () => {
  const repo = newRepo("cursor-partner");
  const created = run("ok", "claude", "init", "--repo", repo, "--partner", "cursor").receipt;
  assert.equal(created.partner, "cursor");
  assert.equal(created.sid, CURSOR_SID);
  const [boot] = invocations();
  assert.deepEqual(boot.argv, ["-p", "--trust", "--output-format", "stream-json", "--mode", "plan"]);
  const sent = run("ok", "claude", "send", "--repo", repo, "--kind", "review", "--body-file", bodyFile("read it"));
  assert.equal(sent.receipt.status, "replied");
  assert.match(sent.receipt.reply, /cursor reviewed/u);
  assert.deepEqual(invocations()[0].argv, ["-p", "--trust", "--output-format", "stream-json", "--resume", CURSOR_SID, "--mode", "plan"]);
  assert.equal(invocations()[0].stdin, `[agent claude -> cursor kind=review sid=${CURSOR_SID}]\n\nread it\n`);
});

test("a grok partner is handed the session id it will resume, and reads its prompt from a file", () => {
  const repo = newRepo("grok-partner");
  const created = run("ok", "claude", "init", "--repo", repo, "--partner", "grok", "--role", "executor").receipt;
  assert.equal(created.partner, "grok");
  assert.match(created.sid, /^[0-9a-f-]{36}$/u);
  assert.equal(created.role, "executor");
  const [boot] = invocations();
  assert.deepEqual(boot.argv.slice(0, 6), ["--prompt-file", boot.argv[1], "--output-format", "streaming-json", "--session-id", created.sid]);
  assert.match(boot.stdin, /You are the executor/u);

  // An executor partner holds the write lease by default; the turn can still
  // take it back.
  const sent = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("implement")).receipt;
  assert.equal(sent.status, "replied");
  assert.equal(sent.write, true);
  const resumed = invocations()[0];
  assert.deepEqual(resumed.argv.slice(2), ["--output-format", "streaming-json", "--resume", created.sid, "--permission-mode", "bypassPermissions", "--always-approve"]);
  assert.equal(resumed.stdin, `[agent claude -> grok kind=task sid=${created.sid}]\n\nimplement\n`);
  const reviewed = run("ok", "claude", "send", "--repo", repo, "--kind", "review", "--body-file", bodyFile("look"), "--read-only").receipt;
  assert.equal(reviewed.write, false);
  assert.equal(invocations()[0].argv.at(-1), "plan");
  assert.equal(run("ok", "claude", "status", "--repo", repo).receipt.role, "executor");
});

test("an OpenCode partner captures its session and resumes with argv prompts", () => {
  const repo = newRepo("opencode-partner");
  const created = run(
    "ok",
    "claude",
    "init",
    "--repo",
    repo,
    "--partner",
    "opencode",
    "--model",
    "provider/model",
    "--effort",
    "high",
    "--role",
    "executor",
  ).receipt;
  assert.equal(created.partner, "opencode");
  assert.equal(created.sid, OPENCODE_SID);
  const [boot] = invocations();
  assert.deepEqual(boot.argv.slice(0, -1), [
    "run", "--format", "json", "--dir", realpathSync(repo), "-m", "provider/model",
    "--variant", "high", "--agent", "plan",
  ]);
  assert.match(boot.argv.at(-1), /You are the executor/u);
  assert.equal(boot.stdin, "");

  const sent = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("implement")).receipt;
  assert.equal(sent.status, "replied");
  assert.equal(sent.write, true);
  assert.match(sent.reply, /opencode reviewed/u);
  const resumed = invocations()[0];
  assert.deepEqual(resumed.argv.slice(0, -1), [
    "run", "--format", "json", "--dir", realpathSync(repo), "--session", OPENCODE_SID,
    "--variant", "high", "--auto",
  ]);
  assert.equal(resumed.argv.at(-1), `[agent claude -> opencode kind=task sid=${OPENCODE_SID}]\n\nimplement\n`);
  assert.equal(resumed.stdin, "");

  const reviewed = run(
    "ok",
    "claude",
    "send",
    "--repo",
    repo,
    "--kind",
    "review",
    "--body-file",
    bodyFile("inspect"),
    "--read-only",
  ).receipt;
  assert.equal(reviewed.write, false);
  assert.deepEqual(invocations()[0].argv.slice(-5, -1), ["--variant", "high", "--agent", "plan"]);
});

test("init refuses a partner the lead is already running and invalid settings", () => {
  const repo = newRepo("same-cli");
  const refused = run("ok", "claude", "init", "--repo", repo, "--partner", "claude").receipt;
  assert.match(refused.reason, /refusing to pair claude with itself/u);
  assert.deepEqual(invocations(), []);
  const missing = run("ok", "claude", "init", "--repo", repo).receipt;
  assert.match(missing.reason, /missing --partner/u);
  const claudeEffortRepo = newRepo("claude-effort");
  const claudeEffort = run("ok", "codex", "init", "--repo", claudeEffortRepo, "--partner", "claude", "--effort", "high").receipt;
  assert.equal(claudeEffort.effort, "high");
  assert.ok(invocations()[0].argv.includes("--effort"));
  const bareEffort = run("ok", "claude", "init", "--repo", repo, "--partner", "cursor", "--effort", "high").receipt;
  assert.match(bareEffort.reason, /--effort needs --model/u);
  const badRole = run("ok", "claude", "init", "--repo", repo, "--partner", "codex", "--role", "boss").receipt;
  assert.match(badRole.reason, /unknown role boss/u);
});

test("cursor, grok, and OpenCode replies are lifted out of the run's own output", () => {
  assert.equal(parseCursorSessionId('{"type":"result","chat_id":"c-1","result":"hi"}'), "c-1");
  assert.equal(parseCursorSessionId("no json here"), null);
  assert.equal(parseCursorSessionId('{"type":"result","session_id":"c-2","result":"ok"}'), "c-2");
  assert.equal(parseCursorSessionId('{"type":"tool","id":"not-a-chat"}'), null);
  assert.equal(parseTextReply('{"response":"first"}\n{"response":"last"}'), "last");
  assert.equal(parseTextReply('{"response":""}'), null);
  assert.deepEqual(
    parseGrokStream('{"type":"thought","data":"hidden"}\n{"type":"text","data":"hello "}\n{"type":"text","data":"world"}\n{"type":"end","stopReason":"end_turn","sessionId":"g-1"}'),
    { reply: "hello world", stopReason: "end_turn", sessionId: "g-1" },
  );
  assert.deepEqual(
    parseOpenCodeStream([
      JSON.stringify({ type: "step_start", sessionID: "ses_1", part: { type: "step-start", sessionID: "ses_1" } }),
      JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", sessionID: "ses_1", text: "hello " } }),
      JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", sessionID: "ses_1", text: "world" } }),
    ].join("\n")),
    { reply: "hello world", sessionId: "ses_1" },
  );
  assert.equal(parseSessionId("grok", "anything at all"), null);
});

test("recorded live stream fixtures keep each parser on its partner's schema", () => {
  const grok = parseGrokStream(readFileSync(join(fixtures, "grok-stream-complete.jsonl"), "utf8"));
  assert.deepEqual(grok, {
    reply: "[agent grok -> claude kind=ready sid=g-1]\n\ndone",
    stopReason: "end_turn",
    sessionId: "g-1",
  });
  const incomplete = parseGrokStream(readFileSync(join(fixtures, "grok-stream-incomplete.jsonl"), "utf8"));
  assert.deepEqual(incomplete, { reply: "partial result", stopReason: null, sessionId: null });
  const cancelled = parseGrokStream(readFileSync(join(fixtures, "grok-stream-cancelled.jsonl"), "utf8"));
  assert.deepEqual(cancelled, { reply: null, stopReason: "cancelled", sessionId: "g-2" });

  const cursor = readFileSync(join(fixtures, "cursor-stream.jsonl"), "utf8");
  assert.equal(parseCursorSessionId(cursor), "cursor-1");
  assert.match(parseTextReply(cursor), /done$/u);
  const opencode = readFileSync(join(fixtures, "opencode-stream.jsonl"), "utf8");
  assert.deepEqual(parseOpenCodeStream(opencode), {
    reply: "[agent opencode -> claude kind=ready sid=ses_live_1]\n\ndone",
    sessionId: "ses_live_1",
  });
  assert.equal(extractReply("opencode", join(root, "unused"), opencode), "[agent opencode -> claude kind=ready sid=ses_live_1]\n\ndone");
  const codex = readFileSync(join(fixtures, "codex-stream.jsonl"), "utf8");
  assert.equal(parseSessionId("codex", codex), "codex-1");
  assert.equal(extractReply("codex", join(root, "no-codex-reply"), codex), "done");
  assert.equal(
    extractReply("cursor", join(root, "unused"), '{"type":"assistant","message":{"content":[{"type":"text","text":"cursor partial"}]}}'),
    "cursor partial",
  );
  assert.equal(
    extractReply("claude", join(root, "unused"), '{"type":"assistant","message":{"content":[{"type":"text","text":"claude partial"}]}}'),
    "claude partial",
  );
});

test("partner session stores answer the same positive-absence rule", () => {
  const home = join(root, "store-home");
  mkdirSync(join(home, ".cursor", "chats", "abc123", CURSOR_SID), { recursive: true });
  assert.equal(sessionKnown("cursor", CURSOR_SID, "/repo", {}, home), true);
  assert.equal(sessionKnown("cursor", "no-such-chat", "/repo", {}, home), false);

  const grokHome = join(home, ".grok");
  mkdirSync(join(grokHome, "sessions", "%2Fworkspace"), { recursive: true });
  writeFileSync(join(grokHome, "sessions", "%2Fworkspace", "session-uuid-1"), "{}\n");
  assert.equal(sessionKnown("grok", "session-uuid-1", "/repo", { GROK_HOME: grokHome }, home), true);
  assert.equal(sessionKnown("grok", "other", "/repo", { GROK_HOME: grokHome }, home), false);
  // A store that is not there at all cannot disprove anything.
  assert.equal(sessionKnown("grok", "other", "/repo", { GROK_HOME: join(root, "absent") }, home), true);
  assert.equal(sessionKnown("cursor", "other", "/repo", {}, join(root, "absent-home")), true);
  assert.equal(sessionKnown("opencode", "ses_any", "/repo", {}, home), true);
});

test("the lock is published by a link, so a collision is decided by the kernel", () => {
  const lockDir = join(root, "lock-unit");
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, "in-flight.json");
  const temps = () => readdirSync(lockDir).filter((name) => name.endsWith(".tmp"));
  const mine = { seq: 7, pid: process.pid, child_pid: null, started_at: "2026-08-14T10:00:00.000Z" };
  const first = acquireMarker(lockPath, mine);
  assert.deepEqual(first, { acquired: mine });
  // The link publishes the whole marker at once — there is no moment when the
  // lock exists but its content does not.
  assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), mine);
  assert.deepEqual(temps(), [], "a successful acquire leaves no temp file behind");

  // The second creator loses on EEXIST — never on a read it did before writing.
  const second = acquireMarker(lockPath, { seq: 8, pid: process.pid, child_pid: null, started_at: "x" });
  assert.equal(second.acquired, undefined);
  assert.equal(second.holder.seq, 7);
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).seq, 7, "a refused acquire leaves the holder's marker intact");
  assert.deepEqual(temps(), [], "a refused acquire leaves no temp file behind");

  // A dead holder is reported, never taken over: removing another run's marker
  // needs a compare-and-remove that `unlink` does not have, so two contenders
  // reading one dead marker could both delete and both acquire.
  const dead = { seq: 7, pid: 999999, child_pid: null, started_at: "x" };
  writeFileSync(lockPath, JSON.stringify(dead));
  const refusedDead = acquireMarker(lockPath, { seq: 8, pid: process.pid, child_pid: null, started_at: "y" });
  assert.equal(refusedDead.acquired, undefined);
  assert.deepEqual(refusedDead.dead, dead);
  assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), dead, "acquire never removes a marker");
  assert.deepEqual(temps(), [], "a refused dead marker leaves no temp file behind");
  unlinkSync(lockPath);
});

test("a marker that cannot be read is busy, never wreckage", () => {
  const lockDir = join(root, "lock-unreadable");
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, "in-flight.json");
  const mine = { seq: 2, pid: process.pid, child_pid: null, started_at: "x" };

  // A winner caught mid-write looks exactly like this: the file exists and its
  // content does not parse. Every pid in it is dead, so the old reader called
  // it stale and overwrote a live lock.
  for (const garbage of ["", "   ", '{"seq": 1, "pid": 99', "not json at all"]) {
    writeFileSync(lockPath, garbage);
    const refused = acquireMarker(lockPath, mine);
    assert.deepEqual(refused, { unreadable: true }, `content ${JSON.stringify(garbage)} must refuse as busy`);
    assert.equal(readFileSync(lockPath, "utf8"), garbage, "a refusal never rewrites the holder's file");
    assert.deepEqual(readdirSync(lockDir).filter((name) => name.endsWith(".tmp")), []);
  }

  // A parsed marker with provably dead pids is classified, not guessed at.
  writeFileSync(lockPath, JSON.stringify({ seq: 1, pid: 999999, child_pid: 999998, started_at: "x" }));
  assert.equal(acquireMarker(lockPath, mine).dead.seq, 1);
  unlinkSync(lockPath);
});

test("clear removes a dead marker by rename, so a concurrent clear loses cleanly", () => {
  const lockDir = join(root, "clear-unit");
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, "in-flight.json");
  const residue = () => readdirSync(lockDir).filter((name) => name !== "in-flight.json");
  const dead = { seq: 1, pid: 999999, child_pid: 999998, started_at: "x" };

  writeFileSync(lockPath, JSON.stringify(dead, null, 2));
  const cleared = clearMarker(lockPath);
  assert.equal(cleared.status, "cleared");
  assert.deepEqual(cleared.marker, dead);
  assert.equal(existsSync(lockPath), false);
  assert.deepEqual(residue(), [], "a cleared marker leaves no captured copy behind");

  // Rename is the one-winner primitive: whoever arrives second finds nothing.
  assert.deepEqual(clearMarker(lockPath), { status: "already-cleared" });

  // A live marker is not the caller's to remove.
  writeFileSync(lockPath, JSON.stringify({ seq: 2, pid: process.pid, child_pid: null, started_at: "y" }));
  assert.match(clearMarker(lockPath).error, /seq 2 is still in flight as pid \d+/u);
  writeFileSync(lockPath, JSON.stringify({ seq: 3, pid: 999999, child_pid: process.pid, started_at: "y" }));
  assert.match(clearMarker(lockPath).error, /still in flight/u, "a live CLI child holds the lock even when its helper is gone");

  // An unreadable marker stays for a human to look at.
  writeFileSync(lockPath, '{"seq": 4, "pid": 99');
  assert.match(clearMarker(lockPath).error, /cannot be read — inspect it by hand/u);
  assert.equal(existsSync(lockPath), true);
  assert.deepEqual(residue(), []);
  unlinkSync(lockPath);
});

test("clear restores a marker that changed between the judgement and the capture", () => {
  const lockDir = join(root, "clear-mismatch");
  mkdirSync(lockDir, { recursive: true });
  const lockPath = join(lockDir, "in-flight.json");
  const fresh = { seq: 9, pid: process.pid, child_pid: null, started_at: "live" };
  writeFileSync(lockPath, JSON.stringify({ seq: 8, pid: 999999, child_pid: null, started_at: "dead" }));

  // A send takes the lock in the window between reading the dead marker and
  // renaming it away — the ABA the rename alone cannot see.
  const outcome = clearMarker(lockPath, {
    beforeRename: () => {
      unlinkSync(lockPath);
      writeFileSync(lockPath, JSON.stringify(fresh));
    },
  });
  assert.match(outcome.error, /changed while it was being cleared, so it was put back/u);
  assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), fresh, "the live marker survives the clear");
  assert.deepEqual(
    readdirSync(lockDir).filter((name) => name !== "in-flight.json"),
    [],
    "a restored marker leaves no captured copy behind",
  );
  unlinkSync(lockPath);
});

test("the partner process decides whether a marker is live", () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(999999), false);
  assert.equal(processAlive(0), false);
  assert.equal(markerAlive(null), false);
  // A helper killed mid-turn leaves a live CLI still resuming the session, and
  // that turn must still refuse a second send.
  assert.equal(markerAlive({ pid: 999999, child_pid: process.pid }), true);
  assert.equal(markerAlive({ pid: 999999, child_pid: 999998 }), false);
  assert.equal(markerAlive({ pid: process.pid, child_pid: null }), true);
});

test("a marker is released only by the run that created it", () => {
  const lockPath = join(root, "release-lock.json");
  const mine = { seq: 3, pid: process.pid, child_pid: null, started_at: "x" };
  acquireMarker(lockPath, mine);
  // Another run's marker: neither the sequence nor the pid is ours.
  writeFileSync(lockPath, JSON.stringify({ seq: 4, pid: 4242, child_pid: null, started_at: "y" }));
  const refused = releaseMarker(lockPath, mine);
  assert.equal(refused.released, false);
  assert.match(refused.note, /owned by seq 4 pid 4242 — this turn was seq 3 pid \d+/u);
  assert.ok(existsSync(lockPath), "a marker this run does not own must survive");

  writeFileSync(lockPath, JSON.stringify(mine));
  assert.deepEqual(releaseMarker(lockPath, mine), { released: true });
  assert.equal(existsSync(lockPath), false);
  assert.deepEqual(releaseMarker(lockPath, mine), { released: false });
});

test("one turn at a time: a second send refuses against the in-flight marker", () => {
  const repo = newRepo("in-flight");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  const pairDir = join(realpathSync(repo), ".git", "pair");
  const statePath = join(pairDir, "session.json");
  const lockPath = join(pairDir, "in-flight.json");
  const markWith = (pid, childPid = null) =>
    writeFileSync(lockPath, JSON.stringify({ seq: 1, pid, child_pid: childPid, started_at: "2026-08-14T10:00:00.000Z" }, null, 2));

  markWith(process.pid); // a live turn
  const refused = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("second"));
  assert.equal(refused.receipt.ok, false);
  assert.match(refused.receipt.reason, /seq 1 is in flight as pid \d+/u);
  assert.match(refused.receipt.reason, /one turn at a time/u);
  assert.deepEqual(invocations(), []);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).seq, 0, "a refused send never burns a sequence number");

  // A dead helper that left a live CLI child behind is still a running turn.
  markWith(999999, process.pid);
  const refusedByChild = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("second"));
  assert.equal(refusedByChild.receipt.ok, false);
  assert.match(refusedByChild.receipt.reason, new RegExp(`in flight as pid ${process.pid}`, "u"));
  assert.deepEqual(invocations(), []);

  // A marker written by a run that has not finished publishing it must read as
  // busy: its pids are unknown, so calling it wreckage would clobber a live turn.
  writeFileSync(lockPath, '{"seq": 1, "pid": 999');
  const refusedUnreadable = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("second"));
  assert.equal(refusedUnreadable.receipt.ok, false);
  assert.match(refusedUnreadable.receipt.reason, /cannot be read, so a turn is treated as running/u);
  assert.deepEqual(invocations(), []);

  // Both gone: the marker is wreckage — but a send never removes another run's
  // marker, it names the one command that does.
  markWith(999999, 999998);
  const refusedDead = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("after the kill"));
  assert.equal(refusedDead.receipt.ok, false);
  assert.match(refusedDead.receipt.reason, /seq 1 was left in flight by pid 999998[\s\S]*none of its processes are alive/u);
  assert.match(refusedDead.receipt.reason, new RegExp(`clear --repo ${realpathSync(repo)}`, "u"));
  assert.deepEqual(invocations(), []);
  assert.equal(existsSync(lockPath), true, "a send never removes a marker it did not create");

  // Clearing it is what lets the next send through.
  const cleared = run("ok", "claude", "clear", "--repo", repo).receipt;
  assert.equal(cleared.status, "cleared");
  assert.equal(cleared.marker.seq, 1);
  assert.equal(existsSync(lockPath), false);
  const proceeded = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("after the clear"));
  assert.equal(proceeded.receipt.ok, true);
  assert.equal(proceeded.receipt.seq, 1);
  // The turn itself, then the pool read the receipt carries for a Codex partner.
  assert.deepEqual(invocations().map((call) => call.argv[0]), ["exec", "app-server"]);
  assert.deepEqual(
    readdirSync(pairDir).filter((name) => name.includes(".tmp") || name.includes(".cleared.")),
    [],
    "no acquire or clear path may leave a file behind in the pair directory",
  );

  // Nothing else in the session is the lock's business.
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.sid, CODEX_SID);
  assert.equal(state.seq, 1);
  assert.equal(run("ok", "claude", "clear", "--repo", repo).receipt.status, "already-cleared");
});

test("every terminal path clears the in-flight marker", () => {
  const repo = newRepo("in-flight-clear");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  const lockPath = join(realpathSync(repo), ".git", "pair", "in-flight.json");
  for (const [mode, status] of [["ok", "replied"], ["empty", "empty-reply"], ["fail", "failed"]]) {
    const receipt = run(mode, "claude", "send", "--repo", repo, "--kind", "question", "--body-file", bodyFile("q")).receipt;
    assert.equal(receipt.status, status);
    assert.equal(existsSync(lockPath), false, `${status} must leave no marker behind`);
    assert.equal(receipt.in_flight_note, undefined);
  }
  const hung = run("hang", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("q"), "--idle-min", "0.05");
  assert.equal(hung.receipt.status, "hang-killed");
  assert.equal(existsSync(lockPath), false);
});

test("the marker carries the partner process once it exists", () => {
  const repo = newRepo("marker-child");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  // The fake CLI writes the marker it finds to disk, which is the only way to
  // observe a marker that a completed turn has already cleared.
  const receipt = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("go")).receipt;
  assert.equal(receipt.status, "replied");
  const seen = JSON.parse(readFileSync(join(root, "marker-seen.json"), "utf8"));
  assert.equal(seen.seq, 1);
  assert.equal(seen.supervisor_pid > 0, true);
  assert.equal(Number.isInteger(seen.partner_pid), true, "the CLI's own pid must reach the marker while it runs");
  assert.notEqual(seen.partner_pid, seen.supervisor_pid);
});

test("a turn whose marker was replaced reports it instead of clearing someone else's", () => {
  const repo = newRepo("marker-stolen");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  const lockPath = join(realpathSync(repo), ".git", "pair", "in-flight.json");
  // STEAL_MARKER makes the fake CLI overwrite the marker mid-turn, standing in
  // for a stale takeover by another run while this one was still working.
  const receipt = run("steal", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("go")).receipt;
  assert.equal(receipt.status, "replied");
  assert.match(receipt.in_flight_note, /left an in-flight marker owned by seq 99 pid 4242/u);
  assert.equal(existsSync(lockPath), true, "the other run's marker survives this turn's release");
  unlinkSync(lockPath);
});

test("a reply larger than the pipe buffer still arrives as one receipt", () => {
  const repo = newRepo("big-reply");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  const sent = run("big", "claude", "send", "--repo", repo, "--kind", "review", "--body-file", bodyFile("read it all"));
  // execFileSync reads the helper through a pipe, exactly where an unflushed
  // stdout truncates at the buffer size and breaks the caller's JSON.parse.
  assert.equal(sent.receipt.status, "replied");
  assert.ok(sent.receipt.reply.length > 65536, `reply survived the pipe: ${sent.receipt.reply.length} bytes`);
});

test("init refuses to replace a pair recorded with the other partner", () => {
  const repo = newRepo("partner-mismatch");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex"); // records partner: codex
  const before = readFileSync(join(realpathSync(repo), ".git", "pair", "session.json"), "utf8");
  const refused = run("ok", "codex", "init", "--repo", repo, "--partner", "claude"); // resolves partner: claude
  assert.equal(refused.receipt.ok, false);
  assert.match(refused.receipt.reason, /a codex pair already exists here/u);
  assert.equal(
    readFileSync(join(realpathSync(repo), ".git", "pair", "session.json"), "utf8"),
    before,
    "the recorded session survives untouched",
  );
});

test("end refuses while a turn is in flight", () => {
  const repo = newRepo("end-in-flight");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  const lockPath = join(realpathSync(repo), ".git", "pair", "in-flight.json");
  writeFileSync(lockPath, JSON.stringify({ seq: 1, pid: process.pid, started_at: "now" }));
  const refused = run("ok", "claude", "end", "--repo", repo);
  assert.equal(refused.receipt.ok, false);
  assert.match(refused.receipt.reason, /in flight/u);
  assert.equal(existsSync(join(realpathSync(repo), ".git", "pair", "session.json")), true, "the session remains");
  unlinkSync(lockPath);
  assert.equal(run("ok", "claude", "end", "--repo", repo).receipt.status, "ended");
});

test("status reports the session and end deletes it", () => {
  const repo = newRepo("lifecycle");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("go"));
  const status = run("ok", "claude", "status", "--repo", repo).receipt;
  assert.equal(status.sid, CODEX_SID);
  assert.equal(status.seq, 1);
  assert.equal(status.latest_receipt.status, "replied");
  assert.equal(status.latest_receipt.seq, 1);
  assert.match(status.latest_receipt.receipt_file, /0001-task-receipt\.json$/u);
  assert.deepEqual(status.lineage, { current_sid: CODEX_SID, forks: [] });
  assert.equal(status.partner, "codex");
  const ended = run("ok", "claude", "end", "--repo", repo).receipt;
  assert.equal(ended.ok, true);
  assert.equal(existsSync(join(repo, ".git", "pair")), false);
  assert.match(run("ok", "claude", "status", "--repo", repo).receipt.reason, /no pair session/u);
});

// --- devbox heavy-slot queue and pool signals -------------------------------

const runWith = (extra, mode, self, ...args) => {
  writeFileSync(log, "");
  try {
    return JSON.parse(execFileSync(process.execPath, [helper, ...args], {
      encoding: "utf8",
      env: { ...env(mode, self), ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch (error) {
    if (!error.stdout) throw error;
    return JSON.parse(error.stdout);
  }
};

test("a queued agent-run heavy job is found under the partner by its childless argv", () => {
  assert.equal(isHeavyAgentRun(["/usr/bin/python3", "/home/h/.local/bin/agent-run", "heavy", "--", "bun", "run", "ci:local"]), true);
  assert.equal(isHeavyAgentRun(["/home/h/.local/bin/agent-run", "heavy", "--runtime-seconds", "600", "--", "bun", "test"]), true);
  assert.equal(isHeavyAgentRun(["/usr/bin/python3", "/home/h/.local/bin/agent-run", "task", "--", "bun", "test"]), false);
  assert.equal(isHeavyAgentRun(["/usr/bin/python3", "/home/h/.local/bin/agent-run", "--worker", "/run/user/1000/x/owner.sock"]), false);
  assert.equal(isHeavyAgentRun(["node", "/x/agent-runner", "heavy"]), false);

  // A fake /proc: the partner (100) runs a shell (101) that runs agent-run
  // heavy (102). With no child under 102 it is queued; once systemd-run (103)
  // appears under it, the slot is held and the job is running.
  const proc = join(root, "fake-proc");
  const entry = (pid, ppid, name, argv) => {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    writeFileSync(join(proc, String(pid), "stat"), `${pid} (${name}) S ${ppid} ${pid} ${pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0\n`);
    writeFileSync(join(proc, String(pid), "cmdline"), `${argv.join("\0")}\0`);
  };
  entry(1, 0, "systemd", ["/sbin/init"]);
  entry(100, 1, "node", ["node", "/opt/codex", "exec", "--json"]);
  entry(101, 100, "zsh", ["/usr/bin/zsh", "-c", "agent-run heavy -- bun test"]);
  entry(102, 101, "python3", ["/usr/bin/python3", "/home/h/.local/bin/agent-run", "heavy", "--", "bun", "test"]);
  entry(200, 1, "python3", ["/usr/bin/python3", "/home/h/.local/bin/agent-run", "heavy", "--", "other", "lead"]);
  writeFileSync(join(proc, "not-a-pid"), "");
  assert.deepEqual(queuedHeavyJob(100, readProcessTable(proc)), { pid: 102, command: "bun test" });
  assert.equal(queuedHeavyJob(300, readProcessTable(proc)), null, "another lead's queued job is not this partner's");
  entry(103, 102, "systemd-run", ["/usr/bin/systemd-run", "--user", "--wait", "--", "/usr/bin/python3", "/home/h/.local/bin/agent-run", "--worker", "/run/x"]);
  assert.equal(queuedHeavyJob(100, readProcessTable(proc)), null, "a job that spawned its worker holds the slot");
  assert.equal(readProcessTable(join(root, "no-such-proc")), null);
  assert.equal(queuedHeavyJob(100, null), null);
});

test("time queued behind the devbox heavy slot is excluded from the budgets and shown in flight", (t) => {
  if (!existsSync("/proc/self/stat")) {
    t.skip("the queue probe reads /proc");
    return;
  }
  const repo = newRepo("heavy-queue");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex");
  // The fake validation waits five seconds in the queue against a three-second
  // total budget: only the exclusion lets the turn finish.
  const extra = { FAKE_HEAVY_WAIT_MS: "5000", PAIR_HEADLESS_QUEUE_PROBE_MS: "100" };
  const running = runWith(extra, "queued", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("validate"), "--background", "--total-min", "0.05", "--idle-min", "0.05");
  assert.equal(running.status, "running");
  let seen = null;
  const until = Date.now() + 6000;
  while (Date.now() < until && !seen) {
    const flight = run("ok", "claude", "status", "--repo", repo).receipt.in_flight;
    if (flight?.heavy_queue?.queued) seen = flight.heavy_queue;
    else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  assert.ok(seen, "status shows the in-flight turn queued behind the heavy slot");
  assert.equal(seen.job.command, "bun test");
  assert.equal(seen.episodes, 1);
  const receipt = runWith(extra, "queued", "claude", "wait", "--repo", repo, "--seq", String(running.seq), "--timeout-min", "0.5");
  assert.equal(receipt.status, "replied", receipt.reason);
  assert.equal(receipt.heavy_queue.episodes, 1);
  assert.ok(receipt.heavy_queue.seconds >= 2, `queued seconds recorded: ${JSON.stringify(receipt.heavy_queue)}`);
  assert.ok(receipt.seconds >= 5, "wall-clock seconds still report the whole turn");

  // The same wait under `agent-run task` is not a queue: the budget applies.
  const control = runWith(extra, "queued-task", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("validate"), "--total-min", "0.05", "--idle-min", "0.05");
  assert.equal(control.status, "hang-killed");
  assert.match(control.reason, /total budget 0m exceeded — raise it with send --total-min$/u);
  assert.equal(control.heavy_queue, undefined);
});

test("a Codex turn's receipt carries the account pool reading and any throttle lines", () => {
  const repo = newRepo("pool-signals");
  run("ok", "claude", "init", "--repo", repo, "--partner", "codex", "--identity", "lais");
  const replied = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("go")).receipt;
  assert.equal(replied.status, "replied");
  assert.deepEqual(replied.rate_limits.primary, { window_minutes: 10080, used_percent: 24, resets_at: "2026-09-14T05:01:49.000Z" });
  assert.equal(replied.rate_limits.secondary, null);
  assert.ok(replied.rate_limits.read_at);
  assert.equal(replied.throttle_signals, undefined);
  const calls = invocations();
  assert.deepEqual(calls.map((call) => [call.argv[0], call.codex_home]), [["exec", realpathSync(laisHome)], ["app-server", realpathSync(laisHome)]], "the pool is read from the identity's own home after the turn");
  assert.deepEqual(JSON.parse(readFileSync(replied.receipt_file, "utf8")).rate_limits, replied.rate_limits);

  const failed = run("fail", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("again")).receipt;
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.throttle_signals, { rate_limit_lines: 1, first: "rate limit" });
  assert.equal(failed.rate_limits.primary.used_percent, 24);

  // A partner that is not Codex has no pool door; nothing is invented.
  const claudeRepo = newRepo("pool-signals-claude");
  run("ok", "codex", "init", "--repo", claudeRepo, "--partner", "claude");
  assert.equal(run("ok", "codex", "send", "--repo", claudeRepo, "--kind", "question", "--body-file", bodyFile("hi")).receipt.rate_limits, undefined);
});

test("pool and throttle summaries never promote a missing reading to a number", () => {
  assert.deepEqual(summarizeRateLimits({ rateLimits: { limitId: "codex", primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1789362109 }, secondary: { usedPercent: 3, windowDurationMins: 300 } } }, 0), {
    read_at: "1970-01-01T00:00:00.000Z",
    primary: { window_minutes: 10080, used_percent: 24, resets_at: "2026-09-14T05:01:49.000Z" },
    secondary: { window_minutes: 300, used_percent: 3, resets_at: null },
  });
  assert.equal(summarizeRateLimits({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 50 } } } }, 0).primary.used_percent, 50);
  assert.deepEqual(summarizeRateLimits({}, 0), { error: "account/rateLimits/read answered without rateLimits" });
  assert.equal(throttleSignals("progress\nstill running\n"), null);
  assert.deepEqual(throttleSignals("ok\nError: 429 Too Many Requests\nrate_limit_exceeded, retrying in 30s\n"), { rate_limit_lines: 2, first: "Error: 429 Too Many Requests" });
});
