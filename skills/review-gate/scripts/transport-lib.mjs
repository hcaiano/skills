// What both transport backends need identically. They parse the same argv and
// write the same completion receipt, and that sameness is load-bearing: it is
// what lets the gate's later steps stop caring which transport ran.
//
// It used to be maintained by copy-paste, and it had already drifted — the
// receipt shape was two hand-written object literals in two files, so a field
// the contract required could go missing from both without any test noticing.
// One writer makes the claim structural instead of aspirational.
//
// `fail` is injected rather than shared because the two callers genuinely
// differ: herdr-visible-run.mjs closes its pane and removes its command file
// first, run-transport.mjs has neither to clean up.
import { readFileSync } from 'node:fs';

export const sleepSync = (milliseconds) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

// Both readers consume from `argv` in place, so the caller's remaining-argument
// check still sees exactly what was not taken.
export const argReader = (argv, fail) => ({
  take: (name, required = true) => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) {
      if (required) fail(`missing --${name}`, 2);
      return null;
    }
    const value = argv[index + 1];
    if (!value || value === "--") fail(`missing value for --${name}`, 2);
    argv.splice(index, 2);
    return value;
  },
  commandAfterSeparator: () => {
    const separator = argv.indexOf("--");
    if (separator === -1 || separator === argv.length - 1) {
      fail("missing command after --", 2);
    }
    const command = argv.slice(separator + 1);
    argv.splice(separator);
    if (argv.length) fail(`unexpected arguments: ${argv.join(" ")}`, 2);
    return command;
  },
});

// An argv that is not a non-empty array of strings is a corrupted launch, not a
// command to run — both supervisors refuse it before spawning anything.
export const readCommandFile = (path, fail) => {
  let command;
  try {
    command = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`cannot read command file: ${path}`);
  }
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === "string")
  ) {
    fail(`command file contains invalid argv: ${path}`);
  }
  return command;
};

// The one completion-receipt shape. `transport` names which backend wrote it,
// so a caller validating a receipt can prove the run it is reading is the run
// it launched.
export const completionRecord = ({ transport, paneId, token, command, code, signal, startedAt, transcript }) => ({
  ok: code === 0,
  transport,
  pane_id: paneId,
  token,
  command,
  exit_code: code,
  signal,
  seconds: Math.round((Date.now() - startedAt) / 1000),
  transcript,
});
