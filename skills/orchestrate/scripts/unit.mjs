#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const headlessPairScript = process.env.ORCHESTRATE_PAIR_SCRIPT ??
  join(scriptDir, "../../pair/scripts/pair-headless.mjs");
const herdrPairScript = process.env.ORCHESTRATE_HERDR_PAIR_SCRIPT ??
  join(scriptDir, "../../pair/scripts/herdr-pair.mjs");
const partnerKinds = new Set(["claude", "codex", "cursor", "grok", "opencode"]);
const pairBackends = new Set(["headless", "herdr"]);
const mergePolicies = new Set(["auto", "hold"]);
const timeoutFromEnvironment = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const defaultCommandTimeoutMs = timeoutFromEnvironment(
  "ORCHESTRATE_COMMAND_TIMEOUT_MS",
  2 * 60 * 1000,
);
const longCommandTimeoutMs = timeoutFromEnvironment(
  "ORCHESTRATE_LONG_COMMAND_TIMEOUT_MS",
  30 * 60 * 1000,
);
const pairSendTimeoutMs = timeoutFromEnvironment(
  "ORCHESTRATE_PAIR_SEND_TIMEOUT_MS",
  5 * 60 * 1000,
);
const commandMaxBufferBytes = timeoutFromEnvironment(
  "ORCHESTRATE_MAX_BUFFER_BYTES",
  64 * 1024 * 1024,
);

class CliExit extends Error {
  constructor(code) {
    super("cli-exit");
    this.code = code;
  }
}

const emit = (value, code = 0) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  throw new CliExit(code);
};
const fail = (reason, detail = null, code = 1) =>
  emit({ ok: false, reason, ...(detail ? { detail } : {}) }, code);

