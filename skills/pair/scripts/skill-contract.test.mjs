import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const read = (path) => readFileSync(join(here, path), "utf8");
const skill = read("../SKILL.md");
const herdrBackend = read("../references/herdr.md");
const headlessBackend = read("../references/headless.md");
const models = read("../references/models.md");
const helper = read("herdr-pair.mjs");
const headlessHelper = read("pair-headless.mjs");

const receiptTokens = (text) =>
  [...new Set([...text.matchAll(/receipt=([a-z][a-z-]+)/gu)].map((match) => match[1]))].sort();

test("the skill routes to exactly one backend", () => {
  assert.match(skill, /^name: pair$/mu);
  assert.match(skill, /`HERDR_ENV=1` → \[Herdr backend\]\(references\/herdr\.md\)/u);
  // A Herdr environment missing the CLI must stop in herdr.md's preconditions,
  // never fall through to a hidden headless session.
  assert.match(skill, /stops there\s+instead of falling through to a hidden headless session/u);
  assert.match(skill, /Otherwise → \[Headless backend\]\(references\/headless\.md\)/u);
  assert.match(
    skill,
    /An inbound `\[agent \.\.\.\]` or `\[herdr-pair control \.\.\.\]` line always means the\s+Herdr backend/u,
  );
});

test("the description carries every trigger", () => {
  const description = skill.match(/^description: "(.+)"$/mu)[1];
  for (const trigger of [
    /live peer work/u,
    /workflows requesting a pair/u,
    /`\[agent \.\.\.\]` \/ `\[herdr-pair control \.\.\.\]` line/u,
    /after context compaction/u,
    /when Herdr is absent/u,
  ]) {
    assert.match(description, trigger);
  }
  // The pair is no longer two fixed CLIs, and the description is where each
  // supported harness finds that out.
  for (const kind of ["claude", "codex", "cursor", "grok", "opencode"]) {
    assert.match(description, new RegExp(`\\b${kind}\\b`, "u"));
  }
  assert.doesNotMatch(description, /Claude-Codex/u);
});

test("the five kinds, the partner rule, and the roles are the same everywhere", () => {
  const kinds = ["claude", "codex", "cursor", "grok", "opencode"];
  for (const kind of kinds) {
    assert.match(skill, new RegExp(`\`${kind}\``, "u"), `SKILL.md must name ${kind}`);
  }
  // Same CLI on both sides is the one combination that is refused, in prose
  // and in both helpers.
  assert.match(skill, /except the CLI you are\s+already running/u);
  assert.match(skill, /refusal is based only on the CLI kind/u);
  assert.match(skill, /same underlying model or provider/u);
  assert.match(helper, /refusing to pair \$\{self\.agent\} with itself/u);
  assert.match(headlessHelper, /refusing to pair \$\{self\} with itself/u);
  assert.deepEqual(
    JSON.parse(helper.match(/^const agentKinds = (\[[^\]]+\]);$/mu)[1].replaceAll(/(\w+)/gu, '"$1"').replaceAll('""', '"')),
    kinds,
  );

  // The role decides the default lease distribution and nothing else.
  for (const role of ["peer", "executor"]) {
    assert.match(skill, new RegExp(`\`${role}\``, "u"));
    assert.match(headlessBackend, new RegExp(`\`${role}\``, "u"));
  }
  assert.match(skill, /Any individual `task` still redistributes leases/u);
  assert.match(headlessBackend, /under `executor` it is writable unless you pass\s+`--read-only`/u);
  assert.match(herdrBackend, /contractual here/u);
});

