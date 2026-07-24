---
name: cms-typegen-collection
description: >
  Add a Strapi CMS collection type or single type to the frontend OpenAPI
  override (apps/cms/src/overrides/1.0.0-frontend/) with a MINIMAL field set,
  then regenerate packages/cms-client/src/cms.types.ts. Scans apps/frontend for
  the real client.GET("/<path>") usage to type only the fields the app reads,
  edits excludes.js + schemas.js + index.js consistently (reusing the existing
  image/author/tag/category/meta helpers), ensures Strapi is running at
  localhost:1337 before regenerating, and strips the now-unused
  `@ts-expect-error - untyped endpoint` directive. Use when asked to "add a
  collection to cms.types.ts", "type a CMS endpoint", "add <X> to the
  1.0.0-frontend override", "regenerate cms-client types", or to remove an
  `untyped endpoint` ts-expect-error in apps/frontend.
user-invocable: true
argument-hint: "<collection-or-single-type name or CMS path, e.g. /categories>"
---

# CMS Typegen: add a collection/single type to the frontend override

Automates the fiddly, 3-file process of adding a Strapi content type to the
curated **frontend** OpenAPI override and regenerating the typed CMS client.
The whole point is to keep `packages/cms-client/src/cms.types.ts` **lean** —
type only the fields the frontend actually reads, never the full Strapi entity.

## When to use

- Asked to add a collection type or single type to `cms.types.ts` or the
  `apps/cms/src/overrides/1.0.0-frontend/` override.
- A `client.GET("/<path>")` call in `apps/frontend` carries
  `/* @ts-expect-error - untyped endpoint */` and you want it typed.
- Backfilling fields onto an already-typed entity (e.g. a new `populate`
  field the app started reading). PR #3244 is the worked manual example.

Candidate untyped collections today: `/platforms`, `/statuses`, `/projects`,
`/airdrop-page`, `/award-categories`, `/award-jurors`, `/game-creators`,
`/announcement-types`, `/custom-announcements`, `/awards-page`.

> **Do NOT hand-edit the override or `cms.types.ts` outside this skill.** The
> override is intentionally minimal; ad-hoc edits over-bloat it and the regen
> drifts. AGENTS.md enforces this.

## Inputs

- A collection/single-type **name** or **CMS path** (e.g. `categories`,
  `/categories`, `award-categories`). Plural path = REST endpoint; the
  singular slug is what goes in `excludes.js`.

## The 3 override files (anatomy)

See `references/override-anatomy.md` for the full reference. In short:

| File          | Role                                                                 |
| ------------- | ------------------------------------------------------------------- |
| `excludes.js` | Suppress Strapi's verbose auto-gen for the content type (singular).  |
| `schemas.js`  | Minimal entity schema + `*ListResponse` / response schema.          |
| `index.js`    | Wire `path → operationId (get/<path>) → response $ref`.             |

Reusable `schemas.js` helpers — **compose from these, do not re-inline**:
`baseImageProperties`, `imageSchema`, `extendedImageSchema`, `fullImageSchema`,
`authorSchema`, `tagSchema`, `categorySchema`, `metaSchema`. List responses in
this override include `meta: metaSchema` (follow the live code, not the older
typegen guide which omits meta for frontend).

## Step 1 — Determine the MINIMAL field set by scanning the frontend

Grep `apps/frontend/src` for the endpoint and read each callsite:

```bash
rg -n 'client\.GET\("/<path>"' apps/frontend/src
```

From each usage extract **only** what the app needs:

1. **`fields: [...]`** in the query options → these scalar fields.
2. **`populate: {...}`** → relations/media to include (type these too, reusing
   helpers — e.g. a populated image → `imageSchema`/`fullImageSchema`).
3. **Downstream property access** on the response — `response.data?.data?.<f>`,
   destructures, `.map(x => x.<f>)`, and any `as SomeType` cast target. Type
   exactly those.

Keep it tight. Example — `apps/frontend/src/hooks/categories/useListCategories.ts`
passes `fields: ["name"]` and returns `Category[]`, so the `Category` entity is
just `{ name }` (plus `documentId`/`id` if read). `useListTags.ts` passes
`fields: ["name", "slug", "articlesCount"]` → `Tag` is those three.

**If there is no `client.GET` usage yet**, STOP and ask the caller for the
intended field list. Do **not** guess wide or dump the Strapi entity.

## Step 2 — Edit the 3 override files

All under `apps/cms/src/overrides/1.0.0-frontend/`.

1. **`excludes.js`** — add the **singular** content-type slug (e.g.
   `"category"`, `"award-category"`), keeping the array sorted as it is.

2. **`schemas.js`** — add the minimal entity schema and its response wrapper,
   reusing helpers:

   ```javascript
   // List collection (e.g. /categories)
   Category: {
     type: "object",
     properties: {
       name: { type: "string" },
       // add only scanned fields; relations/media reuse helpers:
       // image: imageSchema, author: authorSchema, tags: { type: "array", items: tagSchema },
     },
   },
   CategoryListResponse: {
     type: "object",
     properties: {
       data: { type: "array", items: { $ref: "#/components/schemas/Category" } },
       meta: metaSchema,
     },
   },
   ```

   For a **single type** (e.g. `/airdrop-page`) use a `*Response` wrapping
   `data` directly (no array, no meta):

   ```javascript
   AirdropPageResponse: {
     type: "object",
     properties: { data: { $ref: "#/components/schemas/AirdropPage" } },
   },
   ```