const parseOptions = (args) => {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith("--")) fail(`unexpected argument: ${token}`, null, 2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${token}`, null, 2);
    options[token.slice(2)] = value;
    index += 1;
  }
  return options;
};

const run = (command, args, options = {}) => {
  const { detached = process.platform !== "win32", ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: commandMaxBufferBytes,
    timeout: defaultCommandTimeoutMs,
    killSignal: "SIGKILL",
    detached,
    ...spawnOptions,
  });
  const leaderWasKilled = result.status === null && (result.error || result.signal);
  if (leaderWasKilled && Number.isInteger(result.pid) && result.pid > 0) {
    if (detached && process.platform !== "win32") {
      try { process.kill(-result.pid, "SIGKILL"); } catch {}
    } else if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(result.pid), "/t", "/f"], {
        encoding: "utf8",
        timeout: defaultCommandTimeoutMs,
      });
    }
  }
  return result;
};
const commandError = (result, label) =>
  `${label}: ${(
    result.error?.message ||
    result.stderr ||
    result.stdout ||
    (result.signal ? `signal ${result.signal}` : `exit ${result.status}`)
  ).trim()}`;
const runChecked = (command, args, options, label) => {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(commandError(result, label));
  return result;
};
const git = (repo, ...args) => run("git", ["-C", repo, ...args]);
const gitChecked = (repo, args, label) => runChecked("git", ["-C", repo, ...args], {}, label);

const parseJson = (text, label) => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
};

const repository = (candidate) => {
  if (!candidate) fail("--repo is required", null, 2);
  const top = git(candidate, "rev-parse", "--show-toplevel");
  const common = git(candidate, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (top.status !== 0 || common.status !== 0) fail(`not a git repository: ${candidate}`);
  const root = top.stdout.trim();
  const commonRaw = common.stdout.trim();
  const commonGitDir = isAbsolute(commonRaw) ? commonRaw : resolve(root, commonRaw);
  const registry = join(commonGitDir, "orchestrate");
  return {
    root,
    commonGitDir,
    registry,
    units: join(registry, "units"),
    lock: join(registry, "registry.lock"),
  };
};

const unitId = (value) => {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/u.test(value)) {
    fail("--unit must match [A-Za-z0-9][A-Za-z0-9_.+-]{0,63}", null, 2);
  }
  return value;
};
const selectedBackend = (options) => {
  const backend = options.backend ?? (process.env.HERDR_ENV === "1" ? "herdr" : "headless");
  if (!pairBackends.has(backend)) fail("--backend must be headless or herdr", null, 2);
  return backend;
};
const normalizeBackend = (record) => {
  record.backend ??= "headless";
  if (!pairBackends.has(record.backend)) {
    fail(`unit ${record.unit_id} records unknown backend ${record.backend}`);
  }
  return record.backend;
};
const ensureBackendOverride = (record, options) => {
  const backend = normalizeBackend(record);
  if (options.backend && options.backend !== backend) {
    fail(`unit ${record.unit_id} backend differs`, {
      recorded: backend,
      requested: options.backend,
    });
  }
  return backend;
};
const callerOptionNames = ["pane", "workspace", "tab-id", "as", "terminal-id", "repo-root"];
const requestedCaller = (options, place) => {
  for (const name of callerOptionNames) {
    if (!options[name]) fail(`Herdr backend requires --${name} from CALLER_ID`, null, 2);
  }
  if (options.as !== options.lead) {
    fail("Herdr CALLER_ID --as must match --lead", null, 2);
  }
  if (!isAbsolute(options["repo-root"])) {
    fail("Herdr CALLER_ID --repo-root must be absolute", null, 2);
  }
  let callerRoot;
  try {
    callerRoot = realpathSync(options["repo-root"]);
  } catch (error) {
    fail(`cannot resolve Herdr CALLER_ID --repo-root: ${error.message}`, null, 2);
  }
  if (callerRoot !== realpathSync(place.root)) {
    fail("Herdr CALLER_ID --repo-root must be the orchestrated repository root", null, 2);
  }
  return {
    pane: options.pane,
    workspace: options.workspace,
    tab_id: options["tab-id"],
    agent: options.as,
    terminal_id: options["terminal-id"],
    repo_root: options["repo-root"],
  };
};
const callerMatches = (left, right) =>
  ["pane", "workspace", "tab_id", "agent", "terminal_id", "repo_root"]
    .every((field) => left?.[field] === right?.[field]);
const recordPath = (place, id) => join(place.units, `${id}.json`);
const atomicWrite = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, path);
};
const atomicWriteText = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { flag: "wx" });
  renameSync(temporary, path);
};
const writeRecord = (path, record) => {
  record.updated_at = new Date().toISOString();
  atomicWrite(path, record);
};
const readRecord = (place, id) => {
  const path = recordPath(place, id);
  if (!existsSync(path)) fail(`unit ${id} is not recorded in ${place.units}`);
  try {
    return { path, record: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    fail(`cannot read unit ${id}: ${error.message}`);
  }
};

const withRegistryLock = (place, operation) => {
  mkdirSync(place.registry, { recursive: true });
  let staleClaim = null;
  try {
    mkdirSync(place.lock);
  } catch (error) {
    if (error?.code !== "EEXIST") fail(`cannot create orchestrate registry lock: ${error.message}`);
    let ownerRecord = null;
    const staleOwnerPath = join(place.lock, "owner.json");
    let staleOwnerText = null;
    try {
      staleOwnerText = readFileSync(staleOwnerPath, "utf8");
      ownerRecord = JSON.parse(staleOwnerText);
    } catch {}
    if (!Number.isInteger(ownerRecord?.pid) || ownerRecord.pid <= 0) {
      fail(`orchestrate registry is busy at ${place.lock}; its owner is not yet readable`);
    }
    let alive = true;
    try { process.kill(ownerRecord.pid, 0); } catch (killError) { alive = killError?.code === "EPERM"; }
    if (alive) fail(`orchestrate registry is busy at ${place.lock} (pid ${ownerRecord.pid})`);
    const recoveryPath = join(place.lock, "recovery.json");
    const recoveryToken = randomUUID();
    try {
      writeFileSync(
        recoveryPath,
        `${JSON.stringify({ pid: process.pid, token: recoveryToken, at: new Date().toISOString() })}\n`,
        { flag: "wx" },
      );
      if (readFileSync(staleOwnerPath, "utf8") !== staleOwnerText) {
        fail(`orchestrate registry lock changed while stale recovery was claimed at ${place.lock}`);
      }
    } catch (claimError) {
      try {
        const claim = JSON.parse(readFileSync(recoveryPath, "utf8"));
        if (claim.pid === process.pid && claim.token === recoveryToken) unlinkSync(recoveryPath);
      } catch {}
      if (claimError instanceof CliExit) throw claimError;
      fail(`orchestrate registry lock recovery is busy at ${place.lock}: ${claimError.message}`);
    }
    staleClaim = `${place.lock}.stale-${process.pid}-${randomUUID()}`;
    try {
      renameSync(place.lock, staleClaim);
      mkdirSync(place.lock);
    } catch (retryError) {
      if (staleClaim) {
        try { trashPath(staleClaim); } catch {}
      }
      fail(`cannot recover stale orchestrate registry lock: ${retryError.message}`);
    }
  }
  const ownerPath = join(place.lock, "owner.json");
  const ownerToken = randomUUID();
  try {
    writeFileSync(ownerPath, `${JSON.stringify({ pid: process.pid, token: ownerToken, at: new Date().toISOString() })}\n`, { flag: "wx" });
    const published = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (published.pid !== process.pid || published.token !== ownerToken) {
      throw new Error("published owner does not match this process");
    }
  } catch (error) {
    try {
      const published = JSON.parse(readFileSync(ownerPath, "utf8"));
      if (published.pid === process.pid && published.token === ownerToken) unlinkSync(ownerPath);
    } catch {}
    try { rmdirSync(place.lock); } catch {}
    fail(`cannot publish orchestrate registry lock owner: ${error.message}`);
  }
  if (staleClaim) {
    try { trashPath(staleClaim); } catch {}
  }
  try {
    return operation();
  } finally {
    try {
      const published = JSON.parse(readFileSync(ownerPath, "utf8"));
      if (published.pid === process.pid && published.token === ownerToken) {
        unlinkSync(ownerPath);
        rmdirSync(place.lock);
      }
    } catch {}
  }
};

const backendOf = (record) => record.backend ?? "headless";

const runPairHelper = (script, command, args, timeout) => {
  const result = run(process.execPath, [script, command, ...args], { timeout });
  if (result.status !== 0) {
    let detail = (result.stderr || result.stdout || "").trim();
    try { detail = JSON.parse(result.stdout).reason ?? detail; } catch {}
    throw new Error(`pair ${command} failed: ${detail || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
};

const headlessPair = (command, record, extra = []) => {
  // A real model bootstrap can exceed the general process limit. Headless send
  // only launches its background supervisor, but gets a smaller explicit
  // allowance so slow process startup does not hold the registry forever.
  const timeout = command === "init"
    ? longCommandTimeoutMs
    : command === "send"
      ? pairSendTimeoutMs
      : defaultCommandTimeoutMs;
  const output = runPairHelper(
    headlessPairScript,
    command,
    ["--repo", record.worktree, ...extra],
    timeout,
  );
  return parseJson(output, `pair ${command}`);
};

const herdrCallerArguments = (record) => {
  const caller = record.caller;
  if (!caller) throw new Error(`unit ${record.unit_id} has no recorded Herdr caller identity`);
  return [
    "--pane", caller.pane,
    "--workspace", caller.workspace,
    "--tab-id", caller.tab_id,
    "--as", caller.agent,
    "--terminal-id", caller.terminal_id,
    "--repo-root", caller.repo_root,
  ];
};

const herdrPair = (command, record, extra = [], { json = true } = {}) => {
  const timeout = ["spawn", "init"].includes(command)
    ? longCommandTimeoutMs
    : command === "send"
      ? pairSendTimeoutMs
      : defaultCommandTimeoutMs;
  const output = runPairHelper(
    herdrPairScript,
    command,
    [...herdrCallerArguments(record), ...extra],
    timeout,
  );
  return json ? parseJson(output, `pair ${command}`) : output;
};

const herdrStatus = (record) => {
  if (!record.pair?.sid) return { ok: false, reason: "no pair session recorded" };
  const response = herdrPair("reconcile", record, ["--sid", record.pair.sid]);
  const session = response.session;
  if (!session?.sid) throw new Error("pair reconcile returned no session");
  const partner = Object.keys(session.participants ?? {}).find(
    (kind) => kind !== record.lead && partnerKinds.has(kind),
  );
  if (!partner) throw new Error("pair reconcile returned no partner participant");
  const outgoingPending = session.delivery?.pending?.[record.lead] ?? null;
  const inboundPending = Object.entries(session.delivery?.pending ?? {})
    .filter(([agent, delivery]) => agent !== record.lead && delivery)
    .map(([agent, delivery]) => ({ agent, ...delivery }));
  const outgoingSeq = session.delivery?.submitted?.[record.lead] ?? 0;
  const acknowledgedSeq = session.delivery?.received?.[record.lead] ?? 0;
  return {
    ok: true,
    backend: "herdr",
    sid: session.sid,
    partner,
    role: session.role ?? null,
    model: session.model ?? null,
    effort: session.effort ?? null,
    seq: outgoingSeq,
    acknowledged_seq: acknowledgedSeq,
    session_active: session.active === true,
    in_flight: outgoingPending ? { agent: record.lead, ...outgoingPending } : null,
    inbound_pending: inboundPending,
    latest_receipt: null,
    delivery: session.delivery ?? null,
    last_status: session.last_status ?? null,
    completed_cycles: session.completed_cycles ?? 0,
    partner_pane: session.participants[partner]?.pane_id ?? record.pair.partner_pane ?? null,
    lineage: { current_sid: session.sid, forks: [] },
  };
};

const pairStatus = (record) => {
  if (backendOf(record) === "headless" && (!record.worktree || !existsSync(record.worktree))) {
    return { ok: false, reason: "worktree-missing" };
  }
  try {
    return backendOf(record) === "herdr"
      ? herdrStatus(record)
      : { ...headlessPair("status", record), backend: "headless" };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
};

const transportCheckpoint = (status) => status.latest_receipt ?? (
  status.backend === "herdr"
    ? {
        backend: "herdr",
        delivery: status.delivery,
        last_status: status.last_status,
        completed_cycles: status.completed_cycles,
      }
    : null
);

const staffingArguments = (staffing, backend) => {
  const args = [];
  if (staffing.model) args.push("--model", staffing.model);
  if (staffing.effort && !(backend === "herdr" && staffing.partner === "opencode")) {
    args.push("--effort", staffing.effort);
  }
  return args;
};

const initializePair = (record, path, staffing) => {
  if (backendOf(record) === "headless") {
    return headlessPair("init", record, [
      "--partner", staffing.partner,
      "--role", "executor",
      ...staffingArguments(staffing, "headless"),
    ]);
  }
  const spawnArgs = [
    "--partner", staffing.partner,
    "--partner-repo-root", record.worktree,
    "--autonomy", "full",
    ...staffingArguments(staffing, "herdr"),
  ];
  if (record.pair?.partner_pane) {
    spawnArgs.push("--partner-pane", record.pair.partner_pane);
  }
  const spawned = herdrPair("spawn", record, spawnArgs);
  const previousPane = record.pair?.partner_pane ?? null;
  const spawnedPane = spawned.partner?.pane_id ?? null;
  if (spawnedPane) {
    if (previousPane && previousPane !== spawnedPane) {
      record.pair_pane_history ??= [];
      record.pair_pane_history.push({
        from: previousPane,
        to: spawnedPane,
        replaced_at: new Date().toISOString(),
      });
    }
    record.pair = {
      ...record.pair,
      sid: null,
      latest_seq: 0,
      partner_pane: spawnedPane,
    };
    writeRecord(path, record);
  }
  if (spawned.partner?.agent !== staffing.partner || !spawnedPane) {
    throw new Error(`pair spawn did not return the requested ${staffing.partner} pane`);
  }
  const session = herdrPair("init", record, [
    "--partner-pane", spawnedPane,
    "--partner-repo-root", record.worktree,
    "--role", "executor",
    ...staffingArguments(staffing, "herdr"),
  ]);
  return {
    ok: true,
    backend: "herdr",
    sid: session.sid,
    partner: staffing.partner,
    role: session.role ?? null,
    model: session.model ?? null,
    effort: session.effort ?? null,
    seq: session.delivery?.submitted?.[record.lead] ?? 0,
    acknowledged_seq: session.delivery?.received?.[record.lead] ?? 0,
    partner_pane: spawnedPane,
  };
};

const sendPair = (record, bodyFile) => {
  if (backendOf(record) === "headless") {
    return headlessPair("send", record, [
      "--kind", "task", "--body-file", bodyFile, "--background",
    ]);
  }
  const response = herdrPair("send", record, [
    "--sid", record.pair.sid,
    "--kind", "task",
    "--body-file", bodyFile,
    "--format", "json",
  ]);
  if (!Number.isInteger(response.seq) || typeof response.receipt !== "string") {
    throw new Error(`pair send returned an unknown receipt: ${JSON.stringify(response)}`);
  }
  return {
    ok: true,
    status: response.receipt === "acknowledged" ? "running" : "delivery-unacknowledged",
    sid: record.pair.sid,
    seq: response.seq,
    delivery_receipt: response.receipt,
    reservation: response.reservation ?? null,
    submitted: response.submitted ?? null,
    received: response.received ?? null,
  };
};

const endPair = (record, { stale = false } = {}) => {
  if (backendOf(record) === "headless") return headlessPair("end", record);
  if (!record.pair?.sid) return { ok: true, status: "absent" };
  const output = herdrPair(
    "end",
    record,
    ["--sid", record.pair.sid, ...(stale ? ["--stale", "true"] : [])],
    { json: false },
  );
  return { ok: true, status: "ended", output };
};

const journalPairDelivery = (record, running) => {
  record.pair.latest_seq = running.seq ?? record.pair.latest_seq ?? 0;
  if (running.delivery_receipt) record.pair.delivery_receipt = running.delivery_receipt;
  if (running.reservation) record.pair.delivery_reservation = running.reservation;
  else delete record.pair.delivery_reservation;
  if (running.receipt_file) record.pair.latest_receipt_file = running.receipt_file;
};

const unacknowledgedDeliveryError = (running) =>
  `pair send was not acknowledged: ${JSON.stringify({
    receipt: running.delivery_receipt ?? null,
    reservation: running.reservation ?? null,
    seq: running.seq ?? null,
  })}`;

const herdrDeliveryNeedsSend = (status) =>
  status.backend === "herdr" &&
  !status.in_flight &&
  (status.seq ?? 0) > (status.acknowledged_seq ?? 0);

const herdrDeliveryIsProved = (status) =>
  status.backend !== "herdr" ||
  (status.seq ?? 0) === 0 ||
  (status.acknowledged_seq ?? 0) >= (status.seq ?? 0);

const lineageForks = (status) =>
  status.lineage?.forks ?? status.forked ?? [];

const lineageReaches = (status, recordedSid) => {
  if (!recordedSid || !status?.sid) return false;
  let sid = recordedSid;
  const seen = new Set();
  while (sid && !seen.has(sid)) {
    if (sid === status.sid) return true;
    seen.add(sid);
    sid = lineageForks(status).find((entry) => entry.sid === sid)?.successor_sid ?? null;
  }
  return false;
};

const reconcilePairHead = (record, status) => {
  if (!record.pair?.sid || !status?.ok) return { changed: false };
  if (!lineageReaches(status, record.pair.sid)) {
    return {
      changed: false,
      error: `unit ${record.unit_id} pair sid differs: expected ${record.pair.sid}, observed ${status.sid}`,
    };
  }
  let changed = false;
  if (record.pair.sid !== status.sid) {
    record.pair.sid = status.sid;
    changed = true;
  }
  const latestSeq = status.in_flight?.seq ?? status.seq ?? record.pair.latest_seq ?? 0;
  if (record.pair.latest_seq !== latestSeq) {
    record.pair.latest_seq = latestSeq;
    changed = true;
  }
  const receiptFile = status.latest_receipt?.receipt_file ?? null;
  if (receiptFile && record.pair.latest_receipt_file !== receiptFile) {
    record.pair.latest_receipt_file = receiptFile;
    changed = true;
  }
  return { changed };
};

const pullRequests = (repo, branch) => {
  const result = run("gh", [
    "pr", "list", "--state", "all", "--head", branch,
    "--json", "number,url,state,mergedAt,headRefOid,baseRefName,isDraft",
  ], { cwd: repo });
  if (result.status !== 0) return { ok: false, reason: commandError(result, "gh pr list") };
  try {
    return { ok: true, prs: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, reason: `gh pr list returned invalid JSON: ${error.message}` };
  }
};

const worktreeRows = (repo) => {
  const result = git(repo, "worktree", "list", "--porcelain");
  if (result.status !== 0) throw new Error(commandError(result, "git worktree list"));
  const rows = [];
  let current = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) rows.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (current && line === "prunable") {
      current.prunable = true;
    }
  }
  if (current) rows.push(current);
  return rows;
};

