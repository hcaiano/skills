#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  acquireMarker,
  bootstrapPrompt,
  clearMarker,
  detectSelf,
  locate,
  markerAlive,
  messagePrompt,
  minutesToMs,
  parseClaudeResult,
  parseSessionId,
  processAlive,
  releaseMarker,
  resolvePartner,
  sessionKnown,
  turnCommand,
} from "./pair-headless.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const helper = join(directory, "pair-headless.mjs");
const root = mkdtempSync(join(tmpdir(), "pair-headless-test-"));
const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });

// Fake CLIs record every invocation — argv, stdin, and cwd — so the tests can
// prove the exact command surface without a live codex or claude session.
const CODEX_SID = "11111111-2222-3333-4444-555555555555";
const CLAUDE_SID = "claude-session-abc";
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

writeFileSync(
  join(bin, "codex"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE || "ok";
${markerProbe}
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "codex", argv, stdin, cwd: process.cwd() }) + "\\n");
if (mode === "hang") { setInterval(() => {}, 1000); return; }
if (mode !== "nosid") process.stderr.write("session id: ${CODEX_SID}\\n");
const out = argv[argv.indexOf("-o") + 1];
if (mode === "fail") { process.stderr.write("rate limit\\n"); process.exit(1); }
if (mode === "empty") { fs.writeFileSync(out, "   \\n"); process.exit(0); }
if (mode === "big") { fs.writeFileSync(out, "[agent codex -> claude kind=ready sid=${CODEX_SID}]\\n\\n" + "x".repeat(300000) + "\\n"); process.exit(0); }
fs.writeFileSync(out, "[agent codex -> claude kind=ready sid=${CODEX_SID}]\\n\\nlease accepted\\n");
process.exit(0);
`,
);
writeFileSync(
  join(bin, "claude"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE || "ok";
${markerProbe}
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin: "claude", argv, stdin, cwd: process.cwd() }) + "\\n");
if (mode === "fail") { process.stderr.write("auth expired\\n"); process.exit(1); }
// stream-json: a system init event, an assistant event, then the final result.
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "${CLAUDE_SID}", tools: [] }) + "\\n");
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
// A stand-in for `trash`: it moves the directory aside instead of deleting it,
// which is exactly the property the real command guarantees.
writeFileSync(
  join(bin, "trash"),
  `#!/usr/bin/env node
const fs = require("node:fs");
fs.renameSync(process.argv[2], process.argv[2] + ".trashed");
`,
);
for (const name of ["codex", "claude", "trash"]) chmodSync(join(bin, name), 0o755);

const newRepo = (name) => {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" });
  return repo;
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
});

const run = (mode, self, ...args) => {
  writeFileSync(log, "");
  try {
    return {
      ok: true,
      receipt: JSON.parse(
        execFileSync(process.execPath, [helper, ...args], {
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
const invocations = () =>
  readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const bodyFile = (text) => {
  const path = join(root, `body-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(path, text);
  return path;
};

test("the partner is always the opposite CLI", () => {
  assert.equal(detectSelf({ CLAUDECODE: "1" }), "claude");
  assert.equal(detectSelf({ CODEX_SANDBOX: "seatbelt" }), "codex");
  assert.equal(detectSelf({}), null);
  assert.deepEqual(resolvePartner(null, { CLAUDECODE: "1" }), { partner: "codex", self: "claude" });
  assert.deepEqual(resolvePartner(null, { CODEX_THREAD_ID: "t" }), { partner: "claude", self: "codex" });
  assert.match(resolvePartner("claude", { CLAUDECODE: "1" }).error, /refusing to pair claude with itself/u);
  assert.match(resolvePartner("gemini", {}).error, /unknown partner gemini/u);
  assert.match(resolvePartner(null, {}).error, /pass --partner/u);
});

test("a headless pair requires a git repository", () => {
  const plain = join(root, "not-a-repo");
  mkdirSync(plain, { recursive: true });
  assert.match(locate(plain).error, /not a git repository/u);
  const repo = newRepo("located");
  const place = locate(repo);
  assert.equal(place.error, undefined);
  assert.match(place.statePath, /\.git\/pair\/session\.json$/u);
  assert.match(place.transcripts, /\.git\/pair\/transcripts$/u);
});

