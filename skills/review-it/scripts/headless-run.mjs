// The mechanic both headless wrappers need, in one place: argument reading, the
// receipt writer, a cwd-scoped git, and the supervisor that measures liveness on
// the child's own bytes and kills the PID itself when it stops producing them.
//
// This module exists because the protections are the reason the wrappers exist.
// When they lived in two files, the EPIPE latch, the poll cadence, and the
// SIGTERM -> SIGKILL ladder had to be edited in lockstep, and nothing failed if
// only one copy was edited. A third vendor would have been a third copy.
//
// What stays in each wrapper is what the vendor CLI genuinely forces: its argv,
// its success predicate, and anything it must do to the tree before or after.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, writeSync } from 'node:fs';

export const POLL_MS = 2000;

export const optionReader = (argv) => ({
  opt: (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
  },
  flag: (name) => argv.includes(`--${name}`),
});

export const receiptEmitter = (receiptPath) => (obj, code) => {
  const output = JSON.stringify(obj, null, 2) + '\n';
  if (receiptPath) writeFileSync(receiptPath, output);
  process.stdout.write(output);
  process.exit(code);
};

export const gitRunner = (cwd) => (...args) =>
  spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

// Spawns the child and owns every deadline. Liveness is measured here, on the
// bytes themselves: the parent sees every chunk, so there is nothing left for a
// filesystem size poll to learn. `onExit` receives a completed run's exit code;
// `onHang` receives the reason a killed one was killed. A wrapper decides what
// those outcomes mean, never how they are detected.
export const supervise = ({ bin, args, cwd, logFd, idleMs, totalMs, onExit, onHang }) => {
  const started = Date.now();
  const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let lastGrowth = Date.now();
  let visibleOutputOpen = true;
  process.stderr.on('error', (error) => {
    if (error.code === 'EPIPE') {
      visibleOutputOpen = false;
      return;
    }
    throw error;
  });
  const mirror = (chunk) => {
    writeSync(logFd, chunk);
    if (visibleOutputOpen) process.stderr.write(chunk);
    lastGrowth = Date.now();
  };
  child.stdout.on('data', mirror);
  child.stderr.on('data', mirror);

  let exit = null;
  child.on('close', (code) => { exit = code ?? -1; });
  child.on('error', () => { exit = -1; });

  const timer = setInterval(() => {
    if (exit !== null) {
      clearInterval(timer);
      return onExit(exit);
    }

    const now = Date.now();
    if (now - lastGrowth > idleMs || now - started > totalMs) {
      clearInterval(timer);
      const why = now - started > totalMs ? `total budget ${Math.round(totalMs / 60000)}m exceeded` : `no output for ${Math.round(idleMs / 60000)}m`;
      child.kill('SIGTERM'); // the PID itself, never the group
      setTimeout(() => {
        try { process.kill(child.pid, 0); child.kill('SIGKILL'); } catch { /* already gone */ }
        setTimeout(() => onHang(why), 500);
      }, 2000);
    }
  }, POLL_MS);

  return { startedAt: started };
};
