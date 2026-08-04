#!/usr/bin/env node
// Provisions one work unit's tab and agents, verified at every step, so a
// prose rewrite of the skill cannot shave off a check: tab created in the
// pinned workspace, lead started in the tab's own root pane, optional peer
// in a single split, and exactly one pane per agent at the end (a leftover
// shell pane means the lead was split in — it gets closed).
//
//   node create-unit.mjs --spec '<json>'
//   node create-unit.mjs --spec @<file>
//
// spec: {
//   workspace: "<workspace_id>",
//   cwd: "<worktree path>",
//   label: "#N <short title>",
//   lead: { name: "lead-N", args: ["--kind","claude","--","--model","opus", ...] },
//   peer: { name: "peer-N", args: [...] },       // pair units only
//   unit: "101",                                 // optional: unit key
//   report_pane: "<orchestrator pane id>"        // optional: milestone target
// }
//
// When `unit` is given, the unit's identity stops living in the tab label and
// becomes machine-readable on both sides: Herdr metadata tokens (unit, role,
// and report_pane) go on each agent pane, so discovery reads `pane list` instead of
// parsing `#N` out of a label; and HERDR_UNIT / HERDR_UNIT_WORKSPACE /
// HERDR_UNIT_REPORT_PANE are injected into the tab's environment, so a
// delegate reads its own context instead of depending on kickoff prose it
// must not lose.
//
// Exit 0: JSON {created: true, tab_id, lead_pane, peer_pane, tokens} on stdout.
// Exit 1: JSON {created: false, error, cleanup} — on failure after the tab
// exists, the tab is closed so no half-provisioned unit survives.
// Exit 2: usage error.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const emit = (obj, code) => {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(code);
};

const herdr = (...args) => {
  const r = spawnSync('herdr', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  try {
    return JSON.parse(r.stdout).result;
  } catch {
    return null;
  }
};

const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const BUSY_RETRY_MS = Number(process.env.CREATE_UNIT_BUSY_RETRY_MS ?? 500);
const BUSY_RETRY_ATTEMPTS = Number(process.env.CREATE_UNIT_BUSY_RETRY_ATTEMPTS ?? 20);

// Herdr rejects `agent start` with agent_pane_busy until a freshly created
// pane's shell reaches its prompt — an initialization race seen twice in
// production. Retry only that exact structured error, briefly and bounded;
// every other failure stays fatal on the first hit.
const startAgent = (...args) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return herdr('agent', 'start', ...args);
    } catch (error) {
      if (!/agent_pane_busy/u.test(error.message) || attempt >= BUSY_RETRY_ATTEMPTS) throw error;
      sleep(BUSY_RETRY_MS);
    }
  }
};

const arg = process.argv.indexOf('--spec');
if (arg === -1 || !process.argv[arg + 1]) emit({ created: false, error: 'usage: create-unit.mjs --spec <json|@file>' }, 2);
const raw = process.argv[arg + 1];
let spec;
try {
  spec = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw);
} catch (error) {
  emit({ created: false, error: `spec is not valid JSON: ${error.message}` }, 2);
}
for (const key of ['workspace', 'cwd', 'label']) {
  if (!spec?.[key]) emit({ created: false, error: `spec.${key} is required` }, 2);
}
if (!spec.lead?.name || !Array.isArray(spec.lead?.args)) {
  emit({ created: false, error: 'spec.lead needs {name, args[]}' }, 2);
}
if (spec.peer && (!spec.peer.name || !Array.isArray(spec.peer.args))) {
  emit({ created: false, error: 'spec.peer needs {name, args[]}' }, 2);
}
// A token is only useful if it can be matched back exactly, so keep unit keys
// to the shape agent names already use rather than the tab label's free text.
// Normalize once so every later guard reads the same value — `0` is a real key
// but a falsy one, and the two must not disagree.
const unitKey = spec.unit === undefined || spec.unit === null ? null : String(spec.unit);
if (unitKey !== null && !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/u.test(unitKey)) {
  emit({ created: false, error: `spec.unit ${JSON.stringify(spec.unit)} must match [A-Za-z0-9][A-Za-z0-9_.+-]{0,63}` }, 2);
}
const reportPane = spec.report_pane ?? null;
if (reportPane !== null && unitKey === null) {
  emit({ created: false, error: 'spec.report_pane requires spec.unit' }, 2);
}