test("an existing pair is resumed, never respawned to change its model", () => {
  assert.match(
    skill,
    /Look for an existing pair before proposing one[\s\S]*resumed as it is/u,
  );
  assert.match(
    skill,
    /respawning discards the pair's whole history, and a model is changed by ending\s+the pair/u,
  );
  // No hardcoded catalog: cursor's own list is the catalog.
  assert.match(skill, /cursor-agent --list-models/u);
  assert.match(skill, /grok models/u);
  assert.match(skill, /opencode models/u);
  assert.match(skill, /`CLI default`/u);
  assert.match(skill, /references\/models\.md/u);
  assert.match(models, /Risk/u);
  assert.match(models, /Context/u);
  assert.match(models, /Speed/u);
  assert.match(models, /Pool/u);
  assert.match(models, /`CLI default`/u);
  assert.match(models, /A Codex pair spawn always\s+sets\s+effort\s+explicitly, including medium/u);
  assert.match(models, /SKILL_DIR[\s\S]*usage-state\.mjs/u);
  // Claude Code has an effort door; the backend and prose must carry it.
  assert.match(skill, /Claude Code\s+\(`--effort low\|medium\|high\|xhigh\|max`\)/u);
  assert.match(models, /Claude Code accepts\s+`--effort low\|medium\|high\|xhigh\|max`/u);
  assert.match(headlessBackend, /Claude receives\s+`--effort low\|medium\|high\|xhigh\|max`/u);
  assert.match(headlessHelper, /EFFORT_SUPPORT = \{ claude: true/u);
  assert.match(headlessBackend, /`\[effort=…\]` suffix inside `--model`/u);
  assert.match(headlessBackend, /OpenCode\s+receives `--variant <effort>` on every invocation/u);
  assert.match(models, /OpenCode[\s\S]*`--variant`/u);
});

test("the roster is the single editable model preference source", () => {
  const roster = models.slice(models.indexOf("## Roster"));
  const seats = roster.slice(
    roster.indexOf("### Seats por papel"),
    roster.indexOf("### Dimension scores"),
  );
  const scores = roster.slice(
    roster.indexOf("### Dimension scores"),
    roster.indexOf("### Pace and fallback"),
  );
  const pace = roster.slice(
    roster.indexOf("### Pace and fallback"),
    roster.indexOf("### Effort"),
  );
  const effort = roster.slice(
    roster.indexOf("### Effort"),
    roster.indexOf("### Specialists and excluded"),
  );
  const seatModels = [
    "claude-fable-5",
    "claude-opus-5",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "kimi-k3",
    "gpt-daybreak-blue-latest",
    "grok-4.6",
  ];
  assert.equal(seats.split("\n").filter((line) => /^\| (?!Papel \|)[^|-].* \|$/u.test(line)).length, 8);
  for (const seat of seatModels) assert.match(seats, new RegExp(`\`${seat.replaceAll(".", "\\.")}\``, "u"));
  assert.match(seats, /Planear \/ orquestrar[\s\S]*medium[\s\S]*opening planning prompt[\s\S]*never max/u);
  assert.match(seats, /Execução de alta qualidade \(back-end e geral\)[\s\S]*`gpt-5\.6-sol`[\s\S]*`ultra` is a subagent mode/u);
  assert.match(seats, /Execução rápida[\s\S]*`grok-4\.6`[\s\S]*CLI default[\s\S]*`gpt-5\.6-sol` high/u);
  assert.match(seats, /Execução barata em volume[\s\S]*xhigh\/max[\s\S]*never for UI work[\s\S]*verbose at max/u);
  assert.match(seats, /UI \/ design \(taste\)[\s\S]*`kimi-k3`[\s\S]*`claude-opus-5`[\s\S]*Opus high for design review and medium for UI diffs[\s\S]*one covers the other/u);
  assert.match(seats, /Image gen \(UI ideas, imagens, app logos, qualquer coisa que precise de imagem\) \| \*\*Image Gen 2 with `gpt-5\.6`\*\* \| the `gpt-5\.6` surface that exposes Image Gen 2 \| — \| — \|/u);
  assert.match(seats, /Opus's primary seat is UI\/design[\s\S]*legitimate secondary use is execution[\s\S]*stronger supervisor such as Fable[\s\S]*SWE-V 96[\s\S]*daily-use experience[\s\S]*experience\s+governs/u);
  assert.match(seats, /open question[\s\S]*`kimi-k3` will replace\s+Opus[\s\S]*next design tasks/u);
  // Staffing reads the cancel/fork/restaff ladder here, before an incident,
  // not inside a failed wait receipt mid-incident.
  assert.match(seats, /Grok is a fast, good execution seat[\s\S]*headless recovery ladder[\s\S]*two\s+consecutive proved cancellations schedule a session fork[\s\S]*proved capability miss — restaff the unit/u);
  assert.match(seats, /Claude Code's\s+`\/design`/u);
  assert.match(seats, /composer-2\.5[\s\S]*"Grok plans, Composer builds"[\s\S]*56\.1 and 69\.9[\s\S]*not a headline seat/u);

  const scoredModels = [
    "claude-fable-5",
    "claude-opus-5",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "grok-4.6",
    "kimi-k3",
    "composer-2.5",
    "gpt-daybreak-blue",
  ];
  const scoreRows = scores.split("\n").filter((line) => /^\| `[^`]+`/u.test(line));
  assert.equal(scoreRows.length, 8);
  for (const model of scoredModels) assert.match(scores, new RegExp(`\`${model.replaceAll(".", "\\.")}\``, "u"));
  assert.match(scores, /\| Model \| Inteligência \| Taste \| Velocidade \| Custo \| Key evidence \| Updated \|/u);
  assert.equal(scores.match(/2026-08-21/g)?.length, 8);
  assert.match(scores, /Henrique's editable seeds[\s\S]*daily-use experience governs[\s\S]*benchmark aggregates inform[\s\S]*provisional/u);
  assert.match(scores, /Inteligência and Taste use a 0–10 scale/u);
  assert.match(scores, /Velocidade uses only `lento`, `médio`, or `rápido`[\s\S]*reasoning\s+effort makes a run slower/u);
  assert.match(scores, /Custo uses only `barato`, `médio`, or `caro`[\s\S]*subscription consumed[\s\S]*never uses\s+API prices/u);
  assert.match(scores, /Staff only the latest generation of each model family/u);
  assert.match(scores, /Scores rank models that already meet the risk and context bar/u);
  assert.match(scores, /Prefer a native harness over a Cursor duplicate/u);
  assert.match(scores, /machine-specific headless[\s\S]*`staffing\.md`/u);

  const dimensions = Object.fromEntries(scoreRows.map((line) => {
    const [model, intelligence, taste, speed, cost] = line
      .split("|")
      .slice(1, 6)
      .map((cell) => cell.trim().replaceAll("`", ""));
    return [model, [intelligence, taste, speed, cost]];
  }));
  assert.deepEqual(dimensions, {
    "claude-fable-5": ["9.5", "9", "lento", "caro"],
    "gpt-5.6-sol": ["9", "8", "médio", "médio"],
    "gpt-daybreak-blue": ["9", "n/a", "médio", "médio"],
    "grok-4.6": ["8.5", "6", "rápido", "barato"],
    "kimi-k3": ["8", "10", "lento", "médio"],
    "claude-opus-5": ["8", "9", "médio", "médio"],
    "gpt-5.6-luna": ["7", "5", "rápido", "barato"],
    "composer-2.5": ["7", "6", "rápido", "barato"],
  });
  assert.doesNotMatch(scoreRows.join("\n"), /\?/u);
  assert.doesNotMatch(scores, /API (?:input|output)|\$[0-9.]+\/M/u);
  assert.match(scores, /`kimi-k3`[\s\S]*inside the \$200 Cursor subscription/u);
  assert.match(scores, /`claude-opus-5` \| 8 \| 9[\s\S]*SWE-V 96[\s\S]*daily use puts it below Sol[\s\S]*UI\/design or work supervised by Fable/u);

  assert.match(pace, /usage-state\.mjs/u);
  assert.match(pace, /`used_percent >= 90`[\s\S]*refuses[\s\S]*rate limit[\s\S]*fallback/u);
  assert.match(pace, /Cursor is the deliberate universal fallback harness/u);
  assert.match(pace, /Balance equal-bar work across subscriptions/u);
  assert.match(pace, /Grok 4\.6 "unlimited" has a quota in practice/u);

  assert.match(effort, /per-seat guidance in Seats por papel overrides these generic ladders/u);
  assert.match(effort, /Sol `ultra`[\s\S]*multi-subagent delegation mode[\s\S]*Never set it by default/u);
  assert.match(effort, /Fable max has an overthinking regression/u);
  assert.match(effort, /Opus high is suitable for design review[\s\S]*medium for UI diffs/u);
  assert.match(effort, /Luna's hidden `max`[\s\S]*volume execution under external[\s\S]*review/u);

  const removed = ["claude-haiku-4-5", "gpt-5.6-terra", "claude-sonnet-5", "ox-alpha"];
  for (const model of removed) {
    assert.doesNotMatch(seats, new RegExp(model.replaceAll(".", "\\."), "u"));
    assert.doesNotMatch(scores, new RegExp(model.replaceAll(".", "\\."), "u"));
    assert.match(roster, new RegExp(model.replaceAll(".", "\\."), "u"));
  }
  assert.match(roster, /are removed by\s+decision/u);
  assert.match(roster, /Harness sub-agents already delegate to cheap and mid-tier models/u);
  assert.match(roster, /Promo IDs belong only in roster data, never in scripts/u);
  assert.doesNotMatch(`${helper}\n${headlessHelper}`, /x-preview-f-free/u);

  for (const excluded of [
    "gpt-5.6-cyber",
    "claude-mythos-5",
    "gpt-reserve",
    "codex-auto-review",
    "gemini-3.7-flash",
    "gemini-3.1-pro",
    "glm-5.2",
    "cursor-grok-4.6",
    "grok-build-0.1",
  ]) {
    assert.match(roster, new RegExp(excluded.replaceAll(".", "\\."), "u"));
  }
  // ox-alpha's removal must leave OpenCode seatless until Henrique scores a
  // replacement, not silently fall back to an undocumented model.
  assert.match(roster, /OpenCode has no roster seat until he\s+scores a new one/u);
});

test("each harness effort ladder matches its current control surface", () => {
  assert.match(models, /Claude Code accepts\s+`--effort low\|medium\|high\|xhigh\|max`/u);
  assert.match(models, /Codex[\s\S]*`low\|medium\|high\|xhigh\|max`/u);
  assert.match(models, /Sol uses low, and Luna uses medium/u);
  assert.match(models, /A Codex pair spawn always\s+sets\s+effort\s+explicitly, including medium/u);
  assert.match(models, /Cursor[\s\S]*effort is encoded in the model ID[\s\S]*`kimi-k3-high`/u);
  assert.match(models, /`--model '<id>\[effort=…\]'`/u);
  assert.match(models, /Grok 4\.6 accepts `low\|medium\|high\|xhigh`[\s\S]*defaults to high/u);
  assert.match(models, /OpenCode[\s\S]*`--variant` on every `opencode run`[\s\S]*not a session flag/u);
});

test("cursor, grok, and OpenCode delivery is documented as conservative", () => {
  assert.match(
    herdrBackend,
    /Cursor, Grok, and OpenCode are\s+unmeasured here and take the conservative Codex-shaped path/u,
  );
});

test("the old two-kind session is ended, never migrated", () => {
  assert.match(herdrBackend, /refused with the exact\s+`end … --stale true` command/u);
  assert.match(herdrBackend, /there is no migration/u);
  assert.match(helper, /predates the universal pair/u);
});

test("protocol, kinds, and write leases stay backend-neutral", () => {
  assert.match(skill, /\[agent <from> -> <to> kind=<kind> sid=<sid>\]/u);
  for (const kind of ["task", "review", "question", "ready", "accepted", "blocked", "stalemate", "handoff"]) {
    assert.match(skill, new RegExp(`^- \`${kind}\`:`, "mu"));
  }
  assert.match(
    skill,
    /one agent the write lease for each file scope: owner, target files,\s+forbidden changes, validation, and stop point\. The partner stays read-only on\s+that scope until handoff/u,
  );
});

test("a deliberate broken checkout is visible to both partners", () => {
  assert.match(
    skill,
    /Announce every deliberate broken-checkout window[\s\S]*send a `task` naming the affected paths and\s+stop condition; send `ready` after the tree is restored and verified/u,
  );
  assert.match(
    skill,
    /Do not\s+wait for `accepted`: the notices are the protection/u,
  );
  assert.match(
    skill,
    /open window treats that checkout's test results as unusable until the\s+close notice arrives, and asks rather than reports/u,
  );
  assert.match(
    skill,
    /cannot be announced, or that lasts more than a few minutes, in a separate\s+worktree/u,
  );
});

test("busy and idle partners keep distinct delivery proofs", () => {
  assert.match(
    herdrBackend,
    /Measured on Herdr 0\.8\.0[\s\S]*multi-line prompt to Codex still needs Enter[\s\S]*partner is still working,[\s\S]*sends exactly one `agent prompt`[\s\S]*runs the harmless Enter loop[\s\S]*skips the visible-arrival check and\s+the full resend/u,
  );
  assert.match(
    herdrBackend,
    /receipt=unproven-working-inspect-that-pane-then-reconcile[\s\S]*cannot distinguish a queued prompt from a silent\s+drop/u,
  );
  assert.match(
    herdrBackend,
    /For an idle partner, the helper proves landing from the composer[\s\S]*sends Enter until the composer releases the\s+text, performs one full resend, and fails loudly/u,
  );
  assert.match(
    herdrBackend,
    /pane registered in the last minute[\s\S]*TUI splash two seconds to settle[\s\S]*same\s+pending reservation stays active/u,
  );
});

test("code and prose expose the same delivery receipts", () => {
  const codeReceipts = receiptTokens(helper);
  const documentedReceipts = receiptTokens(herdrBackend);
  assert.ok(codeReceipts.length >= 4, "the helper must expose every delivery outcome as a receipt token");
  assert.deepEqual(documentedReceipts, codeReceipts);
});

test("the Herdr backend keeps its pane mechanics and its own pointers", () => {
  for (const mechanic of [
    /\[`caller pane proof`\]\(caller-pane-resolution\.md\)/u,
    /`scripts\/caller-proof\.mjs`/u,
    /\[`workbench-tab\.md`\]\(workbench-tab\.md\)/u,
    /scripts\/herdr-pair\.mjs/u,
    /node "\$PAIR_SCRIPT" discover/u,
    /node "\$PAIR_SCRIPT" init/u,
    /--clear-pending true/u,
    /--stale true/u,
  ]) {
    assert.match(herdrBackend, mechanic);
  }
});

test("the headless backend documents every send status the helper emits", () => {
  const documented = [...new Set([...headlessBackend.matchAll(/`status=([a-z-]+)`/gu)].map((m) => m[1]))].sort();
  for (const status of ["empty-reply", "failed", "hang-killed", "replied", "running", "worker-lost", "wait-timeout"]) {
    assert.ok(documented.includes(status), `headless.md must document ${status}`);
    assert.match(headlessHelper, new RegExp(`status: "${status}"`, "u"));
  }
  assert.match(headlessBackend, /reason=worker-lost/u);
  assert.match(headlessHelper, /worker-lost/u);
  assert.match(headlessBackend, /reason=grok-cancelled/u);
  assert.match(headlessHelper, /grok-cancelled/u);
});

test("the headless backend documents the helper's whole command surface", () => {
  for (const command of ["init", "send", "wait", "fork", "status", "clear", "end"]) {
    assert.match(headlessBackend, new RegExp(`\\$PAIR_SCRIPT" ${command} --repo`, "u"));
    assert.match(headlessHelper, new RegExp(`${command}: run`, "u"));
  }
  assert.match(headlessBackend, /send --repo[\s\S]*\[--background\]/u);
  assert.match(headlessBackend, /wait --repo[\s\S]*\[--seq/u);
  assert.match(headlessBackend, /default wait timeout is 125 minutes/u);
  assert.match(headlessHelper, /opt\("timeout-min", "125"\)/u);
  // Delivery turns run the repository's own CI, so writable task turns carry
  // the raised total budget and every hang receipt names the flag to raise.
  assert.match(headlessBackend, /writable `kind=task` turn defaults to a 45-minute idle budget and a\s+120-minute total budget/u);
  assert.match(headlessBackend, /hang-kill receipt names the flag to raise/u);
  assert.match(headlessHelper, /kind === "task" && write \? 45 : 20/u);
  assert.match(headlessHelper, /kind === "task" && write \? 120 : 60/u);
  assert.match(headlessHelper, /raise it with send --total-min/u);
  assert.match(headlessHelper, /raise it with send --idle-min/u);
  assert.match(headlessHelper, /keep tool output flowing so the idle watchdog can see progress/u);
  assert.match(headlessBackend, /fork --repo[\s\S]*\[--retry\]/u);
  assert.match(headlessBackend, /fork-scheduled[\s\S]*fork runs on the next normal `send`/u);
  assert.match(headlessBackend, /scripts\/pair-headless\.mjs/u);
  assert.match(headlessBackend, /half-duplex/u);
  assert.match(headlessBackend, /`<git-dir>\/pair\/session\.json`/u);
  assert.match(headlessBackend, /`\$XDG_STATE_HOME\/pair\/<basename>-<realpath-hash>\/`/u);
  assert.match(headlessBackend, /defaults to `~\/\.local\/state\/pair\/<basename>-<realpath-hash>\/`/u);
  assert.match(headlessBackend, /directory does not need to use Git/u);
  assert.match(headlessBackend, /GitHub remote\s+is not a precondition/u);
  assert.match(headlessBackend, /the helper refuses\s+to pair a CLI kind with itself/u);
});

test("the headless backend discloses supervisor, fork, and stream contracts", () => {
  for (const pointer of [
    /detached supervisor path/u,
    /supervisor_pid/u,
    /partner_pid/u,
    /receipt_file/u,
    /running record is not the\s+final receipt/u,
    /temporary file before renaming it into place/u,
    /state\.seq/u,
    /partial_reply=true/u,
    /pending_fork/u,
    /--fork-session --session-id/u,
    /successor_sid/u,
    /stream proves the new session ID/u,
    /first post-fork message states the sid\s+change/iu,
  ]) {
    assert.match(headlessBackend, pointer);
  }
  for (const flag of ["--json", "streaming-json", "stream-json", "--fork-session"]) {
    assert.match(headlessHelper, new RegExp(flag.replaceAll("-", "[-]"), "u"));
  }
  assert.match(headlessHelper, /--effort/u);
});

test("the headless backend states what each guarantee is actually worth", () => {
  // One pair per worktree, not per repository: the state lives in the
  // worktree's git dir, so a linked worktree carries its own.
  assert.match(headlessBackend, /a worktree holds one pair and a linked\s+worktree gets its own/u);
  // Headless has no approver, so the doc must carry the standing decision:
  // writable turns run each CLI's full bypass, and read-only turns keep each
  // CLI's restraining mode.
  assert.match(
    headlessBackend,
    /Writable turns therefore run every partner with its\s+full bypass[\s\S]*`danger-full-access`[\s\S]*`--permission-mode bypassPermissions`[\s\S]*`--always-approve`[\s\S]*`--force`[\s\S]*`--auto`/u,
  );
  assert.match(headlessBackend, /write lease,\s+scope contract, and review gates are the restraint/u);
  assert.match(
    headlessBackend,
    /Read-only turns keep each CLI's restraining mode[\s\S]*`read-only`\s+filesystem sandbox[\s\S]*`--permission-mode plan`[\s\S]*built-in `plan` agent/u,
  );
  assert.match(headlessHelper, /sandbox_mode="\$\{sandbox\}"/u);
  // Cursor writes by default in --print, which is the trap: its read-only turn
  // is the one that had to ask.
  assert.match(
    headlessBackend,
    /Cursor turn writes by default in `--print`[\s\S]*`--mode plan`[\s\S]*Only the Codex mode is an\s+OS sandbox/u,
  );
  // An empty reply may still have consumed the prompt, so resending can duplicate work.
  assert.match(
    headlessBackend,
    /`status=empty-reply`[\s\S]*Read\s+`transcript` first[\s\S]*may have consumed the prompt[\s\S]*inspect the task directory and `git status` when Git is present/u,
  );
  // session_known is evidence of loss, never proof of health.
  assert.match(
    headlessBackend,
    /`session_known` reports a positive absence\s+only[\s\S]*never proof of health/u,
  );
  // The lock is a file, and the prose has to name the file the reader will find
  // and the one command that removes it — a send never removes one itself.
  assert.match(
    headlessBackend,
    /takes a lock\s+by creating `<git-dir>\/pair\/in-flight\.json`[\s\S]*refuses over any existing marker/u,
  );
  assert.match(headlessBackend, /`clear` refuses while any recorded process is alive/u);
  assert.match(headlessHelper, /join\(stateDir, "in-flight\.json"\)/u);
});

test("facts get proof before judgment reaches stalemate", () => {
  assert.match(
    skill,
    /Settle a factual disagreement with one direct proof or\s+focused test before it can become a stalemate/u,
  );
  assert.match(skill, /same\s+judgment call repeats twice without movement/u);
});

test("the user handoff reports the live resources", () => {
  assert.match(
    skill,
    /local handoff naming the result, verification evidence, unresolved issues, and\s+every pair pane, worktree, or watcher still active/u,
  );
});
