import assert from "node:assert/strict";
import { mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { supervise } from "./headless-run.mjs";

// The wrapper suites prove a hang eventually reports `killed`. That is not the
// protection. The protection is HOW it is killed: the child alone, never its
// process group, and only after SIGTERM has been given 2000 ms and the process
// has been proved still alive. Those invariants moved into this module during
// the extraction, and a drift in any of them fails silently on a real hang —
// so they are asserted here, against a real child, rather than described.
const root = mkdtempSync(join(tmpdir(), "headless-run-test-"));

// A child that refuses SIGTERM and leaves a grandchild in its own process
// group. A group kill would take the grandchild with it; a PID-scoped kill
// orphans it alive. That surviving process is the evidence.
writeFileSync(
  join(root, "stubborn.mjs"),
  `import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
const [, , grandchildFile, marks] = process.argv;
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(grandchildFile, String(grandchild.pid));
process.on("SIGTERM", () => appendFileSync(marks, String(Date.now()) + "\\n"));
process.stdout.write("alive\\n");
setInterval(() => {}, 1000);
`,
);

// A child that takes SIGTERM and goes. SIGKILL must not be sent to a pid that
// is already gone, and the escalation must still finish cleanly.
writeFileSync(
  join(root, "obedient.mjs"),
  `process.on("SIGTERM", () => process.exit(0));
process.stdout.write("alive\\n");
setInterval(() => {}, 1000);
`,
);

const hangOf = (childScript, args, idleMs = 1000) =>
  new Promise((resolve, reject) => {
    supervise({
      bin: process.execPath,
      args: [join(root, childScript), ...args],
      cwd: root,
      logFd: openSync(join(root, `${childScript}.log`), "w"),
      idleMs,
      totalMs: 600000,
      onExit: (exit) => reject(new Error(`expected a hang, got exit ${exit}`)),
      onHang: (why) => resolve({ why, at: Date.now() }),
    });
  });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("supervise kills the hung child alone, on the staged ladder", async () => {
  const grandchildFile = join(root, "grandchild.pid");
  const marks = join(root, "sigterm.marks");
  const outcome = await hangOf("stubborn.mjs", [grandchildFile, marks]);

  assert.match(outcome.why, /no output for/u, "an idle deadline, not a total budget");

  const grandchild = Number(readFileSync(grandchildFile, "utf8").trim());
  assert.ok(Number.isInteger(grandchild) && grandchild > 0, "the child must report its grandchild");
  assert.equal(
    alive(grandchild),
    true,
    "the grandchild shared the child's process group and must have survived — a dead one means the kill went to the group",
  );
  process.kill(grandchild, "SIGKILL");

  // Same run, so the ladder's timing is measured against the kill just proved
  // to be PID-scoped: SIGTERM, 2000 ms of grace, SIGKILL, 500 ms, then report.
  const sigterm = Number(readFileSync(marks, "utf8").trim().split("\n")[0]);
  assert.ok(Number.isInteger(sigterm), "the child must have received SIGTERM at all");
  const grace = outcome.at - sigterm;
  assert.ok(
    grace >= 2200 && grace <= 6000,
    `SIGTERM must get its full grace before the outcome is reported; measured ${grace} ms`,
  );
});

test("supervise does not signal a child that already died on SIGTERM", async () => {
  const outcome = await hangOf("obedient.mjs", []);
  assert.match(outcome.why, /no output for/u);
  // Reaching here at all is the assertion: the existence probe found a reaped
  // pid, swallowed the error, and the escalation still reported its outcome
  // instead of throwing out of the timer.
  assert.ok(outcome.at > 0);
});
