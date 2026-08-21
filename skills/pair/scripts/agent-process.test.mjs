import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptedAgentBasenames,
  matchingForegroundProcess,
} from "./agent-process.mjs";

test("Cursor foreground proof accepts the cursor-agent executable", () => {
  const processInfo = {
    foreground_processes: [
      {
        argv: ["/usr/local/bin/cursor-agent", "--model", "composer"],
        argv0: "/usr/local/bin/cursor-agent",
        cwd: "/workspace",
        name: "cursor-agent",
      },
    ],
  };

  assert.deepEqual(acceptedAgentBasenames("cursor"), ["cursor", "cursor-agent"]);
  assert.equal(
    matchingForegroundProcess(processInfo, "cursor", "/workspace"),
    processInfo.foreground_processes[0],
  );
  assert.equal(matchingForegroundProcess(processInfo, "cursor", "/other"), undefined);
});

test("other agent kinds keep their literal executable basename", () => {
  assert.deepEqual(acceptedAgentBasenames("codex"), ["codex"]);
  assert.equal(
    matchingForegroundProcess(
      { foreground_processes: [{ argv: ["/usr/bin/codex"], cwd: "/workspace" }] },
      "codex",
      "/workspace",
    )?.argv[0],
    "/usr/bin/codex",
  );
});
