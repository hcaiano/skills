#!/usr/bin/env node
// The headless backend's transport: one persistent, resumable session of the
// chosen partner CLI, driven half-duplex — the lead sends, and the partner's
// reply is that run's output. There is no pane, so there is no composer proof and no
// delivery receipt beyond the run receipt: a turn either produced a reply or it
// did not, and the transcript is the evidence either way.
//
//   node pair-headless.mjs init   --repo <root> --partner claude|codex|cursor|grok
//                                 [--model <name>] [--effort <level>] [--role peer|executor]
//   node pair-headless.mjs send   --repo <root> --kind <kind> --body-file <path> [--write|--read-only]
//                                 [--background]
//   node pair-headless.mjs wait   --repo <root> [--seq N] [--timeout-min 65]
//   node pair-headless.mjs fork   --repo <root> [--retry]
//   node pair-headless.mjs status --repo <root>
//   node pair-headless.mjs clear  --repo <root>
//   node pair-headless.mjs end    --repo <root>
//   [--idle-min 20] [--total-min 60] on init and send
//
// State lives in `<git-dir>/pair/session.json`, so the session belongs to the
// worktree the work happens in: one pair per worktree, and a linked worktree
// gets its own. A turn holds `in-flight.json` beside it for as long as it runs,
// because half-duplex means one resume of the CLI session at a time; a send
// refuses over any existing marker and `clear` is the only remover. The
// deadline mechanic (output-based liveness — stock macOS has no `timeout` — and
// a kill of the PID itself, never the group) follows review-it's headless
// wrappers; the receipt shape follows theirs too, so a caller reads one JSON
// object per command and never a transcript to learn what happened.
//
// Exit 0: JSON receipt {ok: true, ...}. Exit 1: {ok: false, reason, ...}.
// Exit 2: usage error.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const POLL_MS = 2000;
const WAIT_POLL_MS = 100;
const START_TIMEOUT_MS = 10000;
const SCHEMA = 1;
const KINDS = new Set([
  "task",
  "review",
  "question",
  "ready",
  "accepted",
  "blocked",
  "stalemate",
  "handoff",
]);

const argv = process.argv.slice(2);
const command = argv[0];
// The recovery advice has to be a command the caller can paste, so it names the
// path this helper was actually invoked by.
const helperPath = process.argv[1] ?? "pair-headless.mjs";

// Blocking write straight to fd 1: `process.stdout.write` + `process.exit`
// truncates at the pipe buffer (~64 KiB measured), and the receipt's `reply`
// is its last key — a long partner reply would turn a replied turn into a
// caller-side parse failure. EAGAIN means the caller has not drained the pipe
// yet; retry until the whole receipt is out, then exit.
const emit = (record, code) => {
  const payload = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  let written = 0;
  while (written < payload.length) {
    try {
      written += writeSync(1, payload, written);
    } catch (error) {
      if (error?.code !== "EAGAIN") throw error;
    }
  }
  process.exit(code);
};
const fail = (reason, code = 1) => emit({ ok: false, reason }, code);

const opt = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`missing value for --${name}`, 2);
  return value;
};
const flag = (name) => argv.includes(`--${name}`);

// --- identity ---------------------------------------------------------------

export const AGENT_KINDS = ["claude", "codex", "cursor", "grok"];
const kindList = AGENT_KINDS.join("|");

// Which CLI is running this helper. Detection is best-effort — it only has the
// environment each harness happens to export into its own shells — so it never
// decides the partner on its own: it exists to catch a same-CLI pairing, which
// produces an echo rather than a peer.
export const detectSelf = (env = process.env) => {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID || env.CODEX_HOME) return "codex";
  if (env.CURSOR_AGENT || env.CURSOR_AGENT_CHAT_ID) return "cursor";
  if (env.GROK_SESSION_ID || env.GROK_AGENT) return "grok";
  return null;
};

// The partner is always chosen, never derived: with four CLIs there is no
// "opposite" to fall back on. The only rule is that it differs from the lead.
export const resolvePartner = (requested, env = process.env) => {
  const self = detectSelf(env);
  if (!requested) {
    return { error: `missing --partner — choose one of ${kindList}, other than the CLI you are` };
  }
  if (!AGENT_KINDS.includes(requested)) {
    return { error: `unknown partner ${requested} — use one of ${kindList}` };
  }
  if (self && requested === self) {
    return {
      error: `refusing to pair ${self} with itself — the partner must be a different CLI (${AGENT_KINDS.filter((kind) => kind !== self).join(", ")})`,
    };
  }
  return { partner: requested, self: self ?? "lead" };
};

export const ROLES = ["peer", "executor"];

// The role sets the default lease distribution, and nothing else: an executor
// partner holds the write lease unless a turn takes it back, a peer holds it
// only for the turns that hand it over. Every turn can still say otherwise.
export const resolveWrite = (role, { write, readOnly }) => {
  if (write && readOnly) {
    return { error: "--write and --read-only contradict each other on one turn" };
  }
  if (write) return { write: true };
  if (readOnly) return { write: false };
  return { write: role === "executor" };
};

// --- repository state -------------------------------------------------------

const git = (repo, ...args) =>
  spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });

export const locate = (repo) => {
  const top = git(repo, "rev-parse", "--show-toplevel");
  const dir = git(repo, "rev-parse", "--absolute-git-dir");
  if (top.status !== 0 || dir.status !== 0) return { error: `not a git repository: ${repo} — the headless pair keeps its session in the repository's git directory` };
  const root = top.stdout.trim();
  const stateDir = join(dir.stdout.trim(), "pair");
  return {
    root,
    stateDir,
    statePath: join(stateDir, "session.json"),
    lockPath: join(stateDir, "in-flight.json"),
    transcripts: join(stateDir, "transcripts"),
  };
};

// Signal 0 asks the kernel about the pid without touching the process. EPERM
// means it exists and belongs to someone else, which still counts as alive.
export const processAlive = (pid, kill = process.kill.bind(process)) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const readState = (statePath) => {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
};

// Atomic so an interrupted write never leaves a session file that parses into a
// half-updated sequence counter. The temp name carries the pid because two
// writers sharing one temp path interleave into a single corrupt rename.
const writeState = (statePath, state) => {
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, statePath);
};