const METADATA_SOURCE = 'herdr-orchestrate';
const unitEnv = [];
if (unitKey !== null) {
  unitEnv.push('--env', `HERDR_UNIT=${unitKey}`);
  unitEnv.push('--env', `HERDR_UNIT_WORKSPACE=${spec.workspace}`);
  if (reportPane) unitEnv.push('--env', `HERDR_UNIT_REPORT_PANE=${reportPane}`);
}

// Tag the pane itself so a later survey resolves the unit from live state.
const tagPane = (paneId, role) => {
  if (unitKey === null) return;
  const tokens = ['--token', `unit=${unitKey}`, '--token', `role=${role}`];
  if (reportPane) tokens.push('--token', `report_pane=${reportPane}`);
  herdr('pane', 'report-metadata', paneId, '--source', METADATA_SOURCE, ...tokens);
};

let tabId = null;
try {
  const created = herdr('tab', 'create', '--workspace', spec.workspace, '--cwd', spec.cwd, '--label', spec.label, ...unitEnv, '--no-focus');
  const root = created?.root_pane ?? created?.tab?.root_pane;
  tabId = created?.tab?.tab_id ?? root?.tab_id;
  if (!root?.pane_id || !tabId) throw new Error('tab create returned no root_pane/tab_id');
  if (root.workspace_id !== spec.workspace) {
    throw new Error(`root pane landed in workspace ${root.workspace_id}, not the pinned ${spec.workspace}`);
  }
  if (root.cwd && root.cwd !== spec.cwd) {
    throw new Error(`root pane cwd is ${root.cwd}, not the unit worktree ${spec.cwd}`);
  }

  startAgent(spec.lead.name, '--pane', root.pane_id, ...spec.lead.args);
  tagPane(root.pane_id, 'lead');

  let peerPane = null;
  if (spec.peer) {
    const split = herdr('pane', 'split', root.pane_id, '--direction', 'right', ...unitEnv, '--no-focus');
    peerPane = split?.pane?.pane_id ?? split?.pane_id;
    if (!peerPane) throw new Error('pane split returned no pane_id');
    startAgent(spec.peer.name, '--pane', peerPane, ...spec.peer.args);
    tagPane(peerPane, 'peer');
  }

  // Exactly one pane per agent; close any agentless leftover.
  const expected = new Set([root.pane_id, ...(peerPane ? [peerPane] : [])]);
  const panes = (herdr('pane', 'list', '--workspace', spec.workspace)?.panes ?? [])
    .filter((p) => p.tab_id === tabId);
  for (const pane of panes) {
    if (expected.has(pane.pane_id)) continue;
    if (pane.agent) throw new Error(`unexpected agent pane ${pane.pane_id} in the unit tab`);
    herdr('pane', 'close', pane.pane_id);
  }
  const finalPanes = (herdr('pane', 'list', '--workspace', spec.workspace)?.panes ?? [])
    .filter((p) => p.tab_id === tabId);
  if (finalPanes.length !== expected.size || finalPanes.some((p) => !expected.has(p.pane_id) || !p.agent)) {
    throw new Error('unit tab does not hold exactly one live pane per agent');
  }

  // An untagged pane is invisible to a token-based survey, which is worse than
  // an obvious failure here, so prove the tags are readable before reporting.
  const tokens = {};
  if (unitKey !== null) {
    for (const pane of finalPanes) {
      const seen = pane.tokens ?? {};
      const role = pane.pane_id === root.pane_id ? 'lead' : 'peer';
      // A lost report_pane is as bad as a lost unit: the delegate's milestones
      // reach nobody, and the run finds out only when it goes quiet.
      if (seen.unit !== unitKey || seen.role !== role || (reportPane && seen.report_pane !== reportPane)) {
        throw new Error(`pane ${pane.pane_id} did not keep its unit/role/report_pane tokens (read ${JSON.stringify(seen)})`);
      }
      tokens[pane.pane_id] = seen;
    }
  }

  emit({ created: true, tab_id: tabId, lead_pane: root.pane_id, peer_pane: peerPane, tokens }, 0);
} catch (error) {
  let cleanup = 'nothing to clean up';
  if (tabId) {
    try {
      herdr('tab', 'close', tabId);
      cleanup = `closed tab ${tabId}`;
    } catch (closeError) {
      cleanup = `FAILED to close tab ${tabId}: ${closeError.message}`;
    }
  }
  emit({ created: false, error: error.message, cleanup }, 1);
}
