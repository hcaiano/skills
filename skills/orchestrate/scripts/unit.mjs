#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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
const pairScript = process.env.ORCHESTRATE_PAIR_SCRIPT ??
  join(scriptDir, "../../pair/scripts/pair-headless.mjs");
const partnerKinds = new Set(["claude", "codex", "cursor", "grok"]);
const mergePolicies = new Set(["auto", "hold"]);

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

const run = (command, args, options = {}) =>
  spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
const commandError = (result, label) =>
  `${label}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`;
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
const recordPath = (place, id) => join(place.units, `${id}.json`);
const atomicWrite = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
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
  try {
    mkdirSync(place.lock);
  } catch (error) {
    if (error?.code !== "EEXIST") fail(`cannot create orchestrate registry lock: ${error.message}`);
    let ownerRecord = null;
    try { ownerRecord = JSON.parse(readFileSync(join(place.lock, "owner.json"), "utf8")); } catch {}
    if (!Number.isInteger(ownerRecord?.pid) || ownerRecord.pid <= 0) {
      fail(`orchestrate registry is busy at ${place.lock}; its owner is not yet readable`);
    }
    let alive = true;
    try { process.kill(ownerRecord.pid, 0); } catch (killError) { alive = killError?.code === "EPERM"; }
    if (alive) fail(`orchestrate registry is busy at ${place.lock} (pid ${ownerRecord.pid})`);
    trashPath(place.lock);
    try {
      mkdirSync(place.lock);
    } catch (retryError) {
      fail(`cannot recover stale orchestrate registry lock: ${retryError.message}`);
    }
  }
  const ownerPath = join(place.lock, "owner.json");
  try {
    writeFileSync(ownerPath, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { flag: "wx" });
  } catch (error) {
    try { rmdirSync(place.lock); } catch {}
    fail(`cannot publish orchestrate registry lock owner: ${error.message}`);
  }
  try {
    return operation();
  } finally {
    try { unlinkSync(ownerPath); } catch {}
    try { rmdirSync(place.lock); } catch {}
  }
};

const pair = (command, repo, extra = []) => {
  const result = run(process.execPath, [pairScript, command, "--repo", repo, ...extra]);
  if (result.status !== 0) {
    let detail = (result.stderr || result.stdout || "").trim();
    try { detail = JSON.parse(result.stdout).reason ?? detail; } catch {}
    throw new Error(`pair ${command} failed: ${detail || `exit ${result.status}`}`);
  }
  return parseJson(result.stdout, `pair ${command}`);
};

