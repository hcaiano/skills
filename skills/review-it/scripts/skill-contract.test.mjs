import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const skillDir = join(here, "..");
const read = (path) => readFileSync(path, "utf8");
const docs = ["SKILL.md", "references/review-brief.md", "references/visible-herdr-runs.md"];
const reviewIt = read(join(skillDir, "SKILL.md"));
const openai = read(join(skillDir, "agents/openai.yaml"));

// GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens.
const anchors = (markdown) =>
  new Set([...markdown.matchAll(/^#+\s+(.+)$/gmu)].map(([, heading]) =>
    heading.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, "").replace(/ /gu, "-")));

test("review-it is user-invoked in every runtime", () => {
  assert.match(reviewIt, /^name: review-it$/mu);
  assert.match(reviewIt, /^description: ".+"$/mu);
  assert.match(reviewIt, /^disable-model-invocation: true$/mu);
  assert.match(openai, /^  allow_implicit_invocation: false$/mu);
  assert.match(openai, /\$review-it\b/u);
});

test("every relative link, anchor, and named script resolves", () => {
  for (const name of docs) {
    const text = read(join(skillDir, name));
    for (const [, target, anchor] of text.matchAll(/\]\((?!https?:)([^)#]*)(?:#([^)]+))?\)/gu)) {
      const path = join(dirname(join(skillDir, name)), target || name.split("/").at(-1));
      assert.ok(existsSync(path), `${name} links to missing ${target}`);
      if (anchor) assert.ok(anchors(read(path)).has(anchor), `${name} links to missing #${anchor} in ${target}`);
    }
    for (const [, script] of text.matchAll(/\b([a-z-]+\.mjs)\b/gu)) {
      // The capacity and model helpers belong to the sibling pair skill.
      const owner = ["usage-state.mjs", "pair-headless.mjs"].includes(script) ? join(skillDir, "../pair/scripts") : here;
      assert.ok(existsSync(join(owner, script)), `${name} names missing ${script}`);
    }
  }
});

test("the receipt carries the fields that orchestrate's delivery verifies", () => {
  for (const field of ["## Review gate", "Gate:", "Risk:", "Regrade:", "Reviewed HEAD:", "Gate HEAD:"]) {
    assert.ok(reviewIt.includes(field), `receipt is missing ${field}`);
  }
});
