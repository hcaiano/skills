// Structural checks on the skill's documents: links resolve, every command the
// documents give exists in the script that runs it, and the text the scripts
// parse keeps its shape. Wording is the documents' own business.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const skillDir = resolve(here, "..");
const skillsDir = resolve(skillDir, "..");
const read = (path) => readFileSync(path, "utf8");
const docPaths = [
  join(skillDir, "SKILL.md"),
  ...readdirSync(join(skillDir, "references"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(skillDir, "references", name)),
];
const docs = new Map(docPaths.map((path) => [path, read(path)]));
const skill = docs.get(join(skillDir, "SKILL.md"));
const delivery = docs.get(join(skillDir, "references", "delivery.md"));
const unit = read(join(here, "unit.mjs"));
const headlessPair = read(join(skillsDir, "pair", "scripts", "pair-headless.mjs"));
const name = (path) => relative(skillDir, path);

const withoutCode = (markdown) => markdown.replace(/```[\s\S]*?```/gu, "");
// GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens.
const slug = (heading) =>
  heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /gu, "-");
const anchors = (markdown) =>
  new Set([...withoutCode(markdown).matchAll(/^#{1,6}\s+(.+)$/gmu)].map(([, heading]) => slug(heading)));
const links = (path) =>
  [...withoutCode(docs.get(path)).matchAll(/\]\(([^)\s]+)\)/gu)]
    .map(([, target]) => target)
    .filter((target) => !/^[a-z]+:/u.test(target));

// A documented command, with its `\` continuation lines joined and any
// trailing inline-code backtick cut off.
const commands = (prefix) => {
  const found = [];
  for (const [path, markdown] of docs) {
    const lines = markdown.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const start = lines[index].indexOf(prefix);
      if (start === -1) continue;
      let command = lines[index].slice(start);
      while (command.endsWith("\\") && index + 1 < lines.length) {
        index += 1;
        command = `${command.slice(0, -1)} ${lines[index].trim()}`;
      }
      found.push({ path, command: command.split("`")[0] });
    }
  }
  return found;
};
const flagsOf = (command) => [...command.matchAll(/(?:^|[\s[|])--([a-z][a-z-]*)/gu)].map(([, flag]) => flag);

test("orchestrate is manual-only in every harness", () => {
  const front = skill.match(/^---\n([\s\S]*?)\n---\n/u)?.[1];
  assert.ok(front, "SKILL.md has no frontmatter");
  assert.match(front, /^name: orchestrate$/mu);
  assert.match(front, /^description: ".+"$/mu);
  assert.match(front, /^disable-model-invocation: true$/mu);
  const openai = read(join(skillDir, "agents", "openai.yaml"));
  assert.match(openai, /^policy:\n {2}allow_implicit_invocation: false$/mu);
});

test("every relative link resolves, and every reference is linked", (t) => {
  const linked = new Set();
  for (const path of docPaths) {
    for (const target of links(path)) {
      const [file, anchor] = target.split("#");
      const resolved = file ? resolve(dirname(path), file) : path;
      assert.ok(existsSync(resolved), `${name(path)} links to missing ${target}`);
      linked.add(resolved);
      if (!anchor) continue;
      const found = anchors(read(resolved)).has(anchor);
      if (resolved.startsWith(`${skillDir}/`)) {
        assert.ok(found, `${name(path)} links to missing heading ${target}`);
      } else if (!found) {
        // A sibling skill owns its headings and may be mid-edit; report the
        // stale anchor without failing this skill's suite.
        t.diagnostic(`${name(path)} links to ${target}, whose heading is not there yet`);
      }
    }
  }
  for (const path of docPaths.slice(1)) {
    assert.ok(linked.has(path), `${name(path)} is not linked from any document`);
  }
});

test("documented paths exist beside the skill", () => {
  for (const [, path] of skill.matchAll(/"\$ORCHESTRATE_DIR\/([^"]+)"/gu)) {
    assert.ok(existsSync(resolve(skillDir, path)), `SKILL.md names missing $ORCHESTRATE_DIR/${path}`);
  }
  for (const [path, markdown] of docs) {
    for (const [, script] of markdown.matchAll(/<pair-dir>\/([\w./-]+)/gu)) {
      assert.ok(existsSync(join(skillsDir, "pair", script)), `${name(path)} names missing pair ${script}`);
    }
  }
});

test("every documented unit command and flag exists in unit.mjs, and every command is documented", () => {
  const dispatched = new Set([...unit.matchAll(/command === "([a-z-]+)"\) emit/gu)].map(([, command]) => command));
  assert.ok(dispatched.size > 0, "unit.mjs dispatch not found");
  const documented = new Set();
  for (const { path, command } of commands('node "$UNIT" ')) {
    const subcommand = command.match(/^node "\$UNIT" ([a-z-]+)/u)?.[1];
    assert.ok(dispatched.has(subcommand), `${name(path)} documents unknown unit command: ${command}`);
    documented.add(subcommand);
    for (const flag of flagsOf(command)) {
      assert.match(
        unit,
        new RegExp(`options(?:\\.${flag}\\b|\\["${flag}"\\])|"${flag}"`, "u"),
        `${name(path)} passes --${flag}, which unit.mjs never reads`,
      );
    }
  }
  for (const command of dispatched) {
    assert.ok(documented.has(command), `unit.mjs ${command} is documented nowhere`);
  }
});

test("every documented pair-headless command and flag exists in its usage", () => {
  const usage = headlessPair.match(/usage: pair-headless\.mjs <([a-z|]+)>([^`]*)`/u);
  assert.ok(usage, "pair-headless.mjs usage line not found");
  const subcommands = new Set(usage[1].split("|"));
  const found = commands('node "$HEADLESS_PAIR" ');
  assert.ok(found.length > 0, "no pair-headless command is documented");
  for (const { path, command } of found) {
    const subcommand = command.match(/^node "\$HEADLESS_PAIR" ([a-z-]+)/u)?.[1];
    assert.ok(subcommands.has(subcommand), `${name(path)} documents unknown pair command: ${command}`);
    for (const flag of flagsOf(command)) {
      assert.match(usage[2], new RegExp(`--${flag}\\b`, "u"), `${name(path)} passes --${flag}, absent from pair's usage`);
    }
  }
});

test("the receipt fields delivery verifies exist in the receipts that ship-it and review-it write", () => {
  const start = delivery.indexOf("## Verify live evidence");
  assert.notEqual(start, -1, "delivery.md has no live-evidence section");
  const section = delivery.slice(start, delivery.indexOf("\n## ", start + 1)).replace(/\s+/gu, " ");
  const fields = [...section.matchAll(/`([A-Z][A-Za-z ]*?(?: HEAD|:))`/gu)].map(([, field]) => field.replace(/:$/u, ""));
  assert.ok(fields.length >= 4, "delivery.md names too few receipt fields");
  const receipts = ["ship-it", "review-it"].map((skillName) => read(join(skillsDir, skillName, "SKILL.md"))).join("\n");
  for (const field of fields) {
    assert.ok(receipts.includes(`- ${field}:`), `delivery checks ${field}, which no receipt writes`);
  }
  assert.ok(receipts.includes("## Delivery gate") && delivery.includes("## Delivery gate"));
});

test("the documented addendum shape is the one create parses", () => {
  const marker = unit.match(/\$\{body\}\\n(## Addendum — )/u)?.[1];
  assert.ok(marker, "unit.mjs no longer parses a marked addendum");
  assert.ok(skill.includes(`\n${marker}<UTC timestamp>\n`), "SKILL.md documents another addendum shape");
});
