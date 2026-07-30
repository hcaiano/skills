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
//   peer: { name: "peer-N", args: [...] }        // pair units only
// }
//
// Exit 0: JSON {created: true, tab_id, lead_pane, peer_pane} on stdout.
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

let tabId = null;
try {
  const created = herdr('tab', 'create', '--workspace', spec.workspace, '--cwd', spec.cwd, '--label', spec.label, '--no-focus');
  const root = created?.root_pane ?? created?.tab?.root_pane;
  tabId = created?.tab?.tab_id ?? root?.tab_id;
  if (!root?.pane_id || !tabId) throw new Error('tab create returned no root_pane/tab_id');
  if (root.workspace_id !== spec.workspace) {
    throw new Error(`root pane landed in workspace ${root.workspace_id}, not the pinned ${spec.workspace}`);
  }
  if (root.cwd && root.cwd !== spec.cwd) {
    throw new Error(`root pane cwd is ${root.cwd}, not the unit worktree ${spec.cwd}`);
  }

  herdr('agent', 'start', spec.lead.name, '--pane', root.pane_id, ...spec.lead.args);

  let peerPane = null;
  if (spec.peer) {
    const split = herdr('pane', 'split', root.pane_id, '--direction', 'right', '--no-focus');
    peerPane = split?.pane?.pane_id ?? split?.pane_id;
    if (!peerPane) throw new Error('pane split returned no pane_id');
    herdr('agent', 'start', spec.peer.name, '--pane', peerPane, ...spec.peer.args);
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

  emit({ created: true, tab_id: tabId, lead_pane: root.pane_id, peer_pane: peerPane }, 0);
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
