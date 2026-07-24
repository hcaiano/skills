# 1.0.0-frontend override anatomy

The frontend OpenAPI override lives in
`apps/cms/src/overrides/1.0.0-frontend/` and **replaces** Strapi's verbose,
documentation-plugin auto-generated paths/schemas with a hand-curated minimal
subset. Three files coordinate.

## Data flow

```text
Strapi documentation plugin
  → http://localhost:1337/documentation/1.0.0/full_documentation.json
  → openapi-typescript                 (packages/cms-client typegen script)
  → packages/cms-client/src/cms.types.ts
  → scripts/rename-empty-variables.mjs (index-signature → Record<>)
  → biome format
```

`excludes.js` removes auto-gen output; `index.js` + `schemas.js` inject the
curated replacement that openapi-typescript actually consumes.

## excludes.js

A flat array of **singular** content-type slugs. Every content type the CMS
knows about is listed here so its verbose Strapi auto-gen is suppressed — the
override then re-adds only the curated paths. Adding a new type means appending
its singular slug (e.g. collection `/categories` → `"category"`; `/award-jurors`
→ `"award-juror"`). Keep the array alphabetically sorted (it already is).

## schemas.js

Defines `components.schemas`. Top of the file holds **reusable helpers** —
reuse them instead of re-inlining:

| Helper                     | Shape                                                        |
| -------------------------- | ----------------------------------------------------------- |
| `baseImageProperties`      | id/name/alternativeText/width/height/url/placeholder        |
| `imageSchema`              | `baseImageProperties`                                       |
| `extendedImageSchema`      | + `formats.{small,medium}`                                  |
| `fullImageSchema`          | + `formats.{thumbnail,xsmall,small,medium,large,xlarge}`   |
| `authorSchema`             | name/role/username/avatar(fullImageSchema)                  |
| `tagSchema`                | name/slug                                                   |
| `categorySchema`           | name                                                        |
| `metaSchema`               | `pagination.{page,pageSize,pageCount,total}`               |

Conventions:

- Entity schema named after the content type (PascalCase singular): `Category`,
  `Tag`, `Game`.
- **List** endpoints get a `<Entity>ListResponse`:
  ```javascript
  XListResponse: {
    type: "object",
    properties: {
      data: { type: "array", items: { $ref: "#/components/schemas/X" } },
      meta: metaSchema,
    },
  },
  ```
  > The current live override **includes `meta`** in frontend list responses,
  > even though the older `strapi-openapi-typegen.mdx` guide says frontend
  > omits meta. Follow the live code.
- **Single type** (a "page" — `/home-page`, `/airdrop-page`) gets a
  `<Entity>Response` wrapping `data` directly (no array, no meta).
- **Single `{id}`** routes (`/games/{id}`) usually inline the `data`/`meta`
  wrap in `index.js` rather than a named response schema.

Keep entities to the scanned fields only. Relations/media reuse the helpers
(`image: imageSchema`, `author: authorSchema`,
`tags: { type: "array", items: tagSchema }`).

## index.js

Defines `paths`. Each entry:

```javascript
"/<path>": {
  get: {
    tags: ["<Pascal>"],
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/<Entity>ListResponse" },
          },
        },
      },
      ...errorSchema,        // imported from ../errorSchema
    },
    operationId: "get/<path>",
    parameters,              // imported from ../parameters
  },
},
```

- `operationId` is always `get/<path>` (e.g. `get/categories`,
  `get/games/{id}`).
- Single `{id}` route: prepend an `id` path param to `...parameters` and inline
  the response (`data: { $ref: ".../<Entity>" }, meta: { type: "object",
  additionalProperties: true }`). Copy the `/games/{id}` or `/guides/{id}`
  block as a template.
- Single type (page): use the plain `<Entity>Response` `$ref`, like `/home-page`.

## Choosing list vs single

| Frontend usage                                  | Shape                                  |
| ----------------------------------------------- | -------------------------------------- |
| `client.GET("/categories")` returns array       | `*ListResponse` (data array + meta)    |
| `client.GET("/airdrop-page")` single type/page  | `*Response` (data object)              |
| `client.GET("/games/{id}")` one entity by id    | inline `data` wrap in `index.js`       |
