#!/usr/bin/env node
// Active-session, render, and stream helpers for consult.sh. Node port of the
// former inline shell heredocs — zero runtime interpreter dependency. Modes:
//   init | mark-establishing | extract-result | render |
//   record-error | record-render-error | record-success
// Behavior (sha256 workspace hash, JSON key ordering, atomic writes, ISO
// timestamps) is preserved so sessions created by the old python still resolve.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fail = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

// UTC ISO at seconds precision with a Z suffix: 2026-06-30T16:00:00Z
const nowZ = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
// Compact UTC stamp: 20260630T160000Z
const compactTs = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";

const safeKind = (value) => {
  const v = String(value)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return v || "pair";
};

// Recursive key-sort to match python json.dump(sort_keys=True).
const sortDeep = (v) => {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
};
const dump = (obj) => JSON.stringify(sortDeep(obj), null, 2) + "\n";

const writeState = (p, state) => {
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, dump(state));
  fs.renameSync(tmp, p); // atomic replace on POSIX and Windows
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const resolvePath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// A claude session signal = any session_id in the json result or the jsonl stream.
const hasSessionSignal = (jsonPath, streamPath) => {
  for (const p of [jsonPath, streamPath]) {
    if (!fs.existsSync(p)) continue;
    try {
      if (p.endsWith(".jsonl")) {
        for (const line of fs.readFileSync(p, "utf8").split("\n")) {
          if (!line.trim()) continue;
          let data;
          try {
            data = JSON.parse(line);
          } catch {
            continue;
          }
          if (isObj(data) && data.session_id) return true;
        }
      } else {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        if (isObj(data) && data.session_id) return true;
      }
    } catch {
      continue;
    }
  }
  return false;
};

const [mode, ...args] = process.argv.slice(2);

