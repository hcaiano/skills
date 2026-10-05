---
name: t3-delegate
description: "Delegate bounded T3 Code tasks by model fit and account capacity, including rerouting after usage limits."
---

1. Set the task's quality bar using the [model policy](../pair/references/models.md).
   Preserve explicit user choices. Use `orchestrator_capabilities` for
   provider/model IDs and supported options.
2. With `SKILL_DIR` set to this directory and `pair` installed beside it,
   compare the configured accounts on the T3 server:

   ```bash
   node "$SKILL_DIR/scripts/t3-capacity.mjs" \
     --settings <server-settings.json> \
     --instance <id>:<driver> [--instance ...]
   ```

   Supply confirmed server settings, or omit `--settings` and retain unknown
   mappings. Follow the helper's mapping notes; `--declare` requires a
   user-stated mapping.

3. Choose a capable model, verified account, and supported effort under the
   policy's pool rules. Unknown capacity proves no headroom. Explain the
   choice in one sentence; report a blocker when no permitted route remains.
4. Delegate the bounded brief with its scope, acceptance proof, and stop
   point using the chosen provider, model, and effort. Follow T3's injected
   routing and lifecycle instructions.

Done when the task is accepted and its task ID is recorded, or the blocker
is reported.