// --- the in-flight lock -----------------------------------------------------
//
// One turn at a time, enforced by the filesystem rather than by a read-then-
// write on the session file: two sends can both read an empty marker there and
// both write it. `wx` is O_EXCL, so exactly one creator wins and everyone else
// gets EEXIST and has to look at who holds it.

const readMarker = (lockPath) => {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
};

// The child CLI is the real work, so it decides: a helper killed mid-turn
// leaves a live partner CLI still resuming the session, and a second send
// into that session is the corruption the lock exists to prevent.
export const markerAlive = (marker, alive = processAlive) => {
  if (!marker) return false;
  const partnerPid = marker.partner_pid ?? marker.child_pid;
  const supervisorPid = marker.supervisor_pid ?? marker.pid;
  if (Number.isInteger(partnerPid) && alive(partnerPid)) return true;
  if (Number.isInteger(supervisorPid) && alive(supervisorPid)) return true;
  return alive(marker.launcher_pid);
};

// Acquisition has exactly two outcomes: the link wins, or the send refuses with
// a classified reason. There is no automatic takeover, because removing another
// run's marker cannot be done safely — `unlink` has no compare-and-remove, so
// two contenders reading one dead marker can both authorize a delete and the
// second one lands on the first one's freshly linked, live lock. Recovery moved
// to the `clear` command, where one operator decides once.
//
// The lock is published by `link`, not by an O_EXCL write: O_EXCL makes the
// *creation* atomic but not the content, so a loser reading a file the winner
// has created and not yet filled sees nothing and would call a live lock
// wreckage. Writing the whole marker to a private temp file and hardlinking it
// into place makes appearance and content the same event.
export const acquireMarker = (lockPath, marker) => {
  const temporary = `${lockPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`);
    try {
      linkSync(temporary, lockPath);
      return { acquired: marker };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        return { error: `cannot take the in-flight lock ${lockPath}: ${error.message}` };
      }
    }
    const holder = readMarker(lockPath);
    // A marker that cannot be read is busy, never wreckage: the alternative is
    // deciding a turn is dead on the strength of not having seen it.
    if (!holder) return { unreadable: true };
    if (markerAlive(holder)) return { holder };
    return { dead: holder };
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* the temp file is this process's alone; a missing one is already the goal */
    }
  }
};

// Ownership is checked on release too: a marker this run did not create belongs
// to a turn that is still meaningful to someone, so it survives and the receipt
// says it did.
export const releaseMarker = (lockPath, marker) => {
  const holder = readMarker(lockPath);
  if (!holder) return { released: false };
  const sameOwner = marker.owner_token
    ? holder.owner_token === marker.owner_token
    : holder.pid === marker.pid;
  if (holder.seq !== marker.seq || !sameOwner) {
    return {
      released: false,
      note: `left an in-flight marker owned by seq ${holder.seq} pid ${holder.supervisor_pid ?? holder.pid ?? "unknown"} — this turn was seq ${marker.seq} pid ${marker.supervisor_pid ?? marker.pid ?? "unknown"}`,
    };
  }
  try {
    unlinkSync(lockPath);
  } catch (error) {
    return { released: false, note: `cannot clear the in-flight marker ${lockPath}: ${error.message}` };
  }
  return { released: true };
};