if (mode === "init") {
  const [workspace, kind, goal, newRequested] = args;
  const forceNew = newRequested === "true";
  const workspacePath = resolvePath(workspace);
  const workspaceHash = crypto
    .createHash("sha256")
    .update(workspacePath, "utf8")
    .digest("hex")
    .slice(0, 16);
  const root = path.join(os.homedir(), ".agents-pair", "workspaces", workspaceHash);
  const activePath = path.join(root, "active-session.json");
  fs.mkdirSync(root, { recursive: true });

  const newState = () => {
    const pairSessionId = `${compactTs()}-${safeKind(kind)}`;
    const transcriptDir = path.join(root, "sessions", pairSessionId, "transcript");
    fs.mkdirSync(transcriptDir, { recursive: true });
    const ts = nowZ();
    return {
      workspace_root: workspacePath,
      workspace_hash: workspaceHash,
      session_id: pairSessionId,
      claude_session_id: crypto.randomUUID(),
      goal,
      model: null,
      effort: null,
      capability_profile: "peer-autonomous",
      status: "active",
      session_established: false,
      session_establishing: false,
      turn: 0,
      no_progress_count: 0,
      checkpoints: [],
      created_at: ts,
      updated_at: ts,
    };
  };

  let state = null;
  const exists = fs.existsSync(activePath);
  if (exists && forceNew) {
    const existing = readJson(activePath);
    const recorded = resolvePath(existing.workspace_root || "");
    if (recorded !== workspacePath)
      fail(`error: active-session workspace mismatch: ${recorded} != ${workspacePath}`);
    const archiveDir = path.join(root, "sessions", String(existing.session_id ?? "unknown"));
    fs.mkdirSync(archiveDir, { recursive: true });
    existing.status = "stale";
    existing.stale_reason = "replaced by --new-active-session";
    existing.updated_at = nowZ();
    fs.writeFileSync(path.join(archiveDir, "session-state.json"), dump(existing));
    state = newState();
    state.replaces_session_id = existing.session_id ?? null;
    writeState(activePath, state);
  } else if (exists) {
    state = readJson(activePath);
    const recorded = resolvePath(state.workspace_root || "");
    if (recorded !== workspacePath)
      fail(`error: active-session workspace mismatch: ${recorded} != ${workspacePath}`);
    if (state.status !== "active") {
      state = newState();
      writeState(activePath, state);
    }
  } else {
    state = newState();
    writeState(activePath, state);
  }

  if (goal && !state.goal) {
    state.goal = goal;
    state.updated_at = nowZ();
    writeState(activePath, state);
  } else if (goal && state.goal && state.goal !== goal) {
    fail(
      "error: active pair-session goal differs from --goal; omit --goal to continue the existing session " +
        "or pass --new-active-session after recording why the old session is stale",
    );
  }

  if (!("session_established" in state)) {
    fail(
      "error: active-session.json is from an older format and lacks session_established; " +
        "resume it once explicitly with --session-id ... --resume or mark it stale before using --active-session",
    );
  }
  const claudeSessionId = state.claude_session_id;
  if (!claudeSessionId) fail("error: active-session.json is missing claude_session_id");

  const transcriptDir = path.join(root, "sessions", state.session_id, "transcript");
  fs.mkdirSync(transcriptDir, { recursive: true });

  console.log(activePath);
  console.log(state.session_id);
  console.log(transcriptDir);
  console.log(claudeSessionId);
  console.log(state.session_established || state.session_establishing ? "true" : "false");
} else if (mode === "mark-establishing") {
  const [statePath, kind] = args;
  const state = readJson(statePath);
  state.session_establishing = true;
  state.last_attempt_kind = kind;
  state.updated_at = nowZ();
  writeState(statePath, state);
} else if (mode === "extract-result") {
  const [streamPath, jsonPath] = args;
  let result = null;
  for (const line of fs.readFileSync(streamPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (isObj(event) && event.type === "result") result = event;
  }
  if (result === null) fail(`error: no result event found in stream: ${streamPath}`, 2);
  fs.writeFileSync(jsonPath, dump(result));
} else if (mode === "render") {
  const [jsonPath, mdPath, streamPath] = args;
  const data = readJson(jsonPath);
  const structured = data.structured_output;
  const isPeer = isObj(structured) && "message_to_codex" in structured;

  const renderPeer = (peer) => {
    const lines = ["# Claude peer message", "", String(peer.message_to_codex || "").trim(), ""];
    const questions = peer.questions_for_codex || [];
    if (questions.length) {
      lines.push("## Questions for Codex", ...questions.map((q) => `- ${q}`), "");
    }
    const disagreements = peer.disagreements || [];
    if (disagreements.length) {
      lines.push("## Disagreements", ...disagreements.map((d) => `- ${d}`), "");
    }
    const nxt = peer.proposed_next_turn || {};
    if (Object.keys(nxt).length) {
      lines.push("## Proposed next turn");
      if (nxt.owner) lines.push(`- owner: ${nxt.owner}`);
      if (nxt.goal) lines.push(`- goal: ${nxt.goal}`);
      for (const tf of nxt.target_files || []) lines.push(`- target: ${tf}`);
      for (const v of nxt.validation || []) lines.push(`- validation: ${v}`);
      lines.push("");
    }
    const changed = peer.changed_files || [];
    if (changed.length) {
      lines.push("## Changed files");
      for (const c of changed) {
        const p = c.path || "";
        const summ = c.summary || "";
        lines.push(`- ${p}${summ ? " - " + summ : ""}`);
      }
      lines.push("");
    }
    const asks = peer.validation_requests || [];
    if (asks.length) {
      lines.push("## Validation requests", ...asks.map((a) => `- ${a}`), "");
    }
    const st = peer.continuation_state || {};
    if (Object.keys(st).length) {
      const status = st.status || "";
      const reason = st.reason || "";
      lines.push(`## Continuation: ${status}${reason ? " - " + reason : ""}`, "");
    }
    return lines.join("\n").replace(/\s+$/, "") + "\n";
  };

  let result;
  if (isPeer) result = renderPeer(structured);
  else if (structured != null) result = JSON.stringify(sortDeep(structured), null, 2);
  else {
    result = data.result ?? "";
    if (typeof result !== "string") result = JSON.stringify(sortDeep(result), null, 2);
  }
  let md = result;
  if (md && !md.endsWith("\n")) md += "\n";
  fs.writeFileSync(mdPath, md);

  const summary = {
    json: jsonPath,
    markdown: mdPath,
    is_error: data.is_error ?? false,
    session_id: data.session_id ?? null,
    duration_ms: data.duration_ms ?? null,
    num_turns: data.num_turns ?? null,
    has_structured_output: structured != null,
    is_peer_message: isPeer,
  };
  if (fs.existsSync(streamPath)) summary.stream = streamPath;
  if (isPeer) {
    const st = structured.continuation_state || {};
    summary.peer = {
      message_to_codex: structured.message_to_codex || "",
      questions_for_codex: structured.questions_for_codex || [],
      continuation_status: st.status ?? null,
      next_owner: (structured.proposed_next_turn || {}).owner ?? null,
    };
  }
  console.log(JSON.stringify(sortDeep(summary)));
  if (data.is_error) process.exit(2);
} else if (mode === "record-error" || mode === "record-render-error") {
  const [statePath, jsonPath, streamPath, status] = args;
  const state = readJson(statePath);
  if (!state.session_established && !hasSessionSignal(jsonPath, streamPath))
    state.session_establishing = false;
  state.last_error_status = parseInt(status, 10);
  if (mode === "record-render-error") state.last_error_stage = "render";
  state.updated_at = nowZ();
  writeState(statePath, state);
} else if (mode === "record-success") {
  const [statePath, jsonPath, mdPath, streamPath, model, effort, kind] = args;
  const state = readJson(statePath);
  const result = readJson(jsonPath);
  if (result.is_error) process.exit(0);

  const structured = result.structured_output;
  let peerStatus = null;
  let nextOwner = null;
  if (isObj(structured)) {
    peerStatus = (structured.continuation_state || {}).status ?? null;
    nextOwner = (structured.proposed_next_turn || {}).owner ?? null;
  }

  const turn = parseInt(state.turn || 0, 10) + 1;
  const checkpoint = {
    turn,
    kind,
    json: jsonPath,
    markdown: mdPath,
    updated_at: nowZ(),
  };
  if (fs.existsSync(streamPath)) checkpoint.stream = streamPath;
  if (peerStatus) checkpoint.peer_status = peerStatus;
  if (nextOwner) checkpoint.next_owner = nextOwner;

  state.claude_session_id = result.session_id || state.claude_session_id;
  state.session_established = true;
  state.session_establishing = false;
  state.model = model;
  state.effort = effort;
  state.turn = turn;
  state.last_kind = kind;
  state.last_json = jsonPath;
  state.last_markdown = mdPath;
  if (fs.existsSync(streamPath)) state.last_stream = streamPath;
  state.last_peer_status = peerStatus;
  state.last_next_owner = nextOwner;
  state.updated_at = nowZ();
  if (!Array.isArray(state.checkpoints)) state.checkpoints = [];
  state.checkpoints.push(checkpoint);
  state.checkpoints = state.checkpoints.slice(-50);
  writeState(statePath, state);
} else {
  fail(`error: unknown session-state mode: ${mode}`);
}
