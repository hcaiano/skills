import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { AGENT_KINDS, CLAUDE_ALIASES } from "./pair-headless.mjs";

const here = new URL(".", import.meta.url).pathname;
const pairDir = join(here, "..");
const skillsDir = join(pairDir, "..");
const askPeerDir = join(skillsDir, "ask-peer");
const read = (path) => readFileSync(path, "utf8");
const markdownIn = (dir) =>
  readdirSync(dir, { recursive: true }).filter((name) => name.endsWith(".md")).map((name) => join(dir, name));
const withoutFences = (text) => text.replace(/^```[\s\S]*?^```/gmu, "");

// GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens.
const anchorsOf = (file) =>
  new Set(
    [...withoutFences(read(file)).matchAll(/^#{1,6}\s+(.+)$/gmu)].map(([, heading]) =>
      heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/gu, "-"),
    ),
  );

const brokenLinks = (file, only = () => true) => {
  const broken = [];
  for (const [, target] of withoutFences(read(file)).matchAll(/\]\(([^)\s]+)\)/gu)) {
    if (/^[a-z]+:/u.test(target) || !only(target)) continue;
    const [path, anchor] = target.split("#");
    const resolved = path ? join(dirname(file), path) : file;
    if (!existsSync(resolved)) broken.push(`${target} (missing file)`);
    else if (anchor && !anchorsOf(resolved).has(anchor)) broken.push(`${target} (missing anchor)`);
  }
  return broken.map((link) => `${relative(skillsDir, file)} -> ${link}`);
};

test("every relative link and anchor in pair and ask-peer resolves", () => {
  const docs = [...markdownIn(pairDir), ...markdownIn(askPeerDir)];
  assert.deepEqual(docs.flatMap((file) => brokenLinks(file)), []);
});

test("every link another skill makes into pair resolves", () => {
  const others = readdirSync(skillsDir)
    .filter((name) => name !== "pair" && existsSync(join(skillsDir, name, "SKILL.md")))
    .flatMap((name) => markdownIn(join(skillsDir, name)));
  assert.deepEqual(others.flatMap((file) => brokenLinks(file, (target) => target.includes("pair/"))), []);
});

test("the seats and the pool rule other skills link to exist", () => {
  const anchors = anchorsOf(join(pairDir, "references/models.md"));
  for (const anchor of ["planning-seat", "executor-seat", "review-seat", "analysis-seat", "pools"]) {
    assert.ok(anchors.has(anchor), `models.md is missing #${anchor}`);
  }
});

// A command snippet is a fenced line (with its backslash continuations) or an
// inline code span that runs a helper; the helper must dispatch the
// subcommand and read every flag the snippet passes.
const snippets = (text) => {
  const fenced = [...text.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gmu)]
    .flatMap(([, body]) => body.replace(/\\\n/gu, " ").split("\n"));
  const inline = [...withoutFences(text).matchAll(/`([^`]+)`/gu)].map(([, span]) => span);
  return [...fenced, ...inline];
};

const helperCalls = (doc, variable) =>
  snippets(read(doc))
    .filter((line) => line.includes(variable))
    .map((line) => ({
      line,
      command: line.slice(line.indexOf(variable) + variable.length).match(/^"?\s+([a-z]+)/u)?.[1] ?? null,
      flags: [...line.matchAll(/(?<![\w-])--([a-z][a-z-]*)/gu)].map(([, flag]) => flag),
    }));

test("every helper command and flag the docs run exists in that helper", () => {
  const cases = [
    ["references/herdr.md", '$PAIR_SCRIPT', "herdr-pair.mjs", (source, command) => source.includes(`command === "${command}"`)],
    ["references/headless.md", '$PAIR_SCRIPT', "pair-headless.mjs", (source, command) => new RegExp(`^\\s+${command}: run`, "mu").test(source)],
    ["references/caller-pane-resolution.md", '$CALLER_PROOF_SCRIPT', "caller-proof.mjs", null],
    ["references/models.md", "scripts/usage-state.mjs", "usage-state.mjs", null],
  ];
  for (const [doc, variable, script, dispatches] of cases) {
    const source = read(join(here, script));
    const calls = helperCalls(join(pairDir, doc), variable);
    assert.ok(calls.length > 0, `${doc} runs ${script}`);
    for (const { line, command, flags } of calls) {
      if (dispatches && command) assert.ok(dispatches(source, command), `${script} has no ${command} command (${doc}: ${line})`);
      for (const flag of flags) {
        assert.match(source, new RegExp(`["'.]${flag}["'),]|--${flag}\\b`, "u"), `${script} reads no --${flag} (${doc}: ${line})`);
      }
    }
  }
});