// Best-effort probe of the vendor's own session store. It only ever reports a
// positive absence: a false means the store was fully readable and the session
// was not in it. Anything that blocks the read — a missing store, a permission
// error, an unreadable subdirectory — reports true, because discarding a real
// session costs the pair its whole history while a stale resume merely fails
// loudly on the next turn.
//
// Every probe here is readdirSync or statSync, never existsSync: existsSync
// answers false for a path it was not allowed to look at, which turns an EACCES
// into a confident "the session is gone" — the exact false negative this
// function is built to avoid.
// Codex, Grok, and Cursor all keep one directory tree of sessions named after
// their own ids, so one walker serves all three: a name that contains the sid
// is a hit whether it is a file (Codex rollouts, Grok session files) or a
// directory (a Cursor chat).
const storeHolds = (store, sid) => {
  let unreadable = false;
  const walk = (directory, depth) => {
    if (depth > 6) {
      unreadable = true; // the store is deeper than the probe looks
      return false;
    }
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      unreadable = true;
      return false;
    }
    for (const entry of entries) {
      if (entry.name.includes(sid)) return true;
      if (entry.isDirectory() && walk(join(directory, entry.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(store, 0) || unreadable;
};

export const sessionKnown = (partner, sid, root, env = process.env, home = homedir()) => {
  if (partner === "codex") {
    return storeHolds(join(env.CODEX_HOME || join(home, ".codex"), "sessions"), sid);
  }
  if (partner === "grok") {
    return storeHolds(join(env.GROK_HOME || join(home, ".grok"), "sessions"), sid);
  }
  if (partner === "cursor") {
    return storeHolds(join(home, ".cursor", "chats"), sid);
  }
  const projects = join(home, ".claude", "projects");
  const project = join(projects, root.replace(/[^A-Za-z0-9]/gu, "-"));
  try {
    readdirSync(projects); // proves the store is readable, not merely present
  } catch {
    return true;
  }
  let entries;
  try {
    entries = readdirSync(project);
  } catch (error) {
    // Only a readable store that does not hold this project is an absence.
    return error?.code !== "ENOENT";
  }
  if (entries.includes(`${sid}.jsonl`)) return true;
  try {
    statSync(join(project, `${sid}.jsonl`));
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
};

// --- partner turns ----------------------------------------------------------

// Reasoning effort reaches each CLI through a different door: Grok and Claude
// take flags, Codex a config override, and Cursor a bracket suffix inside the
// model name.
export const EFFORT_SUPPORT = { claude: true, codex: true, cursor: true, grok: true };

// Cursor parameterizes the model itself, so an effort with no model has nowhere
// to go and the caller has to name one.
export const cursorModel = (model, effort) => {
  if (!effort) return model;
  if (!model) return null;
  return /\[/u.test(model) ? model : `${model}[effort=${effort}]`;
};

// `codex exec resume` accepts neither -C nor -s, so the working directory
// arrives through the spawn and the sandbox through a config override — the
// same split ask-peer measured. Model and effort are settings of the session,
// so they are passed when it is created and never on a resume.
export const turnCommand = ({ partner, sid, resume, replyFile, promptFile, root, write, model, effort }) => {
  if (partner === "codex") {
    const sandbox = write ? "workspace-write" : "read-only";
    if (resume) {
      return { bin: "codex", args: ["exec", "resume", sid, "-c", `sandbox_mode="${sandbox}"`, "--json", "-o", replyFile, "-"], promptVia: "stdin" };
    }
    return {
      bin: "codex",
      args: [
        "exec",
        "-s",
        sandbox,
        "-C",
        root,
        ...(model ? ["-m", model] : []),
        ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
        "--json",
        "-o",
        replyFile,
        "-",
      ],
      promptVia: "stdin",
    };
  }
  if (partner === "claude") {
    // stream-json, not json: a `json` run emits nothing until it finishes, so a
    // long silent turn would trip the idle deadline and be killed mid-work. The
    // streamed events are the liveness signal, and `--verbose` is what -p
    // requires to emit them.
    const tail = [
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--no-chrome",
      ...(model && !resume ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
      "--permission-mode",
      write ? "acceptEdits" : "plan",
    ];
    return { bin: "claude", args: ["-p", ...(resume ? ["--resume", sid] : []), ...tail], promptVia: "stdin" };
  }
  if (partner === "cursor") {
    // `-p` is write-capable by default, so read-only is the mode that has to be
    // asked for; the chat id only exists after the first run, so it is parsed
    // out of the JSON that run prints.
    const named = cursorModel(model, effort);
    return {
      bin: "cursor-agent",
      args: [
        "-p",
        "--trust", // headless runs refuse an untrusted directory outright; the repo is the user's own task repo
        "--output-format",
        "stream-json",
        ...(resume ? ["--resume", sid] : []),
        ...(named && !resume ? ["--model", named] : []),
        ...(write ? [] : ["--mode", "plan"]),
      ],
      promptVia: "stdin",
    };
  }
  // Grok takes the prompt from a file rather than stdin, and accepts the
  // session id for a NEW conversation — so the pair names the session itself
  // and never has to find it in the output.
  return {
    bin: "grok",
    args: [
      "--prompt-file",
      promptFile,
      "--output-format",
      "streaming-json",
      ...(resume?.fork
        ? ["--resume", resume.oldSid, "--fork-session", "--session-id", resume.newSid]
        : resume
          ? ["--resume", sid]
          : ["--session-id", sid]),
      "--permission-mode",
      write ? "acceptEdits" : "plan",
      ...(model && !resume ? ["-m", model] : []),
      ...(effort && !resume ? ["--reasoning-effort", effort] : []),
    ],
    promptVia: "file",
  };
};

// Grok is the one partner whose session id exists before its first run.
export const newSessionId = (partner) => (partner === "grok" ? randomUUID() : null);

export const parseSessionId = (partner, transcript) => {
  if (partner === "codex") {
    const started = parseJsonObjects(transcript).find((event) => event.type === "thread.started");
    return typeof started?.thread_id === "string" ? started.thread_id : null;
  }
  if (partner === "cursor") return parseCursorSessionId(transcript);
  if (partner === "grok") return null; // pre-generated, never parsed
  return parseClaudeResult(transcript)?.session_id ?? null;
};

// Every JSON object the run printed, whether one per line or one for the whole
// run. A tolerant scan, because the only fixed point across these CLIs is that
// the answer arrives as JSON somewhere in the output.
export const parseJsonObjects = (transcript) => {
  const objects = [];
  const push = (text) => {
    const start = text.indexOf("{");
    if (start === -1) return;
    try {
      const parsed = JSON.parse(text.slice(start));
      if (parsed && typeof parsed === "object") objects.push(parsed);
    } catch {
      /* not an event line */
    }
  };
  for (const line of transcript.split("\n")) push(line);
  if (objects.length === 0) push(transcript); // a single pretty-printed object
  return objects;
};

const SESSION_ID_KEYS = ["chat_id", "chatId", "session_id", "sessionId"];

// Cursor names the chat differently across output shapes, so take the first
// key that carries one and keep the parser tolerant rather than guess a shape.
export const parseCursorSessionId = (transcript) => {
  const objects = parseJsonObjects(transcript);
  for (let index = objects.length - 1; index >= 0; index--) {
    const object = objects[index];
    if (object.type !== "result" || object.is_error === true) continue;
    for (const key of SESSION_ID_KEYS) {
      if (typeof object[key] === "string" && object[key].trim()) return object[key];
    }
  }
  return null;
};

const REPLY_KEYS = ["result", "response", "text", "content", "message"];

// Cursor and Grok print the answer rather than writing it to a file, so the
// helper has to lift it out: the last object carrying a nonempty text field.
export const parseTextReply = (transcript) => {
  const objects = parseJsonObjects(transcript);
  for (let index = objects.length - 1; index >= 0; index--) {
    for (const key of REPLY_KEYS) {
      const value = objects[index][key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
};

export const parseCursorResult = (transcript) => {
  const objects = parseJsonObjects(transcript);
  for (let index = objects.length - 1; index >= 0; index--) {
    const event = objects[index];
    if (event.type === "result") return event;
  }
  return null;
};

export const parseGrokStream = (transcript) => {
  const events = parseJsonObjects(transcript);
  const reply = events
    .filter((event) => event.type === "text" && typeof event.data === "string")
    .map((event) => event.data)
    .join("");
  const end = [...events].reverse().find((event) => event.type === "end") ?? null;
  return {
    reply: reply.trim() || null,
    stopReason: typeof end?.stopReason === "string" ? end.stopReason : null,
    sessionId: typeof end?.sessionId === "string" ? end.sessionId : null,
  };
};

// The stream carries many objects and several of them hold a session_id — the
// `system` init event does too — so the reply comes from the final
// `type: "result"` event and nothing else. The session id falls back to any
// event carrying one, which is what makes a run that died before its result
// event still name the session it left behind.
export const parseClaudeResult = (transcript) => {
  const objects = [];
  for (const line of transcript.split("\n")) {
    const start = line.indexOf("{");
    if (start === -1) continue;
    try {
      const parsed = JSON.parse(line.slice(start));
      if (parsed && typeof parsed === "object") objects.push(parsed);
    } catch {
      /* not an event line */
    }
  }
  for (let index = objects.length - 1; index >= 0; index--) {
    if (objects[index].type === "result") return objects[index];
  }
  for (let index = objects.length - 1; index >= 0; index--) {
    if ("session_id" in objects[index]) return objects[index];
  }
  return null;
};

// Codex is the only partner that writes the reply itself (`-o`); for the other
// three the reply has to be lifted out of the run's own output and put where
// the caller was told to read it.
export const extractReply = (partner, replyFile, transcript) => {
  if (partner === "codex") {
    if (existsSync(replyFile)) {
      const reply = readFileSync(replyFile, "utf8").trim();
      if (reply) return reply;
    }
    const message = [...parseJsonObjects(transcript)].reverse().find(
      (event) =>
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        typeof event.item.text === "string",
    );
    return message?.item.text?.trim() || null;
  }
  if (partner === "claude") {
    const result = parseClaudeResult(transcript);
    if (typeof result?.result === "string" && result.result.trim()) return result.result.trim();
    const assistant = [...parseJsonObjects(transcript)].reverse().find(
      (event) => event.type === "assistant" && Array.isArray(event.message?.content),
    );
    const text = assistant?.message.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    return text?.trim() || null;
  }
  if (partner === "cursor") {
    const result = parseCursorResult(transcript);
    if (
      (result?.is_error === false || result?.is_error == null) &&
      typeof result?.result === "string" &&
      result.result.trim()
    ) {
      return result.result.trim();
    }
    const assistant = [...parseJsonObjects(transcript)].reverse().find(
      (event) => event.type === "assistant" && Array.isArray(event.message?.content),
    );
    const text = assistant?.message.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    return text?.trim() || null;
  }
  return parseGrokStream(transcript).reply;
};

const writeReply = (partner, replyFile, transcript) => {
  const reply = extractReply(partner, replyFile, transcript);
  if (reply && partner !== "codex") writeFileSync(replyFile, `${reply}\n`);
  return reply;
};

// Detached so a signal aimed at this helper's process group cannot decapitate a
// partner turn that is mid-edit; killed by PID, never by group.
const supervise = ({ bin, args, cwd, prompt, transcriptPath, idleMs, totalMs, onSpawn, onExit, onHang }) => {
  const startedAt = Date.now();
  const fd = openSync(transcriptPath, "w");
  const child = spawn(bin, args, { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  onSpawn?.(child.pid);
  let text = "";
  let lastGrowth = Date.now();
  const mirror = (chunk) => {
    writeSync(fd, chunk);
    text += chunk.toString();
    lastGrowth = Date.now();
  };
  child.stdout.on("data", mirror);
  child.stderr.on("data", mirror);
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);

  let spawnError = null;
  let settled = false;
  let killing = false;
  let timer = null;
  const done = (finish) => {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    closeSync(fd);
    finish();
  };
  // The exit is reported by the child, not discovered by the poll: a finished
  // turn returns immediately and the interval only ever measures deadlines.
  const settle = (code) => {
    if (killing) return; // a killed turn reports the hang, never the kill's exit
    done(() =>
      onExit({
        exit: code ?? -1,
        transcript: text,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        spawnError,
      }),
    );
  };
  child.on("close", settle);
  child.on("error", (error) => {
    spawnError = error;
    settle(-1);
  });

  timer = setInterval(() => {
    const now = Date.now();
    if (now - lastGrowth > idleMs || now - startedAt > totalMs) {
      killing = true;
      clearInterval(timer);
      const why =
        now - startedAt > totalMs
          ? `total budget ${Math.round(totalMs / 60000)}m exceeded`
          : `no output for ${Math.round(idleMs / 60000)}m`;
      child.kill("SIGTERM"); // the PID itself, never the group
      setTimeout(() => {
        try {
          process.kill(child.pid, 0);
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        setTimeout(
          () =>
            done(() =>
              onHang({ why, transcript: text, seconds: Math.round((Date.now() - startedAt) / 1000) }),
            ),
          500,
        );
      }, 2000);
    }
  }, POLL_MS);
};

// --- prompts ----------------------------------------------------------------

export const bootstrapPrompt = ({ self, partner, root, role = "peer" }) =>
  [
    `You are the pair partner for a ${self} lead working in ${root}.`,
    role === "executor"
      ? "You are the executor: you hold the write leases by default and implement; the lead plans and reviews."
      : "You and the lead are peers: you split scopes as equals and review each other's work.",
    "This session persists: every later message resumes this exact session, so keep the task state you build here.",
    "",
    "Protocol. Every message you receive starts with a header line",
    "`[agent <from> -> <to> kind=<kind> sid=<sid>]` followed by a blank line and the body.",
    "Open every reply with the same header shape, swapping from and to, and keep the sid literal.",
    "",
    "Kinds: task (work split and write leases), review (review request with paths),",
    "question (clarification), ready (changed files, validation, residual risk),",
    "accepted (accepting a ready), blocked (a user decision is required),",
    "stalemate (the same judgment call twice with no movement), handoff (return control to the user).",
    "",
    "Write leases: one agent holds the write lease per file scope and the other stays read-only",
    "on that scope until handoff. Turns where you hold the lease arrive in a writable sandbox;",
    "every other turn is read-only, so propose diffs instead of applying them.",
    "",
    "The exchange is half-duplex: your reply is this run's final message. There is no other channel back to the lead.",
    "",
    "Reply now with a `ready` message confirming you have the protocol, in one or two lines.",
  ].join("\n");

export const messagePrompt = ({ self, partner, kind, sid, body }) =>
  `[agent ${self} -> ${partner} kind=${kind} sid=${sid}]\n\n${body.replace(/\s+$/u, "")}\n`;

// --- commands ---------------------------------------------------------------

const requirePlace = () => {
  const repo = opt("repo");
  if (!repo) fail("missing --repo", 2);
  const place = locate(repo);
  if (place.error) fail(place.error);
  return place;
};

// A NaN deadline compares false against everything, so unvalidated junk would
// silently remove the deadline instead of shortening it. A minute count that is
// not a positive finite number is a usage error.
export const minutesToMs = (value, name) => {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { error: `--${name} must be a positive number of minutes, got ${value}` };
  }
  return { ms: minutes * 60000 };
};

const deadlines = () => {
  const idle = minutesToMs(opt("idle-min", "20"), "idle-min");
  const total = minutesToMs(opt("total-min", "60"), "total-min");
  if (idle.error) fail(idle.error, 2);
  if (total.error) fail(total.error, 2);
  return { idleMs: idle.ms, totalMs: total.ms };
};

const runInit = () => {
  const place = requirePlace();
  const { partner, self, error } = resolvePartner(opt("partner"));
  if (error) fail(error, 2);
  const role = opt("role", "peer");
  if (!ROLES.includes(role)) fail(`unknown role ${role} — use ${ROLES.join(" or ")}`, 2);
  const model = opt("model");
  const effort = opt("effort");
  if (effort && !EFFORT_SUPPORT[partner]) {
    fail(`${partner} has no reasoning-effort control — drop --effort`, 2);
  }
  if (partner === "cursor" && effort && !model) {
    fail("cursor carries effort inside the model name, so --effort needs --model", 2);
  }
  const existing = readState(place.statePath);
  // A recorded pair with the other partner is an active choice, never an
  // overwrite: replacing it here would discard that pair's sid and history
  // behind a receipt that reads as a plain create.
  if (existing?.sid && existing.partner !== partner) {
    fail(
      `a ${existing.partner} pair already exists here (sid ${existing.sid}) — end it first, or pass --partner ${existing.partner} to resume it`,
    );
  }
  if (existing?.sid && existing.partner === partner && sessionKnown(partner, existing.sid, place.root)) {
    emit(
      {
        ok: true,
        status: "resumed",
        sid: existing.sid,
        partner: existing.partner,
        role: existing.role ?? "peer",
        model: existing.model ?? null,
        effort: existing.effort ?? null,
        state_file: place.statePath,
        transcripts: existing.transcripts ?? place.transcripts,
      },
      0,
    );
  }

  mkdirSync(place.transcripts, { recursive: true });
  const transcriptPath = join(place.transcripts, "0000-init.log");
  const replyFile = join(place.transcripts, "0000-init-reply.md");
  const promptFile = join(place.transcripts, "0000-init-prompt.md");
  const presetSid = newSessionId(partner);
  const { bin, args, promptVia } = turnCommand({
    partner,
    sid: presetSid,
    resume: false,
    replyFile,
    promptFile,
    root: place.root,
    write: false,
    model,
    effort,
  });
  const { idleMs, totalMs } = deadlines();
  const prompt = bootstrapPrompt({ self, partner, root: place.root, role });
  if (promptVia === "file") writeFileSync(promptFile, `${prompt}\n`);

  supervise({
    bin,
    args,
    cwd: place.root,
    prompt: promptVia === "file" ? "" : prompt,
    transcriptPath,
    idleMs,
    totalMs,
    onExit: ({ exit, transcript, seconds, spawnError }) => {
      if (spawnError) fail(`cannot run ${bin}: ${spawnError.message}`);
      if (exit !== 0) {
        fail(`${bin} exited ${exit} during init — see ${transcriptPath}`);
      }
      const sid = presetSid ?? parseSessionId(partner, transcript);
      if (!sid) {
        fail(`${bin} produced no session id — a pair needs a resumable session; see ${transcriptPath}`);
      }
      writeReply(partner, replyFile, transcript);
      writeState(place.statePath, {
        schema: SCHEMA,
        partner,
        self,
        role,
        model: model ?? null,
        effort: effort ?? null,
        sid,
        seq: 0,
        created_at: new Date().toISOString(),
        transcripts: place.transcripts,
      });
      emit(
        {
          ok: true,
          status: "created",
          sid,
          partner,
          role,
          model: model ?? null,
          effort: effort ?? null,
          state_file: place.statePath,
          transcripts: place.transcripts,
          transcript: transcriptPath,
          reply_file: replyFile,
          seconds,
        },
        0,
      );
    },
    onHang: ({ why, seconds }) =>
      emit({ ok: false, status: "hang-killed", reason: `hang: ${why}`, transcript: transcriptPath, seconds }, 1),
  });
};

const sleepSync = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const atomicJson = (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
};

const turnPaths = (place, seq, kind) => {
  const stamp = String(seq).padStart(4, "0");
  return {
    transcriptPath: join(place.transcripts, `${stamp}-${kind}.log`),
    replyFile: join(place.transcripts, `${stamp}-${kind}-reply.md`),
    promptFile: join(place.transcripts, `${stamp}-${kind}-prompt.md`),
    receiptFile: join(place.transcripts, `${stamp}-${kind}-receipt.json`),
    startedFile: join(place.transcripts, `${stamp}-${kind}-started.json`),
  };
};

const findReceipt = (place, seq) => {
  const prefix = `${String(seq).padStart(4, "0")}-`;
  let name;
  try {
    name = readdirSync(place.transcripts).find(
      (entry) => entry.startsWith(prefix) && entry.endsWith("-receipt.json"),
    );
  } catch {
    return null;
  }
  return name ? join(place.transcripts, name) : null;
};

const replaceOwnedMarker = (lockPath, marker, values) => {
  const holder = readMarker(lockPath);
  if (
    holder?.seq !== marker.seq ||
    holder?.owner_token !== marker.owner_token
  ) {
    return null;
  }
  const updated = { ...holder, ...values };
  atomicJson(lockPath, updated);
  Object.assign(marker, updated);
  return updated;
};

const waitForReceipt = (place, seq, timeoutMs) => {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const receiptFile = findReceipt(place, seq);
    if (receiptFile) {
      try {
        return JSON.parse(readFileSync(receiptFile, "utf8"));
      } catch {
        /* atomic rename means this can only be a foreign/manual file */
      }
    }
    const marker = readMarker(place.lockPath);
    if (marker?.seq === seq) {
      const supervisorPid = marker.supervisor_pid ?? marker.pid;
      if (Number.isInteger(supervisorPid) && !processAlive(supervisorPid)) {
        return {
          ok: false,
          status: "worker-lost",
          seq,
          reason: `the supervisor pid ${supervisorPid} exited before it wrote a receipt`,
          partner_pid: marker.partner_pid ?? marker.child_pid ?? null,
        };
      }
    } else if (marker == null && Date.now() - started > START_TIMEOUT_MS) {
      return {
        ok: false,
        status: "worker-lost",
        seq,
        reason: "the turn has no receipt and no in-flight marker",
      };
    }
    sleepSync(WAIT_POLL_MS);
  }
  return {
    ok: false,
    status: "wait-timeout",
    seq,
    reason: `no receipt appeared within ${Math.round(timeoutMs / 60000)}m`,
  };
};

const updateTerminalState = (place, stateAtStart, { cancelled, forkSessionId }) => {
  const current = readState(place.statePath) ?? stateAtStart;
  const next = { ...current };
  next.grok_cancelled_consecutive = cancelled
    ? (current.grok_cancelled_consecutive ?? 0) + 1
    : 0;

  const pending = current.pending_fork;
  if (pending && forkSessionId === pending.new_sid) {
    next.sid = pending.new_sid;
    next.forked = [
      ...(Array.isArray(current.forked) ? current.forked : []),
      {
        sid: pending.old_sid,
        forked_at: new Date().toISOString(),
        successor_sid: pending.new_sid,
      },
    ];
    next.pending_fork = null;
  } else if (pending && pending.attempted_seq === stateAtStart.seq) {
    next.pending_fork = {
      ...pending,
      failed_at: new Date().toISOString(),
    };
  }
  writeState(place.statePath, next);
  return next;
};

const runWorker = () => {
  const place = requirePlace();
  const seq = Number(opt("seq"));
  const kind = opt("kind");
  const token = opt("worker-token");
  const idleMs = Number(opt("idle-ms"));
  const totalMs = Number(opt("total-ms"));
  const write = opt("write-value") === "true";
  const state = readState(place.statePath);
  if (!state?.sid || !Number.isInteger(seq) || !kind || !token) process.exit(2);
  const marker = readMarker(place.lockPath);
  if (
    marker?.seq !== seq ||
    marker?.owner_token !== token ||
    marker?.supervisor_pid !== process.pid
  ) {
    process.exit(2);
  }

  const paths = turnPaths(place, seq, kind);
  const pendingFork = state.pending_fork?.attempted_seq === seq
    ? state.pending_fork
    : null;
  const messageSid = pendingFork?.new_sid ?? state.sid;
  const { bin, args, promptVia } = turnCommand({
    partner: state.partner,
    sid: state.sid,
    resume: pendingFork
      ? { fork: true, oldSid: pendingFork.old_sid, newSid: pendingFork.new_sid }
      : true,
    replyFile: paths.replyFile,
    promptFile: paths.promptFile,
    root: place.root,
    write,
    effort: state.partner === "claude" ? state.effort : null,
  });

  const base = {
    seq,
    transcript: paths.transcriptPath,
    reply_file: paths.replyFile,
    receipt_file: paths.receiptFile,
    sid: messageSid,
    partner: state.partner,
    kind,
    write,
    supervisor_pid: process.pid,
    command: [bin, ...args],
  };

  const finish = (extra, code, { cancelled = false, forkSessionId = null } = {}) => {
    const terminalState = updateTerminalState(place, state, { cancelled, forkSessionId });
    const advice =
      cancelled && terminalState.grok_cancelled_consecutive >= 2
        ? "two consecutive Grok cancellations: schedule a fresh session fork with the fork command"
        : null;
    let record = {
      ...base,
      ...extra,
      ...(advice ? { recovery: advice } : {}),
    };
    atomicJson(paths.receiptFile, record);
    const released = releaseMarker(place.lockPath, marker);
    if (released.note) {
      record = { ...record, in_flight_note: released.note };
      atomicJson(paths.receiptFile, record);
    }
    process.exitCode = code;
  };

  supervise({
    bin,
    args,
    cwd: place.root,
    prompt: promptVia === "file" ? "" : readFileSync(paths.promptFile, "utf8"),
    transcriptPath: paths.transcriptPath,
    idleMs,
    totalMs,
    onSpawn: (partnerPid) => {
      const updated = replaceOwnedMarker(place.lockPath, marker, {
        launcher_pid: null,
        supervisor_pid: process.pid,
        partner_pid: Number.isInteger(partnerPid) ? partnerPid : null,
      });
      if (!updated) process.exit(2);
      atomicJson(paths.startedFile, {
        ok: true,
        status: "running",
        seq,
        sid: messageSid,
        supervisor_pid: process.pid,
        partner_pid: updated.partner_pid,
        transcript: paths.transcriptPath,
        reply_file: paths.replyFile,
        receipt_file: paths.receiptFile,
      });
    },
    onExit: ({ exit, transcript, seconds, spawnError }) => {
      const grok = state.partner === "grok" ? parseGrokStream(transcript) : null;
      const forkSessionId = pendingFork ? grok?.sessionId ?? null : null;
      const cancelled = grok?.stopReason === "cancelled";
      if (spawnError) {
        finish({ ok: false, status: "failed", reason: `cannot run ${bin}: ${spawnError.message}`, seconds }, 1, { forkSessionId });
        return;
      }
      if (exit !== 0) {
        finish({ ok: false, status: "failed", reason: `${bin} exited ${exit} — read the transcript`, exit_code: exit, seconds }, 1, { forkSessionId });
        return;
      }
      if (cancelled) {
        finish({ ok: false, status: "failed", reason: "grok-cancelled", exit_code: exit, seconds }, 1, { cancelled: true, forkSessionId });
        return;
      }
      if (state.partner === "claude" && parseClaudeResult(transcript)?.is_error) {
        finish({ ok: false, status: "failed", reason: "the partner run reported is_error", exit_code: exit, seconds }, 1, { forkSessionId });
        return;
      }
      if (state.partner === "cursor" && parseCursorResult(transcript)?.is_error) {
        finish({ ok: false, status: "failed", reason: "the partner run reported is_error", exit_code: exit, seconds }, 1, { forkSessionId });
        return;
      }
      const reply = writeReply(state.partner, paths.replyFile, transcript);
      if (!reply) {
        finish({ ok: false, status: "empty-reply", reason: "the partner exited 0 with no reply — read the transcript before resending, the prompt may already be consumed", exit_code: exit, seconds }, 1, { forkSessionId });
        return;
      }
      finish({ ok: true, status: "replied", exit_code: exit, seconds, reply }, 0, { forkSessionId });
    },
    onHang: ({ why, transcript, seconds }) => {
      const partial = writeReply(state.partner, paths.replyFile, transcript);
      finish(
        {
          ok: false,
          status: "hang-killed",
          reason: `hang: ${why}`,
          seconds,
          ...(partial ? { partial_reply: true } : {}),
        },
        1,
      );
    },
  });
};

const runSend = () => {
  const place = requirePlace();
  const kind = opt("kind");
  const bodyFile = opt("body-file");
  if (!kind) fail("missing --kind", 2);
  if (!KINDS.has(kind)) fail(`unknown kind ${kind} — use one of ${[...KINDS].join(", ")}`, 2);
  if (!bodyFile) fail("missing --body-file", 2);
  if (!existsSync(bodyFile)) fail(`no body file at ${bodyFile}`, 2);

  const state = readState(place.statePath);
  if (!state?.sid) fail(`no pair session in ${place.statePath} — run init first`);
  const lease = resolveWrite(state.role ?? "peer", { write: flag("write"), readOnly: flag("read-only") });
  if (lease.error) fail(lease.error, 2);
  const write = lease.write;

  if (state.pending_fork?.attempted_seq) {
    fail(
      `fork to ${state.pending_fork.new_sid} did not complete — inspect seq ${state.pending_fork.attempted_seq}, then run fork --retry to schedule a new target`,
    );
  }
  const seq = (state.seq ?? 0) + 1;
  mkdirSync(place.transcripts, { recursive: true });
  const paths = turnPaths(place, seq, kind);
  const body = readFileSync(bodyFile, "utf8");
  if (!body.trim()) fail("the body file is empty — a partner turn needs a message", 2);
  // Read before the marker is written, so a usage error never leaves one behind.
  const { idleMs, totalMs } = deadlines();

  // Half-duplex means one turn at a time: a second send would resume one CLI
  // session twice at once. The lock is taken before anything is spawned or the
  // counter moves, so a refused send costs nothing.
  const marker = {
    seq,
    owner_token: randomUUID(),
    launcher_pid: process.pid,
    supervisor_pid: null,
    partner_pid: null,
    kind,
    started_at: new Date().toISOString(),
  };
  const lock = acquireMarker(place.lockPath, marker);
  if (lock.error) fail(lock.error);
  if (lock.holder) {
    fail(
      `seq ${lock.holder.seq} is in flight as pid ${lock.holder.partner_pid ?? lock.holder.child_pid ?? lock.holder.supervisor_pid ?? lock.holder.pid} since ${lock.holder.started_at} — a headless pair runs one turn at a time; wait for it or kill that process`,
    );
  }
  if (lock.unreadable) {
    fail(
      `the in-flight marker ${place.lockPath} cannot be read, so a turn is treated as running — read it, confirm no partner process remains, then remove it`,
    );
  }
  if (lock.dead) {
    fail(
      `seq ${lock.dead.seq} was left in flight by pid ${lock.dead.partner_pid ?? lock.dead.child_pid ?? lock.dead.supervisor_pid ?? lock.dead.pid} since ${lock.dead.started_at} and none of its processes are alive — clear it with: node ${helperPath} clear --repo ${place.root}`,
    );
  }

  // The counter advances before the turn: a crashed or killed run must never
  // let the next send reuse a sequence number the partner has already seen.
  const pendingFork = state.pending_fork
    ? { ...state.pending_fork, attempted_seq: seq }
    : null;
  const messageSid = pendingFork?.new_sid ?? state.sid;
  writeState(place.statePath, {
    ...state,
    seq,
    in_flight: null,
    ...(pendingFork ? { pending_fork: pendingFork } : {}),
  });
  const prompt = messagePrompt({
    self: state.self ?? "lead",
    partner: state.partner,
    kind,
    sid: messageSid,
    body: pendingFork
      ? `Session fork: ${pendingFork.old_sid} is now ${pendingFork.new_sid}. Use the new sid in every reply.\n\n${body}`
      : body,
  });
  writeFileSync(paths.promptFile, prompt);

  const worker = spawn(
    process.execPath,
    [
      helperPath,
      "_worker",
      "--repo",
      place.root,
      "--seq",
      String(seq),
      "--kind",
      kind,
      "--worker-token",
      marker.owner_token,
      "--write-value",
      String(write),
      "--idle-ms",
      String(idleMs),
      "--total-ms",
      String(totalMs),
    ],
    { cwd: place.root, detached: true, stdio: "ignore", env: process.env },
  );
  worker.unref();
  if (!Number.isInteger(worker.pid)) {
    releaseMarker(place.lockPath, marker);
    fail("could not start the detached turn supervisor");
  }
  if (!replaceOwnedMarker(place.lockPath, marker, {
    launcher_pid: null,
    supervisor_pid: worker.pid,
  })) {
    fail("the in-flight marker changed before the supervisor took ownership");
  }

  const handshakeStarted = Date.now();
  while (!existsSync(paths.startedFile)) {
    if (!processAlive(worker.pid)) {
      fail(`the detached supervisor pid ${worker.pid} exited before startup`);
    }
    if (Date.now() - handshakeStarted > START_TIMEOUT_MS) {
      fail(`the detached supervisor pid ${worker.pid} did not start within ${START_TIMEOUT_MS / 1000}s`);
    }
    sleepSync(WAIT_POLL_MS);
  }
  const running = JSON.parse(readFileSync(paths.startedFile, "utf8"));
  unlinkSync(paths.startedFile);
  if (flag("background")) emit(running, 0);
  const final = waitForReceipt(place, seq, totalMs + 60000);
  emit(final, final.ok ? 0 : 1);
};

const runWait = () => {
  const place = requirePlace();
  const state = readState(place.statePath);
  if (!state?.sid) fail(`no pair session in ${place.statePath} — run init first`);
  const rawSeq = opt("seq", String(state.seq ?? 0));
  const seq = Number(rawSeq);
  if (!Number.isInteger(seq) || seq < 1) fail(`--seq must be a positive integer, got ${rawSeq}`, 2);
  const timeout = minutesToMs(opt("timeout-min", "65"), "timeout-min");
  if (timeout.error) fail(timeout.error, 2);
  const receipt = waitForReceipt(place, seq, timeout.ms);
  emit(receipt, receipt.ok ? 0 : 1);
};

const runFork = () => {
  const place = requirePlace();
  const state = readState(place.statePath);
  if (!state?.sid) fail(`no pair session in ${place.statePath} — run init first`);
  if (state.partner !== "grok") fail("fork is available only for a Grok partner");
  if (existsSync(place.lockPath)) fail("a turn is in flight — wait for its receipt before scheduling a fork");
  if (state.pending_fork && !flag("retry")) {
    fail(`a fork from ${state.pending_fork.old_sid} to ${state.pending_fork.new_sid} is already pending`);
  }
  const pending = {
    old_sid: state.sid,
    new_sid: randomUUID(),
    scheduled_at: new Date().toISOString(),
  };
  writeState(place.statePath, { ...state, pending_fork: pending });
  emit(
    {
      ok: true,
      status: "fork-scheduled",
      sid: state.sid,
      pending_sid: pending.new_sid,
      partner: state.partner,
      state_file: place.statePath,
      next: "the fork runs on the next send",
    },
    0,
  );
};

const runStatus = () => {
  const place = requirePlace();
  const state = readState(place.statePath);
  if (!state?.sid) fail(`no pair session in ${place.statePath} — run init first`);
  emit(
    {
      ok: true,
      sid: state.sid,
      partner: state.partner,
      role: state.role ?? "peer",
      model: state.model ?? null,
      effort: state.effort ?? null,
      seq: state.seq ?? 0,
      created_at: state.created_at,
      state_file: place.statePath,
      transcripts: state.transcripts ?? place.transcripts,
      session_known: sessionKnown(state.partner, state.sid, place.root),
      in_flight: readMarker(place.lockPath),
      grok_cancelled_consecutive: state.grok_cancelled_consecutive ?? 0,
      pending_fork: state.pending_fork ?? null,
      forked: state.forked ?? [],
    },
    0,
  );
};

// The one place a marker is removed. A send never takes a lock over, because
// `unlink` cannot compare-and-remove; here the removal is a rename, which is
// the one-winner primitive: a concurrent clear gets ENOENT and reports that
// someone else already did it. The renamed file is then checked against the
// bytes that were judged dead, so a live marker that slipped in between the
// judgement and the capture is put back rather than discarded.
// `beforeRename` is the interleaving window itself: everything the verification
// below defends against happens between judging the bytes and capturing them.
export const clearMarker = (lockPath, { beforeRename = () => {} } = {}) => {
  const captured = `${lockPath}.cleared.${process.pid}`;
  let before;
  try {
    before = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "already-cleared" };
    return { error: `cannot read the in-flight marker ${lockPath}: ${error.message}` };
  }

  let marker = null;
  try {
    marker = JSON.parse(before);
  } catch {
    /* judged below */
  }
  if (!marker) {
    return {
      error: `the in-flight marker ${lockPath} cannot be read — inspect it by hand and remove it once no partner process remains`,
    };
  }
  if (markerAlive(marker)) {
    return {
      error: `seq ${marker.seq} is still in flight as pid ${marker.partner_pid ?? marker.child_pid ?? marker.supervisor_pid ?? marker.pid ?? marker.launcher_pid} — clear it only after that process is gone`,
    };
  }

  beforeRename();
  try {
    renameSync(lockPath, captured);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "already-cleared" };
    return { error: `cannot capture the in-flight marker ${lockPath}: ${error.message}` };
  }

  // The rename took whatever was there, which is not necessarily what was
  // judged dead. A fresh lock goes back where it came from; nothing is deleted
  // on a mismatch.
  if (readFileSync(captured, "utf8") !== before) {
    try {
      linkSync(captured, lockPath);
      unlinkSync(captured);
      return {
        error: `the in-flight marker changed while it was being cleared, so it was put back — read ${lockPath} and try again`,
      };
    } catch (error) {
      return {
        error: `the in-flight marker changed while it was being cleared and could not be put back (${error.message}) — reconcile ${lockPath} and ${captured} by hand; nothing was deleted`,
      };
    }
  }

  unlinkSync(captured);
  return { status: "cleared", marker };
};

const runClear = () => {
  const place = requirePlace();
  const outcome = clearMarker(place.lockPath);
  if (outcome.error) fail(outcome.error);
  emit({ ok: true, status: outcome.status, lock_file: place.lockPath, ...(outcome.marker ? { marker: outcome.marker } : {}) }, 0);
};

const runEnd = () => {
  const place = requirePlace();
  if (!existsSync(place.stateDir)) fail(`no pair session at ${place.stateDir}`);
  // Ending under a live marker would trash the running turn's transcript and
  // reply target mid-write and leave a write-lease partner editing the
  // workspace with no record of it.
  if (existsSync(place.lockPath)) {
    fail(
      `a turn is in flight (or its marker remains) at ${place.lockPath} — wait for it to finish, or run clear first`,
    );
  }
  const trashed = spawnSync("trash", [place.stateDir], { encoding: "utf8" });
  if (trashed.error) fail(`trash is required to end a pair: ${trashed.error.message}`);
  if (trashed.status !== 0) fail(`trash failed: ${(trashed.stderr || "").trim()}`);
  emit({ ok: true, status: "ended", trashed: place.stateDir }, 0);
};

const COMMANDS = {
  init: runInit,
  send: runSend,
  wait: runWait,
  fork: runFork,
  status: runStatus,
  clear: runClear,
  end: runEnd,
  _worker: runWorker,
};

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const run = COMMANDS[command];
  if (!run) {
    fail(
      `usage: pair-headless.mjs <init|send|wait|fork|status|clear|end> --repo <root> [--partner ${kindList}] [--model <name>] [--effort <level>] [--role peer|executor] [--kind <kind>] [--body-file <path>] [--write|--read-only] [--background] [--seq N] [--timeout-min N] [--idle-min N] [--total-min N]`,
      2,
    );
  }
  run();
}