3. **`index.js`** — wire the path. **List** endpoint:

   ```javascript
   "/categories": {
     get: {
       tags: ["Category"],
       responses: {
         200: {
           description: "OK",
           content: {
             "application/json": {
               schema: { $ref: "#/components/schemas/CategoryListResponse" },
             },
           },
         },
         ...errorSchema,
       },
       operationId: "get/categories",
       parameters,
     },
   },
   ```

   **Single `{id}`** endpoint inlines the `data`/`meta` wrap (see the `/games/{id}`
   and `/guides/{id}` entries for the exact shape) with an `id` path param
   prepended to `...parameters` and `operationId: "get/<path>/{id}"`. A
   **single type** (page) uses the plain `*Response` `$ref`, like `/home-page`.

## Step 3 — Ensure the CMS is running at localhost:1337 (BLOCKING)

The typegen script targets
`http://localhost:1337/documentation/1.0.0/full_documentation.json` — that host
is required.

1. **Probe** it first — read the **HTTP status code**, not curl's exit code
   (`curl -sf ... -o /dev/null` returns 23 on Windows even on a 200, a false
   "down"; see 3.3):

   ```bash
   curl -s http://localhost:1337/documentation/1.0.0/full_documentation.json \
     -o /dev/null -w "%{http_code}\n"   # treat 200 as up
   ```

2. If down, **best-effort** start Strapi:

   ```bash
   bun run --cwd apps/cms dev   # = strapi develop
   ```

   then re-probe until the endpoint responds.

3. **If you cannot start it** (Strapi needs dotenvx secrets + a DB that the
   agent usually lacks): **prompt the user to start the CMS manually and BLOCK.**
   Wait for the user to confirm it's running and/or re-probe until the endpoint
   responds. **Do NOT run `bun typegen` until the endpoint is confirmed
   reachable**, whether auto-started or user-confirmed.

   **If the user says the server is (re)starting or already running, WAIT and
   let it stabilize on its own — do NOT start a second instance.** Strapi
   `develop` regenerates `full_documentation.json` from the override only on a
   **full boot** (the documentation plugin's `bootstrap` calls
   `generateFullDoc()`); a partial hot-reload can reuse a require-cached copy of
   the app's `src/index.js` and emit docs that include the new `schemas.js`
   entity but miss the new `index.js` path (or vice-versa). So after editing the
   override:
   - Probe with plain `curl` and read the **HTTP status code**, not curl's exit
     code — `curl -sf ... -o /dev/null` returns 23 (write error) on Windows even
     on a 200, a false "down". Use
     `curl -s URL -o /dev/null -w "%{http_code}\n"` and treat `200` as up.
   - Before `bun typegen`, confirm the live docs actually contain BOTH the new
     path and schema (not just one):
     ```bash
     curl -s http://localhost:1337/documentation/1.0.0/full_documentation.json \
       | python -c "import sys,json; d=json.load(sys.stdin); print('/<path>' in d['paths'], '<Schema>' in d['components']['schemas'])"
     ```
   - If the path is missing but the schema landed (the tell-tale of a stale
     require cache), ask the user for a **full restart** (stop + start, not a
     hot-reload) and re-check — do not regenerate against the partial docs.

## Step 4 — Regenerate (only after Step 3 confirms the endpoint)

From the monorepo root:

```bash
bun run typegen
```

(→ `turbo run typegen --filter=@gam3s/cms-client` → openapi-typescript fetch +
`scripts/rename-empty-variables.mjs` + biome format.)

Then verify:

```bash
bun run --cwd packages/cms-client check-types   # must be clean
rg -n '"/categories"' packages/cms-client/src/cms.types.ts   # new path present
```

Confirm the new `paths["/<path>"]` and its schema appear in `cms.types.ts`.

## Step 5 — Clean up the now-typed endpoint

For each `client.GET("/<path>")` callsite that now resolves to a typed path,
remove the `/* @ts-expect-error - untyped endpoint */` directive and any
no-longer-needed `as SomeType` cast on the response.

```bash
rg -n 'ts-expect-error - untyped endpoint' apps/frontend/src
```

**Verify the directive is genuinely unused before removing it** — run a
type-check and make sure `@gam3s/cms-client` actually resolves (a missing
resolution makes *everything* look untyped, a false signal):

```bash
bun run --cwd apps/frontend check-types
```

If `tsc` reports `Unused '@ts-expect-error' directive`, delete that line. Then
re-run `check-types` for both `packages/cms-client` and `apps/frontend` — both
must be clean.

## Done criteria

- `excludes.js` + `schemas.js` + `index.js` have minimal, helper-reusing edits.
- `cms.types.ts` regenerated; new path + types present.
- `@ts-expect-error - untyped endpoint` removed at the now-typed callsite(s).
- `packages/cms-client` and `apps/frontend` type-check clean.

## References

- `references/override-anatomy.md` — the 3-file system in detail.
- `apps/docs/content/docs/cms/engineering/strapi-openapi-typegen.mdx` — typegen guide.
- `apps/docs/content/docs/cms/engineering/cms-client-unification.mdx` §10 — schema-gap backfill table.
- PR #3244 — worked manual example (Guide/media `formats`/banner `countdownDate` backfill).