const describe = (place, record, observedPair = pairStatus(record)) => {
  const worktree = worktreeRows(place.root).find((row) => row.path === record.worktree) ?? null;
  return {
    ...record,
    observed: {
      worktree,
      pair: observedPair,
      latest_receipt: observedPair.ok ? observedPair.latest_receipt ?? null : null,
      pull_requests: pullRequests(record.worktree && existsSync(record.worktree) ? record.worktree : place.root, record.branch),
    },
  };
};

const listRecords = (place) => {
  if (!existsSync(place.units)) return [];
  return readdirSync(place.units)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(place.units, name), "utf8"));
      } catch (error) {
        return { unit_id: name.slice(0, -5), lifecycle: "unreadable", error: error.message };
      }
    });
};

const trashPath = (path) => {
  if (!existsSync(path)) return;
  const result = run("trash", [path]);
  if (result.status !== 0) throw new Error(commandError(result, `trash ${path}`));
};

const branchExists = (repo, branch) => {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    if (git(repo, "show-ref", "--verify", "--quiet", ref).status === 0) return ref;
  }
  return null;
};

const removeLocalBranch = (repo, branch) => {
  const result = git(repo, "branch", "-D", branch);
  if (result.status !== 0 && !/not found|not exist/u.test(result.stderr || "")) {
    throw new Error(commandError(result, "delete local branch"));
  }
};

const removeRemoteBranch = (repo, branch) => {
  const result = git(repo, "push", "origin", "--delete", branch);
  if (
    result.status !== 0 &&
    !/remote ref does not exist|couldn't find remote ref|No such remote/u.test(result.stderr || "")
  ) {
    throw new Error(commandError(result, "delete remote branch"));
  }
};

