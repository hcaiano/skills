import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const skillDir = join(here, "..");
const docs = {
  "SKILL.md": readFileSync(join(skillDir, "SKILL.md"), "utf8"),
  "references/review-brief.md": readFileSync(join(skillDir, "references/review-brief.md"), "utf8"),
  "references/visible-herdr-runs.md": readFileSync(join(skillDir, "references/visible-herdr-runs.md"), "utf8"),
};
const reviewIt = docs["SKILL.md"];
const openai = readFileSync(join(skillDir, "agents/openai.yaml"), "utf8");

test("review-it stays manual-only across model runtimes", () => {
  assert.match(reviewIt, /^name: review-it$/mu);
  assert.match(reviewIt, /^description: "Manual-only /mu);
  assert.match(reviewIt, /^disable-model-invocation: true$/mu);
  assert.match(openai, /^  allow_implicit_invocation: false$/mu);
  assert.match(openai, /\$review-it\b/u);
});

test("every relative link and named script resolves", () => {
  for (const [name, text] of Object.entries(docs)) {
    const base = dirname(join(skillDir, name));
    for (const [, target] of text.matchAll(/\]\((?!https?:)([^)#]+)\)/gu)) {
      assert.ok(existsSync(join(base, target)), `${name} links to missing ${target}`);
    }
    for (const [, script] of text.matchAll(/scripts\/([a-z-]+\.mjs)/gu)) {
      // usage-state.mjs belongs to the sibling orchestrate skill.
      if (script === "usage-state.mjs") continue;
      assert.ok(existsSync(join(here, script)), `${name} names missing scripts/${script}`);
    }
  }
});

test("the receipt carries the fields that orchestrate's delivery verifies", () => {
  for (const field of ["## Review gate", "Gate:", "Risk:", "Regrade:", "Reviewed HEAD:", "Gate HEAD:"]) {
    assert.ok(reviewIt.includes(field), `receipt is missing ${field}`);
  }
});

test("staffing keeps GPT on Codex and Fable behind the user's ask", () => {
  const staffing = reviewIt.slice(reviewIt.indexOf("## 3. Staff"), reviewIt.indexOf("## 4. Review"));
  assert.match(staffing, /GPT runs only through Codex/u);
  assert.doesNotMatch(staffing, /\bSol\b|`gpt-(?!6-astra)/u, "the Cursor lane must not name a GPT model");
  assert.match(staffing, /Fable reviews only when the user asks/u);
  assert.match(staffing, /A skipped Codex pool takes Astra with it[\s\S]*never an older GPT/u);
});