const pairStatus = (worktree) => {
  if (!worktree || !existsSync(worktree)) return { ok: false, reason: "worktree-missing" };
  try {
    return pair("status", worktree);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
};

const latestReceipt = (worktree) => {
  if (!worktree || !existsSync(worktree)) return null;
  const gitDir = git(worktree, "rev-parse", "--absolute-git-dir");
  if (gitDir.status !== 0) return null;
  const transcripts = join(gitDir.stdout.trim(), "pair", "transcripts");
  if (!existsSync(transcripts)) return null;
  const receipts = readdirSync(transcripts)
    .filter((name) => /^\d{4}-.+-receipt\.json$/u.test(name))
    .sort();
  if (receipts.length === 0) return null;
  try {
    return JSON.parse(readFileSync(join(transcripts, receipts.at(-1)), "utf8"));
  } catch {
    return { unreadable: join(transcripts, receipts.at(-1)) };
  }
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

const describe = (place, record) => {
  const worktree = worktreeRows(place.root).find((row) => row.path === record.worktree) ?? null;
  return {
    ...record,
    observed: {
      worktree,
      pair: pairStatus(record.worktree),
      latest_receipt: latestReceipt(record.worktree),
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

const create = (options) => {
  const place = repository(options.repo);
  const id = unitId(options.unit);
  const path = recordPath(place, id);
  const required = ["worktree", "branch", "base", "lead", "partner", "effort", "reason", "task-file", "scope", "validation", "merge-policy"];
  for (const key of required) if (!options[key]) fail(`create requires --${key}`, null, 2);
  if (!isAbsolute(options.worktree)) fail("--worktree must be an absolute path", null, 2);
  if (!partnerKinds.has(options.lead) || !partnerKinds.has(options.partner)) {
    fail("--lead and --partner must be claude, codex, cursor, or grok", null, 2);
  }
  if (options.lead === options.partner) fail("the partner arena must differ from the orchestrator harness");
  if (!mergePolicies.has(options["merge-policy"])) fail("--merge-policy must be auto or hold", null, 2);
  if (!existsSync(options["task-file"])) fail(`task file does not exist: ${options["task-file"]}`);
  const task = readFileSync(options["task-file"], "utf8").trim();
  if (!task) fail("task file is empty");
  if (existsSync(options.worktree)) fail(`worktree path already exists: ${options.worktree}`);

  return withRegistryLock(place, () => {
    mkdirSync(place.units, { recursive: true });
    if (existsSync(path)) fail(`unit ${id} already exists`);
    const duplicate = listRecords(place).find(
      (record) => record.branch === options.branch || record.worktree === options.worktree,
    );
    if (duplicate) fail(`unit ${id} conflicts with recorded unit ${duplicate.unit_id}`);
    const existingRef = branchExists(place.root, options.branch);
    if (existingRef) fail(`branch ${options.branch} already exists at ${existingRef}`);

    const record = {
      schema_version: 1,
      unit_id: id,
      repository: place.root,
      common_git_dir: place.commonGitDir,
      worktree: options.worktree,
      branch: options.branch,
      base: options.base,
      lifecycle: "creating",
      lead: options.lead,
      task,
      scope: options.scope,
      validation: options.validation,
      merge_policy: options["merge-policy"],
      setup: options.setup ?? null,
      resources: { worktree: false, local_branch: false, pair: false },
      staffing: {
        current: {
          partner: options.partner,
          model: options.model === "CLI-default" || !options.model ? null : options.model,
          effort: options.effort,
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
    const rollback = [];
    let pairInitialized = false;
    writeRecord(path, record);

    try {
      const hasOrigin = git(place.root, "remote", "get-url", "origin").status === 0;
      if (hasOrigin) {
        gitChecked(place.root, ["fetch", "origin", options.base], "fetch unit base");
      }
      const remoteBase = git(place.root, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${options.base}`).status === 0;
      const startPoint = remoteBase ? `origin/${options.base}` : options.base;
      gitChecked(place.root, ["worktree", "add", "-b", options.branch, options.worktree, startPoint], "create worktree");
      record.worktree = gitChecked(options.worktree, ["rev-parse", "--show-toplevel"], "resolve worktree").stdout.trim();
      record.resources.worktree = true;
      record.resources.local_branch = true;
      record.lifecycle = "setting-up";
      writeRecord(path, record);

      if (options.setup) {
        runChecked("sh", ["-c", options.setup], { cwd: options.worktree }, "unit setup");
      }
      record.lifecycle = "initializing-pair";
      writeRecord(path, record);

      const initArgs = ["--partner", options.partner, "--effort", options.effort, "--role", "executor"];
      if (record.staffing.current.model) initArgs.push("--model", record.staffing.current.model);
      const initialized = pair("init", options.worktree, initArgs);
      pairInitialized = true;
      record.resources.pair = true;
      record.pair = { sid: initialized.sid, latest_seq: 0 };
      record.lifecycle = "starting";
      writeRecord(path, record);

      const running = pair("send", options.worktree, [
        "--kind", "task", "--body-file", options["task-file"], "--background",
      ]);
      if (running.status !== "running") throw new Error(`pair send did not start: ${JSON.stringify(running)}`);
      record.pair.latest_seq = running.seq;
      record.pair.latest_receipt_file = running.receipt_file;
      record.lifecycle = "working";
      writeRecord(path, record);
      return { ok: true, status: "created", unit: describe(place, record) };
    } catch (error) {
      record.lifecycle = "create-failed";
      record.error = error.message;
      writeRecord(path, record);
      if (pairInitialized) {
        try {
          pair("end", options.worktree);
          rollback.push({ resource: "pair", ok: true });
          record.resources.pair = false;
        } catch (pairError) {
          rollback.push({ resource: "pair", ok: false, error: pairError.message });
        }
      }
      if (record.resources.worktree) {
        const removed = git(place.root, "worktree", "remove", "--force", options.worktree);
        rollback.push({ resource: "worktree", ok: removed.status === 0, error: removed.status === 0 ? null : commandError(removed, "remove worktree") });
        if (removed.status === 0) record.resources.worktree = false;
      }
      if (record.resources.local_branch) {
        try {
          removeLocalBranch(place.root, options.branch);
          rollback.push({ resource: "local-branch", ok: true });
          record.resources.local_branch = false;
        } catch (branchError) {
          rollback.push({ resource: "local-branch", ok: false, error: branchError.message });
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
  return { ok: true, repository: place.root, units: listRecords(place).map((record) => describe(place, record)) };
};

const status = (options) => {
  const place = repository(options.repo);
  const { record } = readRecord(place, unitId(options.unit));
  return { ok: true, unit: describe(place, record) };
};

const restaff = (options) => {
  const place = repository(options.repo);
  const id = unitId(options.unit);
  for (const key of ["lead", "partner", "effort", "reason"]) {
    if (!options[key]) fail(`restaff requires --${key}`, null, 2);
  }
  if (!partnerKinds.has(options.lead) || !partnerKinds.has(options.partner)) {
    fail("--lead and --partner must be claude, codex, cursor, or grok", null, 2);
  }
  if (options.lead === options.partner) fail("the partner arena must differ from the orchestrator harness");
  return withRegistryLock(place, () => {
    const { path, record } = readRecord(place, id);
    if (!existsSync(record.worktree)) fail(`unit ${id} worktree is missing`);
    const currentStatus = pairStatus(record.worktree);
    if (!currentStatus.ok) fail(`cannot prove pair state for unit ${id}`, currentStatus);
    if (currentStatus.in_flight) fail(`unit ${id} has an in-flight turn`, currentStatus.in_flight);
    const checkpoint = {
      head: gitChecked(record.worktree, ["rev-parse", "HEAD"], "read unit HEAD").stdout.trim(),
      diff_stat: gitChecked(record.worktree, ["diff", "--stat"], "read unit diff").stdout.trim(),
      receipt: latestReceipt(record.worktree),
      at: new Date().toISOString(),
    };
    const previous = { ...record.staffing.current, ended_at: checkpoint.at, checkpoint };
    record.lifecycle = "restaffing";
    record.staffing.history.push(previous);
    writeRecord(path, record);

    try {
      pair("end", record.worktree);
      const model = options.model === "CLI-default" || !options.model ? null : options.model;
      const initArgs = ["--partner", options.partner, "--effort", options.effort, "--role", "executor"];
      if (model) initArgs.push("--model", model);
      const initialized = pair("init", record.worktree, initArgs);
      const checkpointPath = join(place.registry, `restaff-${id}-${process.pid}.md`);
      writeFileSync(checkpointPath, [
        record.task,
        "",
        "Restaff checkpoint:",
        `- Previous HEAD: ${checkpoint.head}`,
        `- Working diff: ${checkpoint.diff_stat || "clean"}`,
        `- Previous receipt: ${JSON.stringify(checkpoint.receipt)}`,
        "Continue the same unit from this worktree. Preserve valid existing work and return a protocol status.",
        "",
      ].join("\n"), { flag: "wx" });
      let running;
      try {
        running = pair("send", record.worktree, ["--kind", "task", "--body-file", checkpointPath, "--background"]);
      } finally {
        trashPath(checkpointPath);
      }
      record.staffing.current = {
        partner: options.partner,
        model,
        effort: options.effort,
        reason: options.reason,
        selected_at: new Date().toISOString(),
      };
      record.pair = { sid: initialized.sid, latest_seq: running.seq, latest_receipt_file: running.receipt_file };
      record.lifecycle = "working";
      delete record.error;
      writeRecord(path, record);
      return { ok: true, status: "restaffed", unit: describe(place, record) };
    } catch (error) {
      record.lifecycle = "restaff-failed";
      record.error = error.message;
      writeRecord(path, record);
      fail(error.message, { recovery_record: path, checkpoint });
    }
  });
};

const dismantle = (options) => {
  const place = repository(options.repo);
  const id = unitId(options.unit);
  return withRegistryLock(place, () => {
    const { path, record } = readRecord(place, id);
    const forced = options.force === id;
    if (options.force && !forced) fail(`--force must equal the exact unit id ${id}`, null, 2);
    const currentStatus = pairStatus(record.worktree);
    const pairAlreadyEnded = record.resources?.pair === false || (
      record.lifecycle === "dismantling" &&
      !currentStatus.ok &&
      /no (?:active )?pair(?: session)?\b/u.test(currentStatus.reason ?? "")
    );
    if (existsSync(record.worktree) && !currentStatus.ok && !pairAlreadyEnded) {
      fail(`cannot prove pair state for unit ${id}`, currentStatus);
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

    if (existsSync(record.worktree) && !pairAlreadyEnded) {
      step("pair", () => {
        pair("end", record.worktree);
        record.resources.pair = false;
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
  else if (command === "restaff") emit(restaff(options));
  else if (command === "dismantle") emit(dismantle(options));
  else fail("usage: unit.mjs <create|list|status|restaff|dismantle> --repo <path> ...", null, 2);
} catch (error) {
  if (error instanceof CliExit) {
    process.exitCode = error.code;
  } else {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: error.stack ?? error.message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