test("every public helper command is documented", () => {
  const headless = read(join(pairDir, "references/headless.md"));
  const table = read(join(here, "pair-headless.mjs")).match(/const COMMANDS = \{([\s\S]*?)\};/u)[1];
  for (const [, command] of table.matchAll(/^\s+([a-z]+):/gmu)) {
    assert.match(headless, new RegExp(`\\$PAIR_SCRIPT" ${command} --repo`, "u"), `headless.md documents ${command}`);
  }
  const herdr = read(join(pairDir, "references/herdr.md"));
  for (const [, command] of read(join(here, "herdr-pair.mjs")).matchAll(/command === "([a-z]+)"/gu)) {
    assert.match(herdr, new RegExp(`\\$PAIR_SCRIPT" ${command}\\b|\`${command}\``, "u"), `herdr.md documents ${command}`);
  }
});

test("frontmatter sets who may invoke each skill", () => {
  const frontmatter = (dir) => read(join(dir, "SKILL.md")).match(/^---\n([\s\S]*?)\n---/u)[1];
  const pair = frontmatter(pairDir);
  const askPeer = frontmatter(askPeerDir);
  assert.match(pair, /^name: pair$/mu);
  assert.match(askPeer, /^name: ask-peer$/mu);
  for (const meta of [pair, askPeer]) assert.match(meta, /^description: "[^"]{20,}"$/mu);
  // pair must fire on inbound partner traffic, so the model reaches it itself.
  assert.doesNotMatch(pair, /disable-model-invocation/u);
  // Claude consults Codex only when the user invokes ask-peer; Codex may
  // consult Claude on its own under the skill's When-to-ask rule.
  assert.match(askPeer, /^disable-model-invocation: true$/mu);
  for (const dir of [pairDir, askPeerDir]) {
    assert.match(read(join(dir, "agents/openai.yaml")), /^ {2}allow_implicit_invocation: true$/mu);
  }
});

test("the protocol header, kinds, and agent kinds match what the helpers emit", () => {
  const skill = read(join(pairDir, "SKILL.md"));
  assert.ok(skill.includes("[agent <from> -> <to> kind=<kind> sid=<sid>]"));
  for (const script of ["herdr-pair.mjs", "pair-headless.mjs"]) {
    assert.match(read(join(here, script)), /`\[agent \$\{[^}]+\} -> \$\{[^}]+\} kind=\$\{kind\} sid=\$\{[^}]+\}\]/u);
  }
  const kinds = read(join(here, "pair-headless.mjs")).match(/const KINDS = new Set\(\[([\s\S]*?)\]\)/u)[1];
  const protocol = skill.slice(skill.indexOf("## Protocol"), skill.indexOf("## Write leases"));
  const documented = [...protocol.matchAll(/^- `([a-z]+)`:/gmu)].map(([, kind]) => kind);
  assert.deepEqual(documented.sort(), [...kinds.matchAll(/"([a-z]+)"/gu)].map(([, kind]) => kind).sort());
  for (const kind of AGENT_KINDS) assert.ok(skill.includes(`\`${kind}\``), `SKILL.md names ${kind}`);
  assert.match(read(join(here, "herdr-pair.mjs")), new RegExp(`^const agentKinds = ${JSON.stringify(AGENT_KINDS).replaceAll(",", ", ").replace(/[[\]]/gu, "\\$&")};$`, "mu"));
});

test("each backend documents every outcome its helper emits", () => {
  const tokens = (text) => [...new Set([...text.matchAll(/receipt=([a-z][a-z-]+)/gu)].map(([, token]) => token))].sort();
  const herdrCode = tokens(read(join(here, "herdr-pair.mjs")));
  assert.ok(herdrCode.length >= 4);
  assert.deepEqual(tokens(read(join(pairDir, "references/herdr.md"))), herdrCode);

  const headless = read(join(pairDir, "references/headless.md"));
  const headlessCode = read(join(here, "pair-headless.mjs"));
  for (const status of ["replied", "empty-reply", "failed", "hang-killed", "running", "worker-lost", "wait-timeout", "fork-scheduled"]) {
    assert.ok(headless.includes(`status=${status}`), `headless.md documents ${status}`);
    assert.ok(headlessCode.includes(`status: "${status}"`), `pair-headless.mjs emits ${status}`);
  }
  assert.ok(headlessCode.includes('reason: "grok-cancelled"') && headless.includes("reason=grok-cancelled"));
});

test("the roster's families are requests the resolver accepts, and IDs stay out of scripts", () => {
  const models = read(join(pairDir, "references/models.md"));
  const rows = [...models.matchAll(/^\| `([^`]+)` \| ([a-z, ]+) \|/gmu)];
  assert.ok(rows.length >= 8);
  for (const [, family, harnesses] of rows) {
    assert.match(family, /^[a-z0-9]+$/u, `latest:${family} must parse as a family`);
    if (harnesses.includes("claude")) assert.ok(CLAUDE_ALIASES.includes(family), `claude resolves ${family} as an alias`);
  }
  const modelId = /["'`](?:gpt-\d|claude-(?:fable|opus|sonnet|haiku)-\d|grok-\d|kimi-k\d)/u;
  for (const script of readdirSync(here).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))) {
    assert.doesNotMatch(read(join(here, script)), modelId, `${script} carries a model ID`);
  }
});
