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
    /An `\[agent \.\.\.\]` header is\s+shared by both transports: use the recorded session/u,
  );
  assert.match(skill, /explicit headless request/u);
  assert.match(skill, /`\[herdr-pair control \.\.\.\]` line identifies Herdr/u);
});

test("the description carries every trigger", () => {
  const description = skill.match(/^description: "(.+)"$/mu)[1];
  for (const trigger of [
    /live peer work/u,
    /Pair persistently/u,
    /`\[agent \.\.\.\]` or `\[herdr-pair control \.\.\.\]` messages/u,
    /after context compaction/u,
  ]) {
    assert.match(description, trigger);
  }
  // Provider details belong in the body; the pointer carries trigger branches.
  assert.doesNotMatch(description, /Claude-Codex/u);
});

test("the five kinds, the partner rule, and the roles are the same everywhere", () => {
  const kinds = ["claude", "codex", "cursor", "grok", "opencode"];
  for (const kind of kinds) {
    assert.match(skill, new RegExp(`\`${kind}\``, "u"), `SKILL.md must name ${kind}`);
  }
  // Same CLI on both sides is refused, in prose and in both helpers — with one
  // exception both prose and the headless helper carry: a second Codex account
  // is a different login, so a named identity on another home is a peer.
  assert.match(skill, /transports require a\s+different CLI, except headless Codex can use a different account home/u);
  assert.match(skill, /separate accounts\s+do not themselves guarantee independent reasoning/u);
  assert.match(skill, /with `--identity <name>`\. The helper proves home separation/u);
  assert.match(skill, /same underlying model or provider/u);
  assert.match(helper, /refusing to pair \$\{self\.agent\} with itself/u);
  assert.match(headlessHelper, /refusing to pair \$\{self\} with itself/u);
  assert.match(headlessHelper, /requested !== "codex" \|\| !own \|\| own === account\.identity_home/u);
  assert.match(headlessHelper, /if \(partner === "codex" && identityHome\) child\.CODEX_HOME = identityHome/u);
  assert.match(headlessHelper, /for \(const marker of LEAD_MARKERS\) delete child\[marker\]/u);
  assert.match(headlessBackend, /strips the lead's own harness\s+markers/u);
  assert.match(headlessBackend, /recorded\s+before identities existed keeps the `CODEX_HOME` it inherited/u);
  assert.match(headlessBackend, /`CODEX_BIN`/u);
  assert.match(headlessBackend, /`partner_bin`/u);
  assert.match(headlessHelper, /verifyCodexBinary\(codexBinary\(process\.env\)\)/u);
  assert.match(headlessBackend, /except two Codex accounts[\s\S]*same home is refused by the transport/u);
  assert.match(headlessBackend, /runs\s+with `CODEX_HOME` set to that recorded home, never to the caller's own/u);
  // The Herdr backend has no identity plumbing, and says so instead of
  // starting the wrong account.
  assert.match(herdrBackend, /refuse `--identity` other than `default` and any `--model latest…`/u);
  assert.match(helper, /is not supported on the Herdr backend/u);
  assert.match(helper, /is not resolved on the Herdr backend/u);
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

test("an existing pair is capacity-checked and never respawned to change its model", () => {
  assert.match(
    skill,
    /Look for an existing pair before proposing one[\s\S]*Resume an existing\s+pair when its pool is available/u,
  );
  assert.match(skill, /When its pool is protected[\s\S]*ask whether to spend it or end the session/u);
  assert.match(
    skill,
    /respawning discards the pair's whole\s+history, and a model is changed by ending the pair/u,
  );
  // No hardcoded catalog: cursor's own list is the catalog.
  assert.match(models, /cursor-agent --list-models/u);
  assert.match(models, /grok models/u);
  assert.match(models, /opencode models/u);
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
  assert.match(skill, /effort controls, and account capacity/u);
  assert.match(models, /Claude Code accepts\s+`--effort low\|medium\|high\|xhigh\|max`/u);
  assert.match(headlessBackend, /Claude receives\s+`--effort low\|medium\|high\|xhigh\|max`/u);
  assert.match(headlessHelper, /EFFORT_SUPPORT = \{ claude: true/u);
  assert.match(headlessBackend, /`\[effort=…\]` suffix inside `--model`/u);
  assert.match(headlessBackend, /OpenCode\s+receives `--variant <effort>` on every invocation/u);
  assert.match(models, /OpenCode[\s\S]*`--variant`/u);
});

test("the roster is the single editable model preference source, by family", () => {
  const roster = models.slice(models.indexOf("## Roster"));
  const families = roster.slice(
    roster.indexOf("### Families"),
    roster.indexOf("### Seats por papel"),
  );
  const seats = roster.slice(
    roster.indexOf("### Seats por papel"),
    roster.indexOf("### Accounts and pace"),
  );
  const pace = roster.slice(
    roster.indexOf("### Accounts and pace"),
    roster.indexOf("### Effort"),
  );
  const effort = roster.slice(
    roster.indexOf("### Effort"),
    roster.indexOf("### Specialists and excluded"),
  );
  // Families, not IDs: the catalog decides the current member, and the prose
  // states the resolution rule the helper implements.
  assert.match(roster, /The roster names \*\*families\*\*, not IDs/u);
  assert.match(families, /A family appears only when its native harness or the live Cursor catalog\s+exposes it/u);
  assert.match(families, /Recheck both sources before adding a family; omit it while neither\s+source has it/u);
  assert.match(families, /`--model latest:<family>`/u);
  assert.match(families, /`model_resolved`[\s\S]*`model_source`[\s\S]*`resolved_at`/u);
  assert.match(families, /never\s+substitutes a neighbouring family, never picks a hidden or promo entry, and\s+fails when two members tie at the newest version/u);
  assert.match(families, /change a model by ending the pair, never mid-session/u);
  assert.doesNotMatch(models, /### Henrique's tier list|### Dimension scores|### Operational preferences|\| Tier \||S\+ \||D-tier/u);

  const familyRows = families.split("\n").filter((line) => /^\| `[^`]+` \|/u.test(line));
  const family = Object.fromEntries(familyRows.map((line) => {
    const [name, harness, resolution, evidence] = line.split("|").slice(1, 5).map((cell) => cell.trim().replaceAll("`", ""));
    return [name, { harness, resolution, evidence }];
  }));
  assert.deepEqual(Object.fromEntries(Object.entries(family).map(([name, value]) => [name, value.harness])), {
    fable: "claude",
    astra: "codex",
    sol: "codex",
    luna: "codex",
    opus: "claude",
    sonnet: "claude",
    grok: "grok",
    kimi: "cursor",
  });
  // Each family's request form is the helper's own accepted syntax, and the
  // evidence column carries dated exact IDs — the only place IDs may live.
  for (const [name, value] of Object.entries(family)) {
    assert.match(value.resolution, new RegExp(`latest:${name}`, "u"));
    assert.match(value.evidence, /^[a-z][a-z0-9.-]+$/u, `${name} evidence must be one exact ID`);
  }
  assert.equal(family.fable.evidence, "claude-fable-5-1");
  assert.equal(family.astra.evidence, "gpt-6-astra");
  assert.match(family.fable.resolution, /system\.init\.model[\s\S]*every resumed turn pins it/u);
  assert.match(family.kimi.resolution, /--effort[\s\S]*the ID carries the effort/u);
  assert.match(families, /Cursor had no Astra on 2026-09-07/u);
  assert.match(families, /OpenCode has no family\s+resolution/u);
  assert.match(families, /Prefer a native harness over a Cursor duplicate when role and\s+pool are equal/u);
  assert.match(families, /machine-specific headless[\s\S]*`staffing\.md`/u);
  assert.match(families, /Promo IDs belong\s+only in roster data, never in scripts/u);
  assert.doesNotMatch(families, /API (?:input|output)|\$[0-9.]+\/M/u);
  for (const stale of ["claude-fable-5`", "gpt-5.6-sol`", "gpt-5.6-luna`", "grok-4.6`"]) {
    assert.doesNotMatch(seats, new RegExp(`\`${stale.replaceAll(".", "\\.")}`, "u"), `seats name families, never the stale ID ${stale}`);
  }
  for (const [kind, pattern] of [
    ["codex", /LATEST = \/\^latest:\(\[a-z0-9\]\+\)\$\/iu/u],
    ["codex", /CODEX_ID = \/\^gpt-\(\\d\+\(\?:\\\.\\d\+\)\*\)-\(\[a-z0-9\]\+\)\$\/iu/u],
    ["codex", /entry\?\.hidden === true\) continue/u],
    ["claude", /CLAUDE_ALIASES = \["fable", "opus", "sonnet"\]/u],
    ["grok", /catalogText\("grok", \["models"\]/u],
    ["cursor", /catalogText\("cursor-agent", \["--list-models"\]/u],
  ]) {
    assert.match(headlessHelper, pattern, `the headless helper resolves ${kind} families as documented`);
  }

  // Henrique's current policy is the seat table; the earlier tier list is gone.
  assert.equal(seats.split("\n").filter((line) => /^\| (?!Papel \|)[^|-].* \|$/u.test(line)).length, 11);
  assert.match(seats, /Planear \/ orquestrar \| `fable` \*\*and\*\* `astra`, always both[\s\S]*independent proposal after the one user interview[\s\S]*synthesises/u);
  assert.match(seats, /Fable \*\*medium\*\* for normal work, \*\*high\*\* on the opening planning prompt[\s\S]*never max; Astra \*\*high\*\*, \*\*xhigh\*\* for hard analysis \| none — planning without both seats is reported, not substituted/u);
  assert.match(seats, /Execução limitada \(implementação, testes, lookup\) \| `luna` \| codex \| \*\*max\*\* \| `grok` high for simple bounded tasks/u);
  assert.match(seats, /Inspeção rápida \| `sol` \| codex \| \*\*low\*\*/u);
  assert.match(seats, /Review \/ segurança \| `sol` \| codex \| \*\*high\*\*/u);
  assert.match(seats, /Análise difícil \| `sol` \| codex \| \*\*xhigh\*\*/u);
  assert.match(seats, /Execução delegada em Claude, limitada \| `sonnet` \| claude/u);
  assert.match(seats, /Execução delegada em Claude, transversal ou review \| `opus` \| claude \| \*\*high\*\*/u);
  assert.match(seats, /Tarefas simples e research live web\/X \| `grok` \| grok \| \*\*high\*\* \(CLI default\)/u);
  assert.match(seats, /UI \/ design \(taste\) \| `kimi` \| cursor \| `kimi-k3-high`[\s\S]*`fable` medium\/high → `opus` high for design review or medium for UI diffs/u);
  assert.match(seats, /Image gen \(UI ideas, imagens, app logos, qualquer coisa que precise de imagem\) \| the image-generation product surface, not a pair seat \| whichever GPT surface currently exposes it \| — \| — \|/u);
  assert.match(seats, /`daybreak-blue`, by exact ID from the catalog[\s\S]*unversioned, so `latest:` cannot resolve it/u);
  assert.match(seats, /`composer` has one niche[\s\S]*no effort token, so it is named exactly/u);
  assert.match(seats, /Cyber \(defensivo\) \| `daybreak-blue`, by exact ID from the catalog \(`gpt-daybreak-blue-latest` on 2026-09-07/u);
  assert.match(seats, /Sol `max` or `ultra` needs Henrique's explicit request\. `terra` has no seat\.\s+`haiku` has no seat/u);
  assert.match(seats, /Grok is eligible for simple bounded tasks in its own right[\s\S]*instead of queueing behind a busy or\s+expensive pool/u);
  // Staffing reads the cancel/fork/restaff ladder here, before an incident,
  // not inside a failed wait receipt mid-incident.
  assert.match(seats, /headless recovery ladder[\s\S]*two consecutive proved cancellations schedule a session\s+fork[\s\S]*proved capability miss — restaff the unit/u);
  assert.match(seats, /Claude Code's\s+`\/design`/u);
  assert.match(seats, /`composer` has one niche[\s\S]*"Grok plans, Composer builds"[\s\S]*not a headline seat/u);
  assert.doesNotMatch(seats, /56\.1|69\.9|CursorBench/u, "benchmark assertions are out; the policy is the seat");
  // Explicit or orchestrate-approved staffing is never re-asked.
  assert.match(seats, /An explicit choice is final[\s\S]*do not ask again[\s\S]*Ask only for a material choice that is missing in\s+a standalone pairing/u);
  assert.match(skill, /take every choice the user or an orchestrate unit has\s+already made[\s\S]*as final and do not\s+ask for it again/u);

  assert.match(pace, /An \*\*identity\*\* is the account a partner CLI runs as/u);
  assert.match(pace, /`default` is `~\/\.codex` and a named identity is\s+`~\/\.codex-profiles\/<name>`/u);
  assert.match(pace, /every init, send, status, and\s+resume uses that recorded home, never the caller's environment/u);
  assert.match(pace, /The Herdr backend has no identity support/u);
  assert.match(pace, /usage-state\.mjs/u);
  assert.match(pace, /`account\/rateLimits\/read`[\s\S]*`scripts\/codex-rpc\.mjs`, which reads and never starts a turn/u);
  assert.match(pace, /Account capacity is read after the task bar is set, never before/u);
  assert.match(pace, /`cursor\.cursor_models`[\s\S]*`cursor\.other_models`/u);
  assert.match(pace, /\*\*protected\*\* — `pace > 1`/u);
  assert.match(pace, /\*\*unavailable\*\* — `used_percent >= 90`, refusal, or rate limit/u);
  assert.match(pace, /the other Codex identity for a Codex seat, then the seat's listed\s+fallback/u);
  assert.match(pace, /Cursor is the deliberate universal fallback harness/u);
  assert.match(pace, /prefer lower `pace`, then lower\s+`used_percent`, then speed/u);
  assert.match(pace, /Balance equal-bar work across subscriptions and\s+across the two Codex identities/u);
  assert.match(pace, /Grok 4\.6 "unlimited" has a quota\s+in practice/u);

  assert.match(effort, /per-seat guidance in Seats por papel overrides these generic ladders/u);
  assert.match(effort, /checked\s+against the catalog's effort list for the resolved model/u);
  assert.match(effort, /Sol `ultra` requires explicit user selection and support in the live catalog/u);
  assert.match(effort, /Fable max has an overthinking regression/u);
  assert.match(effort, /Opus high is suitable for design review[\s\S]*medium for UI diffs/u);
  assert.match(effort, /Luna `max` is the setting for bounded execution under external planning and\s+review/u);

  const removed = ["haiku", "ox-alpha"];
  for (const model of removed) {
    assert.match(roster, new RegExp(model.replaceAll(".", "\\."), "u"));
  }
  assert.match(roster, /`haiku` is removed by decision/u);
  assert.match(roster, /`terra` \(`gpt-5\.6-terra`\) is excluded by Henrique's decision/u);
  assert.doesNotMatch(seats, /`terra`[^\n]*\| codex/u);
  assert.match(roster, /Harness sub-agents already delegate to cheap\s+and mid-tier models/u);
  assert.doesNotMatch(`${helper}\n${headlessHelper}`, /x-preview-f-free|gpt-5\.6|claude-fable-5|grok-4\.6/u, "scripts carry no model IDs");

  for (const excluded of [
    "gpt-5.6-cyber",
    "claude-mythos-5",
    "gpt-reserve",
    "codex-auto-review",
    "cursor-grok-4.6",
    "grok-build-0.1",
  ]) {
    assert.match(roster, new RegExp(excluded.replaceAll(".", "\\."), "u"));
  }
  assert.match(roster, /`gemini` families are excluded through every harness, including Cursor/u);
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