const recoverableCreatePhases = new Set([
  "creating",
  "setting-up",
  "initializing-pair",
  "starting",
]);
const normalizedModel = (value) => value === "CLI-default" || !value ? null : value;
const requestedStaffing = (options) => ({
  lead: options.lead,
  partner: options.partner,
  model: normalizedModel(options.model),
  effort: options.effort ?? null,
  reason: options.reason,
});
const validateStaffing = (
  options,
  command,
  { allowLegacyCursor = false, backend = "headless" } = {},
) => {
  for (const key of ["lead", "partner", "reason"]) {
    if (!options[key]) fail(`${command} requires --${key}`, null, 2);
  }
  if (!partnerKinds.has(options.lead) || !partnerKinds.has(options.partner)) {
    fail("--lead and --partner must be claude, codex, cursor, grok, or opencode", null, 2);
  }
  if (options.lead === options.partner) {
    fail("the partner arena must differ from the orchestrator harness", null, 2);
  }
  if (options.partner === "cursor") {
    const legacy = allowLegacyCursor && Boolean(options.effort);
    if (!legacy && (!options.model || options.model === "CLI-default")) {
      fail("cursor staffing requires an effort-specific --model from the live catalog", null, 2);
    }
    if (options.effort && !legacy) {
      fail("cursor staffing carries effort in the live-catalog model name; omit --effort", null, 2);
    }
  } else if (options.partner === "opencode" && backend === "herdr") {
    if (options.effort) {
      fail("OpenCode's Herdr TUI has no effort variant; omit --effort", null, 2);
    }
  } else if (!options.effort) {
    fail(`${command} requires --effort for ${options.partner}`, null, 2);
  }
};
const nestedValue = (value, path) => path.split(".").reduce((current, key) => current?.[key], value);
const ensureMatchingCreate = (record, options, task) => {
  const requestedWorktree = existsSync(options.worktree)
    ? realpathSync(options.worktree)
    : resolve(options.worktree);
  const recordedWorktree = existsSync(record.worktree)
    ? realpathSync(record.worktree)
    : resolve(record.worktree);
  const expected = new Map([
    ["branch", options.branch],
    ["base", options.base],
    ["lead", options.lead],
    ["staffing.current.partner", options.partner],
    ["staffing.current.model", normalizedModel(options.model)],
    ["staffing.current.effort", options.effort ?? null],
    ["staffing.current.reason", options.reason],
    ["scope", options.scope],
    ["validation", options.validation],
    ["merge_policy", options["merge-policy"]],
    ["setup", options.setup ?? null],
  ]);
  if (recordedWorktree !== requestedWorktree) {
    fail(`unit ${record.unit_id} cannot resume: worktree differs`, {
      recorded: record.worktree,
      requested: options.worktree,
    });
  }
  if (task !== null) expected.set("task", task);
  for (const [field, wanted] of expected) {
    const recorded = nestedValue(record, field);
    if (recorded !== wanted) {
      fail(`unit ${record.unit_id} cannot resume: ${field} differs`, { recorded, requested: wanted });
    }
  }
};
const ensureManifestTask = (place, record) => {
  const path = record.task_file ?? join(place.registry, "tasks", `${record.unit_id}.md`);
  const body = `${record.task.trim()}\n`;
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    const hasMarkedAddenda = current.startsWith(`${body}\n## Addendum — `);
    if (current !== body && !hasMarkedAddenda) {
      fail(`unit ${record.unit_id} manifest task differs at ${path}`);
    }
  } else {
    atomicWriteText(path, body);
  }
  record.task_file = path;
  record.resources.task_file = true;
  return path;
};
const ensurePrBodyExclude = (record) => {
  const rawPath = gitChecked(
    record.worktree,
    ["rev-parse", "--git-path", "info/exclude"],
    "resolve worktree exclude file",
  ).stdout.trim();
  const path = isAbsolute(rawPath) ? rawPath : resolve(record.worktree, rawPath);
  const pattern = "/PR_BODY.md";
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = current.split(/\r?\n/u).includes(pattern);
  if (!present) {
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    atomicWriteText(path, `${current}${separator}${pattern}\n`);
  }
  const previous = record.delivery_setup?.pr_body_exclude ?? null;
  record.delivery_setup ??= {};
  record.delivery_setup.pr_body_exclude = {
    path,
    pattern,
    added_by_unit: previous?.added_by_unit ?? !present,
    first_ensured_at: previous?.first_ensured_at ?? new Date().toISOString(),
    ensured_at: new Date().toISOString(),
  };
};
const migrateLegacyCursorCreate = (record, options, task) => {
  if (
    record.staffing.current.partner !== "cursor" ||
    !record.staffing.current.effort ||
    options.partner !== "cursor" ||
    options.effort ||
    !normalizedModel(options.model)
  ) return false;
  const status = pairStatus(record);
  if (status.ok) {
    fail(`unit ${record.unit_id} cannot migrate Cursor staffing while its recorded pair is live`);
  }
  if (existsSync(record.worktree) && !pairIsAbsent(status)) {
    fail(`cannot prove pair absence for Cursor staffing migration: ${status.reason}`);
  }
  const candidate = structuredClone(record);
  candidate.staffing.current.model = normalizedModel(options.model);
  candidate.staffing.current.effort = null;
  ensureMatchingCreate(candidate, options, task);
  const migratedAt = new Date().toISOString();
  record.staffing.history.push({
    ...record.staffing.current,
    ended_at: migratedAt,
    migration: "cursor-live-catalog-effort-model",
  });
  record.staffing.current = {
    ...record.staffing.current,
    model: normalizedModel(options.model),
    effort: null,
    selected_at: migratedAt,
  };
  return true;
};
const herdrPairIsAbsent = (status) =>
  !status.ok && /(?:no pair session recorded|no session with sid|no session file exists|file does not exist)/u.test(
    status.reason ?? "",
  );
const herdrPairIsStale = (status) =>
  !status.ok && /(?:recorded partner pane .* is gone|recorded partner is no longer|has no live foreground .* process rooted at)/u.test(
    status.reason ?? "",
  );
const pairIsAbsent = (status) =>
  !status.ok && (
    /no (?:active )?pair(?: session)?\b/u.test(status.reason ?? "") ||
    herdrPairIsAbsent(status)
  );
const herdrPairIsRecoverable = (status) =>
  herdrPairIsAbsent(status) || herdrPairIsStale(status);
const recoverHerdrPairEnd = (record, path, status, reason) => {
  if (backendOf(record) !== "herdr" || !herdrPairIsRecoverable(status)) {
    throw new Error(`cannot recover Herdr pair: ${status.reason ?? "unknown state"}`);
  }
  record.transport_recovery ??= [];
  const recovery = {
    action: herdrPairIsAbsent(status) ? "prove-absence" : "stale-end",
    sid: record.pair?.sid ?? null,
    partner_pane: record.pair?.partner_pane ?? null,
    reason,
    observed: status.reason ?? null,
    status: "attempted",
    attempted_at: new Date().toISOString(),
  };
  record.transport_recovery.push(recovery);
  writeRecord(path, record);
  if (herdrPairIsAbsent(status)) {
    recovery.status = "proved-absent";
    recovery.completed_at = new Date().toISOString();
    writeRecord(path, record);
    return { ok: true, status: "absent", recovery };
  }
  try {
    const ended = endPair(record, { stale: true });
    recovery.status = "ended-stale";
    recovery.completed_at = new Date().toISOString();
    writeRecord(path, record);
    return { ...ended, recovery };
  } catch (error) {
    recovery.status = "failed";
    recovery.error = error.message;
    recovery.failed_at = new Date().toISOString();
    writeRecord(path, record);
    throw error;
  }
};
const proveUnitWorktree = (place, record) => {
  const row = worktreeRows(place.root).find((candidate) => candidate.path === record.worktree);
  if (!row) return false;
  if (row.branch !== record.branch) {
    fail(`unit ${record.unit_id} worktree branch differs`, {
      recorded: record.branch,
      observed: row.branch ?? null,
    });
  }
  record.resources.worktree = true;
  record.resources.local_branch = true;
  return true;
};