test("each turn's command matches the flags the installed CLIs accept", () => {
  const create = turnCommand({ partner: "codex", sid: null, replyFile: "/r", root: "/repo", write: false });
  assert.deepEqual(create, { bin: "codex", args: ["exec", "-s", "read-only", "-C", "/repo", "-o", "/r", "-"] });
  const resume = turnCommand({ partner: "codex", sid: "S", replyFile: "/r", root: "/repo", write: true });
  // `codex exec resume` accepts neither -C nor -s, so the sandbox arrives as a
  // config override and the directory through the spawn's cwd.
  assert.deepEqual(resume, {
    bin: "codex",
    args: ["exec", "resume", "S", "-c", 'sandbox_mode="workspace-write"', "-o", "/r", "-"],
  });
  const claudeCreate = turnCommand({ partner: "claude", sid: null, replyFile: "/r", root: "/repo", write: false });
  // stream-json, not json: a `json` run stays silent until it finishes, which
  // would make the idle deadline kill a long working turn.
  assert.deepEqual(claudeCreate.args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.ok(claudeCreate.args.includes("--strict-mcp-config"));
  assert.equal(claudeCreate.args.at(-1), "plan");
  const claudeResume = turnCommand({ partner: "claude", sid: "S", replyFile: "/r", root: "/repo", write: true });
  assert.deepEqual(claudeResume.args.slice(0, 3), ["-p", "--resume", "S"]);
  assert.equal(claudeResume.args.at(-1), "acceptEdits");
});

test("every flag the helper sends is one the installed CLIs accept", (t) => {
  const help = spawnSync("codex", ["exec", "resume", "--help"], { encoding: "utf8" });
  if (help.status !== 0) return t.skip("codex is not installed");
  const accepted = new Set(help.stdout.match(/--[a-z][a-z-]+/gu));
  accepted.add("-c");
  accepted.add("-o");
  const { args } = turnCommand({ partner: "codex", sid: "S", replyFile: "/r", root: "/repo", write: false });
  for (const token of args.filter((part) => part.startsWith("-") && part !== "-")) {
    assert.ok(accepted.has(token), `codex exec resume does not accept ${token}`);
  }

  const claudeHelp = spawnSync("claude", ["--help"], { encoding: "utf8" });
  if (claudeHelp.status !== 0) return t.skip("claude is not installed");
  const claudeAccepted = new Set(claudeHelp.stdout.match(/--[a-z][a-z-]+/gu));
  claudeAccepted.add("-p");
  const claudeArgs = turnCommand({ partner: "claude", sid: "S", replyFile: "/r", root: "/repo", write: true }).args;
  for (const token of claudeArgs.filter((part) => part.startsWith("-"))) {
    assert.ok(claudeAccepted.has(token), `claude does not accept ${token}`);
  }
  assert.ok(
    /stream-json/u.test(claudeHelp.stdout),
    "claude must still offer stream-json — it is what makes the idle deadline measure real liveness",
  );
});

test("session ids come out of each CLI's own report", () => {
  assert.equal(parseSessionId("codex", "prep\nsession id: abc-123\nrunning"), "abc-123");
  assert.equal(parseSessionId("codex", "no id here"), null);
  assert.equal(parseSessionId("claude", `noise\n${JSON.stringify({ type: "result", session_id: "s1", result: "hi" })}`), "s1");
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
  run("ok", "claude", "init", "--repo", repo);
  const bad = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("go"), "--idle-min", "abc");
  assert.equal(bad.receipt.ok, false);
  assert.match(bad.receipt.reason, /--idle-min must be a positive number/u);
  // The refusal happens before anything is spawned or recorded.
  assert.deepEqual(invocations(), []);
  assert.equal(JSON.parse(readFileSync(join(realpathSync(repo), ".git", "pair", "session.json"), "utf8")).seq, 0);
});

test("the bootstrap and message prompts carry the protocol literally", () => {
  const boot = bootstrapPrompt({ self: "claude", partner: "codex", root: "/repo" });
  assert.match(boot, /\[agent <from> -> <to> kind=<kind> sid=<sid>\]/u);
  assert.match(boot, /half-duplex/u);
  assert.match(boot, /write lease/u);
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
  const created = run("ok", "claude", "init", "--repo", repo);
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
  const again = run("ok", "claude", "init", "--repo", repo);
  assert.equal(again.receipt.status, "resumed");
  assert.equal(again.receipt.sid, CODEX_SID);
  assert.deepEqual(invocations(), []);
});

test("send resumes the exact session, sequences it, and returns the reply", () => {
  const repo = newRepo("send-codex");
  run("ok", "claude", "init", "--repo", repo);
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

test("--write is the only thing that opens the sandbox for a turn", () => {
  const repo = newRepo("write-lease");
  run("ok", "claude", "init", "--repo", repo);
  run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("implement"), "--write");
  assert.equal(invocations()[0].argv[4], 'sandbox_mode="workspace-write"');
});

test("send refuses a body or kind the protocol does not define", () => {
  const repo = newRepo("send-guards");
  const noSession = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("x"));
  assert.match(noSession.receipt.reason, /no pair session/u);
  run("ok", "claude", "init", "--repo", repo);
  const badKind = run("ok", "claude", "send", "--repo", repo, "--kind", "gossip", "--body-file", bodyFile("x"));
  assert.match(badKind.receipt.reason, /unknown kind gossip/u);
  const empty = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("   \n"));
  assert.match(empty.receipt.reason, /body file is empty/u);
  const missing = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", join(root, "absent.md"));
  assert.match(missing.receipt.reason, /no body file/u);
});

