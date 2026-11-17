# Adding a bank

The import pipeline is a fixed DAG. Bank-specific work lives in adapters, not in `pipeline-service.ts`.

## What you add

1. Create an adapter in `src/server/adapters/` (or `singapore/`) that implements `Adapter`:
   - `name` — stable id, e.g. `uob-card`
   - `supportedMimeTypes`
   - `canParse(content, filename, mimeType)` — score `0` if this is not your product. Use **header text**, not footers or filenames.
   - `parse(content)` — observations plus an optional `statementPeriod`
2. Register it in `AdapterRegistry.registerDefaults()` in `src/server/adapters/registry.ts`.
3. Add a synthetic `pdftotext -layout` fixture (leading spaces, no real customer data) and unit tests.

## What you do not edit

- Pipeline stage list or runner
- `/pipeline` graph layout code

`detect-format` fans out over `registry.getAll()`. A new adapter appears as a branch node on `/pipeline` automatically.

## Alerts vs statements

Alerts and statements are separate adapters (`uob-alert` and `uob-card`). Matching stays in the shared `match` stage.

## Checks

```bash
npm run typecheck
npx vitest run
```
