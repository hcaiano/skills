import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptedAgentBasenames,
  matchingForegroundProcess,
} from "./agent-process.mjs";

test("Cursor foreground proof accepts cursor and cursor-agent executables", () => {
  assert.deepEqual(acceptedAgentBasenames("cursor"), ["cursor", "cursor-agent"]);
  for (const executable of ["cursor", "cursor-agent"]) {
    const processInfo = {
      foreground_processes: [
        {
          argv: [`/usr/local/bin/${executable}`, "--model", "composer"],
          argv0: `/usr/local/bin/${executable}`,
          cwd: "/workspace",
          name: executable,
        },
      ],
    };
    assert.equal(
      matchingForegroundProcess(processInfo, "cursor", "/workspace"),
      processInfo.foreground_processes[0],
    );
    assert.equal(matchingForegroundProcess(processInfo, "cursor", "/other"), undefined);
  }
});

test("other agent kinds keep their literal executable basename", () => {
  assert.deepEqual(acceptedAgentBasenames("codex"), ["codex"]);
  assert.deepEqual(acceptedAgentBasenames("opencode"), ["opencode"]);
  assert.equal(
    matchingForegroundProcess(
      { foreground_processes: [{ argv: ["/usr/bin/codex"], cwd: "/workspace" }] },
      "codex",
      "/workspace",
    )?.argv[0],
    "/usr/bin/codex",
  );
  assert.equal(
    matchingForegroundProcess(
      { foreground_processes: [{ argv: ["/usr/local/bin/opencode"], cwd: "/workspace", name: "opencode" }] },
      "opencode",
      "/workspace",
    )?.name,
    "opencode",
  );
});
