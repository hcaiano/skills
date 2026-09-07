// Shared child supervision: measure liveness from output and terminate only the child PID.
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

// Wrappers interpret onExit/onHang; the supervisor owns deadlines and termination.
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