test("a clean exit with nothing in it is a failed turn, not a reply", () => {
  const repo = newRepo("empty-reply");
  run("ok", "claude", "init", "--repo", repo);
  const empty = run("empty", "claude", "send", "--repo", repo, "--kind", "question", "--body-file", bodyFile("q"));
  assert.equal(empty.receipt.ok, false);
  assert.equal(empty.receipt.status, "empty-reply");
  assert.equal(empty.receipt.exit_code, 0);
});

test("a nonzero exit fails the turn and keeps the transcript", () => {
  const repo = newRepo("failed-turn");
  run("ok", "claude", "init", "--repo", repo);
  const failed = run("fail", "claude", "send", "--repo", repo, "--kind", "question", "--body-file", bodyFile("q"));
  assert.equal(failed.receipt.status, "failed");
  assert.match(readFileSync(failed.receipt.transcript, "utf8"), /rate limit/u);
});

test("init fails loudly when the CLI reports no resumable session", () => {
  const repo = newRepo("no-sid");
  const receipt = run("nosid", "claude", "init", "--repo", repo).receipt;
  assert.equal(receipt.ok, false);
  assert.match(receipt.reason, /no session id/u);
  assert.equal(existsSync(join(repo, ".git", "pair", "session.json")), false);
});

test("a hung turn is killed on its idle deadline", () => {
  const repo = newRepo("hang");
  run("ok", "claude", "init", "--repo", repo);
  const hung = run("hang", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("q"), "--idle-min", "0.05");
  assert.equal(hung.receipt.status, "hang-killed");
  assert.match(hung.receipt.reason, /hang: no output for/u);
});

test("a Codex lead pairs with a headless Claude partner", () => {
  const repo = newRepo("claude-partner");
  const created = run("ok", "codex", "init", "--repo", repo);
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
  run("ok", "claude", "init", "--repo", repo);
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
  assert.equal(invocations().length, 1);
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
  run("ok", "claude", "init", "--repo", repo);
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
  run("ok", "claude", "init", "--repo", repo);
  // The fake CLI writes the marker it finds to disk, which is the only way to
  // observe a marker that a completed turn has already cleared.
  const receipt = run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("go")).receipt;
  assert.equal(receipt.status, "replied");
  const seen = JSON.parse(readFileSync(join(root, "marker-seen.json"), "utf8"));
  assert.equal(seen.seq, 1);
  assert.equal(seen.pid > 0, true);
  assert.equal(Number.isInteger(seen.child_pid), true, "the CLI's own pid must reach the marker while it runs");
  assert.notEqual(seen.child_pid, seen.pid);
});

test("a turn whose marker was replaced reports it instead of clearing someone else's", () => {
  const repo = newRepo("marker-stolen");
  run("ok", "claude", "init", "--repo", repo);
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
  run("ok", "claude", "init", "--repo", repo);
  const sent = run("big", "claude", "send", "--repo", repo, "--kind", "review", "--body-file", bodyFile("read it all"));
  // execFileSync reads the helper through a pipe, exactly where an unflushed
  // stdout truncates at the buffer size and breaks the caller's JSON.parse.
  assert.equal(sent.receipt.status, "replied");
  assert.ok(sent.receipt.reply.length > 65536, `reply survived the pipe: ${sent.receipt.reply.length} bytes`);
});

test("init refuses to replace a pair recorded with the other partner", () => {
  const repo = newRepo("partner-mismatch");
  run("ok", "claude", "init", "--repo", repo); // records partner: codex
  const before = readFileSync(join(realpathSync(repo), ".git", "pair", "session.json"), "utf8");
  const refused = run("ok", "codex", "init", "--repo", repo); // resolves partner: claude
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
  run("ok", "claude", "init", "--repo", repo);
  const lockPath = join(realpathSync(repo), ".git", "pair", "in-flight.json");
  writeFileSync(lockPath, JSON.stringify({ seq: 1, pid: process.pid, started_at: "now" }));
  const refused = run("ok", "claude", "end", "--repo", repo);
  assert.equal(refused.receipt.ok, false);
  assert.match(refused.receipt.reason, /in flight/u);
  assert.equal(existsSync(join(realpathSync(repo), ".git", "pair", "session.json")), true, "nothing was trashed");
  unlinkSync(lockPath);
  assert.equal(run("ok", "claude", "end", "--repo", repo).receipt.status, "ended");
});

test("status reports the session and end trashes it", () => {
  const repo = newRepo("lifecycle");
  run("ok", "claude", "init", "--repo", repo);
  run("ok", "claude", "send", "--repo", repo, "--kind", "task", "--body-file", bodyFile("go"));
  const status = run("ok", "claude", "status", "--repo", repo).receipt;
  assert.equal(status.sid, CODEX_SID);
  assert.equal(status.seq, 1);
  assert.equal(status.partner, "codex");
  const ended = run("ok", "claude", "end", "--repo", repo).receipt;
  assert.equal(ended.ok, true);
  assert.equal(existsSync(join(repo, ".git", "pair")), false);
  assert.equal(existsSync(`${join(repo, ".git", "pair")}.trashed`), true);
  assert.match(run("ok", "claude", "status", "--repo", repo).receipt.reason, /no pair session/u);
});
