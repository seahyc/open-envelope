# Small-context categoriser

Default provider is `none` / `memory-only` (`CATEGORISER_PROVIDER`). Users' real L1–L4 hierarchy is a private file at `CATEGORIES_PATH`; the repo ships a synthetic default at `config/categories.default.json`. The app starts if that file is missing.

Optional merchant-memory seed (outside the repo): `MERCHANT_MEMORY_CSV` with columns `merchant_key,category_id,count,flag_ask`. Import and `/pipeline` apply high-agreement exact/short-key rows when `CATEGORISER_PROVIDER=none`.

## Defaults (env-overridable)

| variable | default |
| --- | --- |
| `CATEGORISER_PROVIDER` | `none` |
| `CATEGORISER_AUTO_THRESHOLD` | `0.9` |
| `CODEX_MODEL` | `gpt-6-luna` |
| `CODEX_REASONING_EFFORT` | `low` |
| `CODEX_BIN` | `codex` (image: `/usr/local/bin/codex`) |
| `CODEX_HOME` | unset (image: `/tmp/codex-home`) |
| `CODEX_EXTRA_CONFIG` | empty |
| `CATEGORISER_ALWAYS_REVIEW` | empty |

Codex CLI (`executeCodex`) passes `--skip-git-repo-check` and a strict JSON schema (`additionalProperties: false`, all properties required). Parse/exec failures retry once; a second failure sends the line to review with no suggestion. Logs use an error code plus line id only.

`CODEX_EXTRA_CONFIG` is an optional comma/newline-separated list of `-c` overrides (or a JSON string array). Use it to disable MCP servers from a copied host `config.toml`, for example `CODEX_EXTRA_CONFIG=mcp_servers={}`.

`CATEGORISER_ALWAYS_REVIEW` is an optional comma/newline-separated list of merchant/description regexes. Matches force review while keeping the model (or memory) suggestion. Nothing is enabled by default.

## Codex in the production container

The image pins `@openai/codex@0.164.0` and runs as user `node`. Health/startup does not require Codex auth or `CATEGORISER_PROVIDER=codex`.

To categorise with Codex in Docker:

1. On the host, `codex login` so `~/.codex/auth.json` exists.
2. Uncomment the auth mount in `docker-compose.yml`:
   ```yaml
   - ${HOME}/.codex/auth.json:/codex-auth/auth.json:ro
   ```
3. Set `CATEGORISER_PROVIDER=codex`.
4. Sessions write under `CODEX_HOME=/tmp/codex-home` on tmpfs (not persisted). The entrypoint copies `auth.json` (and `config.toml` if present) into that directory. Do not mount the host `~/.codex` read-write.

If you copy `config.toml` and it enables MCP servers, set `CODEX_EXTRA_CONFIG=mcp_servers={}`.

## CSV formats

Train and test (`scripts/eval-categoriser.ts --train` / `--test`):

| column | meaning |
| --- | --- |
| `id` | Row id |
| `merchant` | Raw merchant text |
| `account` | Account id or alias |
| `amount_cents` | Signed integer |
| `memo` | Optional memo tokens |
| `category_id` | Leaf id from the categories JSON |

Merchant memory (`--memory`):

| column | meaning |
| --- | --- |
| `merchant_key` | Normalised key (`GRAB`, `IRAS`) |
| `category_id` | Leaf id or `flag` |
| `count` | Label count |
| `flag_ask` | `1` always reviews |

Categories JSON: `{ "categories": [{ "id", "path": ["L1","L2",...], "description", "kind" }] }` with `kind` one of `expense|income|transfer|refund|fee|interest`.

## Commands

```bash
npx tsx scripts/distill-category-rules.ts --memory fixtures/categoriser/merchants.csv
npx tsx scripts/eval-categoriser.ts \
  --train fixtures/categoriser/train.csv \
  --test fixtures/categoriser/test.csv \
  --categories config/categories.default.json \
  --provider memory-only \
  --out /tmp/categoriser-results.json
```

Providers: `memory-only` (offline), `codex` (CLI JSON-schema enum), `jev` (`@typesafe-ai/sdk` `choice()` + `TYPESAFE_API_KEY`).

Hardened compose smoke (app boot + synthetic CSV import):

```bash
bash scripts/docker-compose-smoke.sh
```