const create = (options) => {
  const place = repository(options.repo);
  const id = unitId(options.unit);
  const path = recordPath(place, id);
  const required = ["worktree", "branch", "base", "scope", "validation", "merge-policy"];
  for (const key of required) if (!options[key]) fail(`create requires --${key}`, null, 2);
  if (!isAbsolute(options.worktree)) fail("--worktree must be an absolute path", null, 2);
  if (!mergePolicies.has(options["merge-policy"])) fail("--merge-policy must be auto or hold", null, 2);
  if (options["task-file"] && !existsSync(options["task-file"])) {
    fail(`task file does not exist: ${options["task-file"]}`);
  }
  const requestedTask = options["task-file"] ? readFileSync(options["task-file"], "utf8").trim() : null;
  if (options["task-file"] && !requestedTask) fail("task file is empty");

  return withRegistryLock(place, () => {
    mkdirSync(place.units, { recursive: true });
    const resumed = existsSync(path);
    let resumedFrom = null;
    let record;
    if (resumed) {
      record = readRecord(place, id).record;
      const backend = ensureBackendOverride(record, options);
      validateStaffing(options, "create", { allowLegacyCursor: resumed, backend });
      if (backend === "herdr" && callerOptionNames.some((name) => options[name])) {
        const caller = requestedCaller(options, place);
        if (!callerMatches(record.caller, caller)) {
          fail(`unit ${id} cannot resume: Herdr caller identity differs`);
        }
      }
      resumedFrom = record.lifecycle;
      if (!recoverableCreatePhases.has(resumedFrom)) {
        fail(`unit ${id} already exists in non-resumable phase ${resumedFrom}`);
      }
      migrateLegacyCursorCreate(record, options, requestedTask);
      ensureMatchingCreate(record, options, requestedTask);
      record.resources ??= {};
    } else {
      const backend = selectedBackend(options);
      validateStaffing(options, "create", { backend });
      if (!options["task-file"]) fail("a new unit requires --task-file", null, 2);
      if (existsSync(options.worktree)) fail(`worktree path already exists: ${options.worktree}`);
      const duplicate = listRecords(place).find(
        (candidate) => candidate.branch === options.branch || candidate.worktree === options.worktree,
      );
      if (duplicate) fail(`unit ${id} conflicts with recorded unit ${duplicate.unit_id}`);
      const existingRef = branchExists(place.root, options.branch);
      if (existingRef) fail(`branch ${options.branch} already exists at ${existingRef}`);

      record = {
        schema_version: 1,
        unit_id: id,
        repository: place.root,
        common_git_dir: place.commonGitDir,
        worktree: options.worktree,
        branch: options.branch,
        base: options.base,
        lifecycle: "creating",
        backend,
        lead: options.lead,
        caller: backend === "herdr" ? requestedCaller(options, place) : null,
        task: requestedTask,
        task_file: join(place.registry, "tasks", `${id}.md`),
        scope: options.scope,
        validation: options.validation,
        merge_policy: options["merge-policy"],
        setup: options.setup ?? null,
        resources: { task_file: false, worktree: false, local_branch: false, pair: false },
        staffing: {
          current: {
            partner: options.partner,
            model: normalizedModel(options.model),
            effort: options.effort ?? null,
            reason: options.reason,
            selected_at: new Date().toISOString(),
          },
          history: [],
        },
        pair: null,
        cleanup: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }
    const rollback = [];
    let pairInitialized = false;
    writeRecord(path, record);

    try {
      const taskFile = ensureManifestTask(place, record);
      writeRecord(path, record);

      if (!proveUnitWorktree(place, record)) {
        if (existsSync(record.worktree)) {
          throw new Error(`recorded worktree path exists but is not a linked worktree: ${record.worktree}`);
        }
        const existingRef = branchExists(place.root, record.branch);
        if (existingRef) {
          throw new Error(`recorded worktree is missing but branch ${record.branch} exists at ${existingRef}`);
        }
        const hasOrigin = git(place.root, "remote", "get-url", "origin").status === 0;
        if (hasOrigin) {
          gitChecked(place.root, ["fetch", "origin", record.base], "fetch unit base");
        }
        const remoteBase = git(place.root, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${record.base}`).status === 0;
        const startPoint = remoteBase ? `origin/${record.base}` : record.base;
        gitChecked(place.root, ["worktree", "add", "-b", record.branch, record.worktree, startPoint], "create worktree");
        record.worktree = gitChecked(record.worktree, ["rev-parse", "--show-toplevel"], "resolve worktree").stdout.trim();
        record.resources.worktree = true;
        record.resources.local_branch = true;
        record.lifecycle = "setting-up";
        writeRecord(path, record);
      }

      ensurePrBodyExclude(record);
      writeRecord(path, record);

      if (["creating", "setting-up"].includes(record.lifecycle)) {
        record.lifecycle = "setting-up";
        writeRecord(path, record);
        if (record.setup) {
          runChecked(
            "sh",
            ["-c", record.setup],
            { cwd: record.worktree, timeout: longCommandTimeoutMs },
            "unit setup",
          );
        }
        record.lifecycle = "initializing-pair";
        writeRecord(path, record);
      }

      let currentPair = pairStatus(record);
      if (currentPair.ok) {
        if (!resumed || ["creating", "setting-up"].includes(resumedFrom)) {
          throw new Error(`unit ${id} has an unexpected pair in phase ${resumedFrom ?? "creating"}`);
        }
        if (
          resumedFrom === "initializing-pair" &&
          ((currentPair.seq ?? 0) !== 0 || currentPair.in_flight)
        ) {
          throw new Error(`unit ${id} has an unexpected started pair in phase initializing-pair`);
        }
        if (record.pair?.sid) {
          const reconciled = reconcilePairHead(record, currentPair);
          if (reconciled.error) throw new Error(reconciled.error);
          if (reconciled.changed) writeRecord(path, record);
        }
        if (resumedFrom === "starting") {
          if (!record.pair?.sid) throw new Error(`unit ${id} starting record has no pair sid`);
          if (backendOf(record) === "headless" && (currentPair.seq ?? 0) > 1) {
            throw new Error(`unit ${id} pair has unexpected seq ${currentPair.seq} in phase starting`);
          }
        }
      } else {
        if (!pairIsAbsent(currentPair)) {
          throw new Error(`cannot prove pair state while creating unit ${id}: ${currentPair.reason}`);
        }
        if (resumedFrom === "starting") {
          throw new Error(`unit ${id} recorded pair ${record.pair?.sid ?? "without a sid"} is absent in phase starting`);
        }
        currentPair = initializePair(record, path, record.staffing.current);
        pairInitialized = true;
      }
      for (const [field, wanted] of [
        ["partner", record.staffing.current.partner],
        ["role", "executor"],
        ["model", record.staffing.current.model],
        ["effort", record.staffing.current.effort],
      ]) {
        if ((currentPair[field] ?? null) !== wanted) {
          throw new Error(`recorded pair ${field} differs: expected ${wanted ?? "CLI-default"}, observed ${currentPair[field] ?? "CLI-default"}`);
        }
      }
      record.resources.pair = true;
      record.pair = {
        ...record.pair,
        sid: currentPair.sid,
        latest_seq: currentPair.seq ?? 0,
        ...(currentPair.partner_pane ? { partner_pane: currentPair.partner_pane } : {}),
      };
      record.lifecycle = "starting";
      writeRecord(path, record);

      currentPair = pairStatus(record);
      if (!currentPair.ok) throw new Error(`cannot prove initialized pair: ${currentPair.reason}`);
      const reconciled = reconcilePairHead(record, currentPair);
      if (reconciled.error) throw new Error(reconciled.error);
      if (currentPair.in_flight) {
        throw new Error(`unit ${id} task delivery still awaits receipt: ${JSON.stringify(currentPair.in_flight)}`);
      }
      if ((currentPair.seq ?? 0) === 0 || herdrDeliveryNeedsSend(currentPair)) {
        const running = sendPair(record, taskFile);
        journalPairDelivery(record, running);
        writeRecord(path, record);
        if (running.status !== "running") throw new Error(unacknowledgedDeliveryError(running));
      } else {
        if (!herdrDeliveryIsProved(currentPair)) {
          throw new Error(`unit ${id} task delivery is not acknowledged: ${JSON.stringify({
            seq: currentPair.seq ?? null,
            acknowledged_seq: currentPair.acknowledged_seq ?? null,
          })}`);
        }
        record.pair.latest_seq = currentPair.in_flight?.seq ?? currentPair.seq;
        const receipt = currentPair.latest_receipt ?? null;
        if (receipt?.receipt_file) record.pair.latest_receipt_file = receipt.receipt_file;
      }
      record.lifecycle = "working";
      delete record.error;
      writeRecord(path, record);
      return {
        ok: true,
        status: resumed ? "resumed" : "created",
        ...(resumed ? { resumed_from: resumedFrom } : {}),
        unit: describe(place, record),
      };
    } catch (error) {
      if (error instanceof CliExit) throw error;
      if (resumed) {
        record.error = error.message;
        writeRecord(path, record);
        fail(error.message, { recovery_record: path, resumed_from: resumedFrom });
      }
      if (backendOf(record) === "herdr" && record.pair?.partner_pane) {
        record.error = error.message;
        writeRecord(path, record);
        fail(error.message, {
          recovery_record: path,
          partner_pane: record.pair.partner_pane,
          pane_close: "manual",
        });
      }
      record.lifecycle = "create-failed";
      record.error = error.message;
      writeRecord(path, record);
      if (pairInitialized) {
        try {
          endPair(record);
          rollback.push({ resource: "pair", ok: true });
          record.resources.pair = false;
        } catch (pairError) {
          rollback.push({ resource: "pair", ok: false, error: pairError.message });
        }
      }
      if (record.resources.worktree) {
        const removed = git(place.root, "worktree", "remove", "--force", record.worktree);
        rollback.push({ resource: "worktree", ok: removed.status === 0, error: removed.status === 0 ? null : commandError(removed, "remove worktree") });
        if (removed.status === 0) record.resources.worktree = false;
      }
      if (record.resources.local_branch) {
        try {
          removeLocalBranch(place.root, record.branch);
          rollback.push({ resource: "local-branch", ok: true });
          record.resources.local_branch = false;
        } catch (branchError) {
          rollback.push({ resource: "local-branch", ok: false, error: branchError.message });
        }
      }
      if (record.resources.task_file) {
        try {
          trashPath(record.task_file);
          rollback.push({ resource: "task-file", ok: true });
          record.resources.task_file = false;
        } catch (taskError) {
          rollback.push({ resource: "task-file", ok: false, error: taskError.message });
        }
      }
      record.rollback = rollback;
      const complete = rollback.every((step) => step.ok);
      if (complete) {
        try { trashPath(path); } catch {}
      } else {
        writeRecord(path, record);
      }
      fail(error.message, { rollback, recovery_record: complete ? null : path });
    }
  });
};

const list = (options) => {
  const place = repository(options.repo);
  return {
    ok: true,
    repository: place.root,
    units: listRecords(place).map((record) => {
      normalizeBackend(record);
      return describe(place, record);
    }),
  };
};

const status = (options) => {
  const place = repository(options.repo);
  const id = unitId(options.unit);
  return withRegistryLock(place, () => {
    const { path, record } = readRecord(place, id);
    const hadBackend = Boolean(record.backend);
    ensureBackendOverride(record, options);
    if (!hadBackend) writeRecord(path, record);
    const observedPair = pairStatus(record);
    if (observedPair.ok && record.pair?.sid) {
      if (pairMatchesStaffing(observedPair, record.staffing.current)) {
        const reconciled = reconcilePairHead(record, observedPair);
        if (reconciled.error) fail(reconciled.error, { recorded: record.pair.sid, observed: observedPair.sid });
        if (reconciled.changed) writeRecord(path, record);
      } else if (!(
        recoverableRestaffPhases.has(record.lifecycle)
        && record.pending_staffing
        && pairMatchesStaffing(observedPair, record.pending_staffing)
      )) {
        fail(`unit ${id} observed pair staffing differs from its recorded pair`);
      }
    }
    return { ok: true, unit: describe(place, record, observedPair) };
  });
};

const repin = (options) => {
  const place = repository(options.repo);
  const id = unitId(options.unit);
  return withRegistryLock(place, () => {
    const { path, record } = readRecord(place, id);
    if (ensureBackendOverride(record, options) !== "herdr") {
      fail(`unit ${id} caller re-pin requires the Herdr backend`);
    }
    const replacement = requestedCaller({ ...options, lead: record.lead }, place);
    const previous = record.caller;
    if (!previous) fail(`unit ${id} has no recorded Herdr caller identity`);
    if (callerMatches(previous, replacement)) {
      return { ok: true, status: "unchanged", unit: describe(place, record) };
    }
    record.caller_history ??= [];
    const journal = {
      from: previous,
      to: replacement,
      status: "attempted",
      attempted_at: new Date().toISOString(),
    };
    record.caller_history.push(journal);
    writeRecord(path, record);
    try {
      let transport = { ok: true, changed: false, session: "not-initialized" };
      if (record.pair?.sid) {
        transport = herdrPair(
          "repin",
          { ...record, caller: replacement },
          [
            "--sid", record.pair.sid,
            "--previous-pane", previous.pane,
            "--previous-terminal-id", previous.terminal_id,
          ],
        );
      }
      record.caller = replacement;
      journal.status = "repinned";
      journal.completed_at = new Date().toISOString();
      journal.transport = transport;
      delete record.error;
      writeRecord(path, record);
      return { ok: true, status: "repinned", transport, unit: describe(place, record) };
    } catch (error) {
      journal.status = "failed";
      journal.error = error.message;
      journal.failed_at = new Date().toISOString();
      record.error = error.message;
      writeRecord(path, record);
      fail(`unit ${id} caller re-pin failed: ${error.message}`, { recovery_record: path });
    }
  });
};

const recoverableRestaffPhases = new Set(["restaffing", "restaff-failed"]);
const ensureMatchingRestaff = (record, requested) => {
  for (const field of ["lead", "partner", "model", "effort", "reason"]) {
    const recorded = record.pending_staffing?.[field] ?? null;
    const wanted = requested[field] ?? null;
    if (recorded !== wanted) {
      fail(`unit ${record.unit_id} cannot resume restaff: ${field} differs`, {
        recorded,
        requested: wanted,
      });
    }
  }
};
const pairMatchesStaffing = (status, staffing) => [
  ["partner", staffing.partner],
  ["role", "executor"],
  ["model", staffing.model],
  ["effort", staffing.effort],
].every(([field, wanted]) => (status[field] ?? null) === (wanted ?? null));
const restaffCheckpoint = (record) => record.staffing.history.at(-1)?.checkpoint ?? null;

const restaff = (options) => {
  const place = repository(options.repo);
  const id = unitId(options.unit);
  return withRegistryLock(place, () => {
    const { path, record } = readRecord(place, id);
    const backend = ensureBackendOverride(record, options);
    validateStaffing(options, "restaff", { backend });
    if (options.lead !== record.lead) {
      fail(`unit ${id} lead differs`, { recorded: record.lead, requested: options.lead });
    }
    const requested = requestedStaffing(options);
    if (!existsSync(record.worktree)) fail(`unit ${id} worktree is missing`);
    const resumed = recoverableRestaffPhases.has(record.lifecycle);
    const resumedFrom = resumed ? record.lifecycle : null;
    let checkpoint;
    if (resumed) {
      if (record.pending_staffing) {
        ensureMatchingRestaff(record, requested);
      } else {
        // Records written before resumable restaffing did not preserve the
        // requested target. The first retry claims it; later retries are strict.
        record.pending_staffing = { ...requested, requested_at: new Date().toISOString() };
        const legacyCheckpoint = restaffCheckpoint(record);
        if (legacyCheckpoint && legacyCheckpoint.worktree_status === undefined) {
          legacyCheckpoint.worktree_status = gitChecked(
            record.worktree,
            ["status", "--short"],
            "read unit worktree status",
          ).stdout.trim();
        }
        writeRecord(path, record);
      }
      checkpoint = restaffCheckpoint(record);
      if (!checkpoint) fail(`unit ${id} restaff recovery has no checkpoint`);
    } else {
      if (record.lifecycle !== "working") {
        fail(`unit ${id} cannot restaff from phase ${record.lifecycle}`);
      }
      let currentStatus = pairStatus(record);
      let recoveredOldPair = null;
      if (!currentStatus.ok) {
        if (backend === "herdr" && herdrPairIsRecoverable(currentStatus)) {
          recoveredOldPair = recoverHerdrPairEnd(
            record,
            path,
            currentStatus,
            "restaff old pair before checkpoint",
          );
        } else {
          fail(`cannot prove pair state for unit ${id}`, currentStatus);
        }
      } else {
        if (currentStatus.in_flight) fail(`unit ${id} has an in-flight turn`, currentStatus.in_flight);
        if (!pairMatchesStaffing(currentStatus, record.staffing.current)) {
          fail(`unit ${id} pair staffing differs before restaff`);
        }
        const reconciled = reconcilePairHead(record, currentStatus);
        if (reconciled.error) {
          fail(reconciled.error, { recorded: record.pair?.sid, observed: currentStatus.sid });
        }
      }
      checkpoint = {
        pair_sid: currentStatus.sid ?? record.pair?.sid ?? null,
        head: gitChecked(record.worktree, ["rev-parse", "HEAD"], "read unit HEAD").stdout.trim(),
        diff_stat: gitChecked(record.worktree, ["diff", "--stat"], "read unit diff").stdout.trim(),
        worktree_status: gitChecked(record.worktree, ["status", "--short"], "read unit worktree status").stdout.trim(),
        receipt: currentStatus.ok
          ? transportCheckpoint(currentStatus)
          : { backend: "herdr", recovery: recoveredOldPair?.recovery ?? null },
        at: new Date().toISOString(),
      };
      const previous = { ...record.staffing.current, ended_at: checkpoint.at, checkpoint };
      record.pending_staffing = { ...requested, requested_at: checkpoint.at };
      record.restaff_phase = recoveredOldPair ? "initializing-target" : "ending-old";
      if (recoveredOldPair) {
        record.resources.pair = false;
        record.pair = null;
      }
      record.lifecycle = "restaffing";
      record.staffing.history.push(previous);
      writeRecord(path, record);
    }

    try {
      let currentStatus = pairStatus(record);
      if (!record.restaff_phase) {
        if (!currentStatus.ok) {
          if (backend === "herdr" && herdrPairIsRecoverable(currentStatus)) {
            recoverHerdrPairEnd(record, path, currentStatus, "restaff recovery without phase");
            record.resources.pair = false;
            record.pair = null;
          } else if (!pairIsAbsent(currentStatus)) {
            throw new Error(`cannot prove pair state while restaffing unit ${id}: ${currentStatus.reason}`);
          }
          record.restaff_phase = "initializing-target";
        } else if (
          record.resources.pair &&
          pairMatchesStaffing(currentStatus, record.staffing.current)
        ) {
          const reconciled = reconcilePairHead(record, currentStatus);
          if (reconciled.error) throw new Error(reconciled.error);
          record.restaff_phase = "ending-old";
        } else if (pairMatchesStaffing(currentStatus, record.pending_staffing)) {
          record.restaff_phase = "starting-target";
          record.resources.pair = true;
          record.pair = {
            ...record.pair,
            sid: currentStatus.sid,
            latest_seq: currentStatus.seq ?? 0,
            ...(currentStatus.partner_pane ? { partner_pane: currentStatus.partner_pane } : {}),
          };
        } else {
          throw new Error(`unit ${id} has an unexpected live pair during restaff recovery`);
        }
        writeRecord(path, record);
      }

      if (record.restaff_phase === "ending-old") {
        if (currentStatus.ok) {
          if (!pairMatchesStaffing(currentStatus, record.staffing.current)) {
            throw new Error(`unit ${id} old pair staffing differs during restaff recovery`);
          }
          if (currentStatus.in_flight) throw new Error(`unit ${id} has an in-flight old pair turn`);
          const reconciled = reconcilePairHead(record, currentStatus);
          if (reconciled.error) throw new Error(reconciled.error);
          endPair(record);
        } else if (backend === "herdr" && herdrPairIsRecoverable(currentStatus)) {
          recoverHerdrPairEnd(record, path, currentStatus, "restaff ending old pair");
        } else if (!pairIsAbsent(currentStatus)) {
          throw new Error(`cannot prove old pair state while restaffing unit ${id}: ${currentStatus.reason}`);
        }
        record.resources.pair = false;
        record.pair = null;
        record.restaff_phase = "initializing-target";
        writeRecord(path, record);
        currentStatus = pairStatus(record);
      }

      let initialized;
      if (record.restaff_phase === "initializing-target") {
        currentStatus = pairStatus(record);
        if (currentStatus.ok) {
          if (!pairMatchesStaffing(currentStatus, record.pending_staffing)) {
            throw new Error(`unit ${id} has an unexpected live pair during target initialization`);
          }
          if ((currentStatus.seq ?? 0) !== 0 || currentStatus.in_flight) {
            throw new Error(`unit ${id} target pair started before its restaff journal`);
          }
          initialized = currentStatus;
        } else {
          if (!pairIsAbsent(currentStatus)) {
            throw new Error(`cannot prove target pair state while restaffing unit ${id}: ${currentStatus.reason}`);
          }
          initialized = initializePair(record, path, record.pending_staffing);
        }
        if (!pairMatchesStaffing(initialized, record.pending_staffing)) {
          throw new Error(`initialized pair does not match pending staffing for unit ${id}`);
        }
        record.resources.pair = true;
        record.pair = {
          ...record.pair,
          sid: initialized.sid,
          latest_seq: initialized.seq ?? 0,
          ...(initialized.partner_pane ? { partner_pane: initialized.partner_pane } : {}),
        };
        record.restaff_phase = "starting-target";
        writeRecord(path, record);
      }

      if (record.restaff_phase !== "starting-target") {
        throw new Error(`unit ${id} has unknown restaff phase ${record.restaff_phase}`);
      }
      currentStatus = pairStatus(record);
      if (!currentStatus.ok || !pairMatchesStaffing(currentStatus, record.pending_staffing)) {
        throw new Error(`cannot prove pending target pair for unit ${id}`);
      }
      if (!record.pair?.sid) {
        record.pair = {
          ...record.pair,
          sid: currentStatus.sid,
          latest_seq: currentStatus.seq ?? 0,
          ...(currentStatus.partner_pane ? { partner_pane: currentStatus.partner_pane } : {}),
        };
      }
      const reconciledTarget = reconcilePairHead(record, currentStatus);
      if (reconciledTarget.error) throw new Error(reconciledTarget.error);
      if (backend === "headless" && (currentStatus.seq ?? 0) > 1) {
        throw new Error(`unit ${id} pending pair has unexpected seq ${currentStatus.seq}`);
      }

      const checkpointPath = join(place.registry, `restaff-${id}-${process.pid}.md`);
      writeFileSync(checkpointPath, [
        record.task,
        "",
        `Before you work, reread the complete manifest task file at ${record.task_file}.`,
        "",
        "Restaff checkpoint:",
        `- Previous HEAD: ${checkpoint.head}`,
        `- Working diff: ${checkpoint.diff_stat || "clean"}`,
        `- Working status: ${checkpoint.worktree_status || "clean"}`,
        `- Previous receipt: ${JSON.stringify(checkpoint.receipt)}`,
        "Continue the same unit from this worktree. Preserve valid existing work and return a protocol status.",
        "",
      ].join("\n"), { flag: "wx" });
      let running = initialized;
      let sendError = null;
      try {
        currentStatus = pairStatus(record);
        if (!currentStatus.ok || !pairMatchesStaffing(currentStatus, record.pending_staffing)) {
          throw new Error(`cannot prove pending pair before restaff send for unit ${id}`);
        }
        const reconciledTarget = reconcilePairHead(record, currentStatus);
        if (reconciledTarget.error) throw new Error(reconciledTarget.error);
        if (currentStatus.in_flight) {
          throw new Error(`unit ${id} target delivery still awaits receipt: ${JSON.stringify(currentStatus.in_flight)}`);
        }
        if ((currentStatus.seq ?? 0) === 0 || herdrDeliveryNeedsSend(currentStatus)) {
          running = sendPair(record, checkpointPath);
          journalPairDelivery(record, running);
          writeRecord(path, record);
          if (running.status !== "running") {
            throw new Error(unacknowledgedDeliveryError(running));
          }
        } else if (backend === "headless" && (currentStatus.seq ?? 0) > 1) {
          throw new Error(`unit ${id} pending pair has unexpected seq ${currentStatus.seq}`);
        } else {
          if (!herdrDeliveryIsProved(currentStatus)) {
            throw new Error(`unit ${id} target delivery is not acknowledged: ${JSON.stringify({
              seq: currentStatus.seq ?? null,
              acknowledged_seq: currentStatus.acknowledged_seq ?? null,
            })}`);
          }
          running = currentStatus;
        }
      } catch (error) {
        sendError = error;
        throw error;
      } finally {
        try {
          trashPath(checkpointPath);
        } catch (cleanupError) {
          if (!sendError) throw cleanupError;
        }
      }
      record.staffing.current = {
        partner: record.pending_staffing.partner,
        model: record.pending_staffing.model,
        effort: record.pending_staffing.effort,
        reason: record.pending_staffing.reason,
        selected_at: new Date().toISOString(),
      };
      record.pair.latest_seq = running.in_flight?.seq ?? running.seq ?? record.pair.latest_seq;
      if (running.delivery_receipt) record.pair.delivery_receipt = running.delivery_receipt;
      const receipt = currentStatus.latest_receipt ?? null;
      const receiptFile = running.receipt_file ?? receipt?.receipt_file;
      if (receiptFile) record.pair.latest_receipt_file = receiptFile;
      record.lifecycle = "working";
      delete record.pending_staffing;
      delete record.restaff_phase;
      delete record.error;
      writeRecord(path, record);
      return {
        ok: true,
        status: "restaffed",
        ...(resumed ? { resumed_from: resumedFrom } : {}),
        unit: describe(place, record),
      };
    } catch (error) {
      record.lifecycle = "restaff-failed";
      record.error = error.message;
      writeRecord(path, record);
      fail(error.message, { recovery_record: path, checkpoint, ...(resumed ? { resumed_from: resumedFrom } : {}) });
    }
  });
};

const dismantle = (options) => {
  const place = repository(options.repo);
  const id = unitId(options.unit);
  return withRegistryLock(place, () => {
    const { path, record } = readRecord(place, id);
    ensureBackendOverride(record, options);
    record.resources ??= {};
    record.cleanup ??= [];
    const forced = options.force === id;
    if (options.force && !forced) fail(`--force must equal the exact unit id ${id}`, null, 2);
    const currentStatus = pairStatus(record);
    const pairCleanupDone = record.cleanup.some((entry) => entry.step === "pair" && entry.ok);
    const recordedPaneOutstanding =
      backendOf(record) === "herdr" && Boolean(record.pair?.partner_pane) && !pairCleanupDone;
    const pairAlreadyEnded = pairCleanupDone ||
      (!recordedPaneOutstanding && record.resources.pair === false) ||
      (record.lifecycle === "dismantling" && pairIsAbsent(currentStatus));
    if (existsSync(record.worktree) && !currentStatus.ok && !pairAlreadyEnded) {
      if (!(forced && backendOf(record) === "herdr" && herdrPairIsRecoverable(currentStatus))) {
        fail(`cannot prove pair state for unit ${id}`, currentStatus);
      }
    }
    if (!pairAlreadyEnded && currentStatus.in_flight) {
      fail(`unit ${id} has an in-flight turn`, currentStatus.in_flight);
    }
    const prs = pullRequests(existsSync(record.worktree) ? record.worktree : place.root, record.branch);
    const branchHead = git(place.root, "rev-parse", `refs/heads/${record.branch}`);
    const expectedHead = branchHead.status === 0 ? branchHead.stdout.trim() : null;
    const merged = prs.ok ? prs.prs.find(
      (pr) =>
        (pr.mergedAt || pr.state === "MERGED") &&
        pr.baseRefName === record.base &&
        (!expectedHead || pr.headRefOid === expectedHead),
    ) : null;
    if (!forced && (!prs.ok || !merged)) {
      fail(`unit ${id} has no proved merged PR; abandoned cleanup requires --force ${id}`, prs);
    }
    record.lifecycle = "dismantling";
    if (pairAlreadyEnded) record.resources.pair = false;
    record.pr = merged ?? record.pr ?? null;
    writeRecord(path, record);

    const step = (name, operation) => {
      try {
        const detail = operation();
        record.cleanup.push({ step: name, ok: true, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
        writeRecord(path, record);
      } catch (error) {
        record.cleanup.push({ step: name, ok: false, error: error.message, at: new Date().toISOString() });
        record.lifecycle = "dismantle-failed";
        record.error = error.message;
        writeRecord(path, record);
        fail(`dismantle failed at ${name}: ${error.message}`, { done: record.cleanup, recovery_record: path });
      }
    };

    if (!pairAlreadyEnded && (backendOf(record) === "herdr" || existsSync(record.worktree))) {
      step("pair", () => {
        let ended = null;
        if (backendOf(record) === "herdr" && !record.pair?.sid) {
          ended = { status: "not-initialized" };
        } else if (currentStatus.ok) {
          ended = endPair(record);
        } else if (forced && backendOf(record) === "herdr" && herdrPairIsRecoverable(currentStatus)) {
          ended = recoverHerdrPairEnd(record, path, currentStatus, "forced dismantle");
        } else {
          throw new Error(`cannot prove pair state for unit ${id}: ${currentStatus.reason ?? "unknown state"}`);
        }
        record.resources.pair = false;
        if (backendOf(record) === "herdr") {
          return {
            backend: "herdr",
            session: ended?.status ?? null,
            partner_pane: record.pair?.partner_pane ?? null,
            pane_close: "manual",
            ...(ended?.recovery ? { recovery: ended.recovery } : {}),
          };
        }
      });
    }
    if (existsSync(record.worktree)) {
      step("worktree", () => {
        const args = ["worktree", "remove", ...(forced ? ["--force"] : []), record.worktree];
        const removed = git(place.root, ...args);
        if (removed.status === 0) {
          record.resources.worktree = false;
          return { via: "git worktree remove" };
        }
        if (!forced) throw new Error(commandError(removed, "remove worktree"));
        trashPath(record.worktree);
        gitChecked(place.root, ["worktree", "prune"], "prune worktrees");
        record.resources.worktree = false;
        return { via: "trash + prune" };
      });
    }
    step("local-branch", () => {
      removeLocalBranch(place.root, record.branch);
      record.resources.local_branch = false;
    });
    step("remote-branch", () => removeRemoteBranch(place.root, record.branch));
    if (record.task_file && existsSync(record.task_file)) {
      step("task-file", () => {
        trashPath(record.task_file);
        record.resources.task_file = false;
      });
    }
    const result = { ok: true, status: "dismantled", unit_id: id, merged_pr: merged, forced, done: record.cleanup };
    trashPath(path);
    return result;
  });
};

try {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseOptions(arguments_);
  if (command === "create") emit(create(options));
  else if (command === "list") emit(list(options));
  else if (command === "status") emit(status(options));
  else if (command === "repin") emit(repin(options));
  else if (command === "restaff") emit(restaff(options));
  else if (command === "dismantle") emit(dismantle(options));
  else fail("usage: unit.mjs <create|list|status|repin|restaff|dismantle> --repo <path> ...", null, 2);
} catch (error) {
  if (error instanceof CliExit) {
    process.exitCode = error.code;
  } else {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: error.stack ?? error.message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
