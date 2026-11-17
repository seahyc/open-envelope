# LLM Provider Integration

OpenEnvelope can use large language models for intelligent categorization and parsing.

## Overview

**Use cases:**
1. **Merchant categorization**: Categorize transactions when rules don't match
2. **Unknown format parsing**: Parse bank statements with no adapter

**Providers:**
- `none` (default): No LLM features
- `codex`: OpenAI Codex CLI (uses host's ChatGPT subscription)
- `openai`: OpenAI API (coming soon)

## Quick Start

### Enable Codex

1. **Install Codex CLI** on host machine:
   ```bash
   # Follow Codex installation docs
   npm install -g codex-cli
   ```

2. **Login** with ChatGPT account:
   ```bash
   codex login
   ```

3. **Configure OpenEnvelope**:
   ```bash
   # .env
   LLM_PROVIDER=codex
   CODEX_BIN=/usr/local/bin/codex
   CODEX_HOME=/home/node/.codex
   LLM_CACHE_ENABLED=true
   LLM_TIMEOUT=30000
   LLM_RATE_LIMIT=10
   ```

4. **Mount Codex auth** in Docker Compose (read-only). The image already includes `@openai/codex@0.164.0`. Sessions go to tmpfs (`CODEX_HOME=/tmp/codex-home`):
   ```yaml
   services:
     openenvelope:
       volumes:
         - ${HOME}/.codex/auth.json:/codex-auth/auth.json:ro
       environment:
         - CATEGORISER_PROVIDER=codex
         - CODEX_BIN=/usr/local/bin/codex
         - CODEX_HOME=/tmp/codex-home
         - CODEX_MODEL=gpt-6-luna
         - CODEX_REASONING_EFFORT=low
   ```

## Features

### 1. Merchant Categorization

Categorizes merchants when manual rules can't:

**Input:**
- Merchant: "WHOLEFDS MKT #123"
- Amount: $45.67
- Existing categories: ["Groceries", "Dining", "Shopping"]

**Output:**
```json
{
  "category": "Groceries",
  "confidence": 0.95,
  "suggestedRule": {
    "merchantPattern": "WHOLEFDS.*",
    "category": "Groceries"
  }
}
```

**Behavior:**
- High confidence (≥0.8): Auto-categorize
- Medium confidence (0.5-0.8): Suggest to user
- Low confidence (<0.5): Send to review queue

**Usage:**
Automatic during transaction import. No configuration needed.

### 2. Unknown Statement Parsing

Fallback parser for bank statements with no adapter:

**Input:**
```
ACME BANK STATEMENT
Account: 1234-5678-9012-3456

Date       Description           Amount     Balance
01/15/24   GROCERY STORE        -45.67      954.33
01/16/24   PAYCHECK DEPOSIT    3000.00     3954.33
01/17/24   COFFEE SHOP          -5.50      3948.83
```

**Output:**
```json
[
  {
    "date": "2024-01-15",
    "merchant": "GROCERY STORE",
    "amount": -45.67,
    "reference": "..."
  },
  {
    "date": "2024-01-16",
    "merchant": "PAYCHECK DEPOSIT",
    "amount": 3000.00
  },
  {
    "date": "2024-01-17",
    "merchant": "COFFEE SHOP",
    "amount": -5.50
  }
]
```

**Important Safety Guarantees:**

1. **No balance writes**: LLM never writes balances to transactions
2. **Observation flow**: Parsed data goes through normal observation → transaction → reconciliation pipeline
3. **Human review**: Low confidence results go to review queue
4. **Strict schema**: JSON schema validation on all LLM output
5. **Read-only sandbox**: Codex runs in non-interactive, read-only mode

**Usage:**
Automatic fallback during import when no adapter matches.

## Configuration

### Environment Variables

```bash
# Provider selection
LLM_PROVIDER=none|codex|openai

# Codex paths
CODEX_BIN=/usr/local/bin/codex
CODEX_HOME=/tmp/codex-home
CODEX_MODEL=gpt-6-luna
CODEX_REASONING_EFFORT=low

# Performance tuning
LLM_CACHE_ENABLED=true          # Cache results by content hash
LLM_TIMEOUT=30000               # Timeout per request (ms)
LLM_RATE_LIMIT=10               # Max requests per minute
```

### Docker Compose

```yaml
services:
  openenvelope:
    volumes:
      - ${HOME}/.codex/auth.json:/codex-auth/auth.json:ro
    
    environment:
      - CATEGORISER_PROVIDER=codex
      - CODEX_BIN=/usr/local/bin/codex
      - CODEX_HOME=/tmp/codex-home
      - CODEX_MODEL=gpt-6-luna
      - CODEX_REASONING_EFFORT=low
      - LLM_CACHE_ENABLED=true
      - LLM_RATE_LIMIT=10
```

## Caching

Results are cached by content hash for 24 hours:
- Merchant categorization: Cached by (merchant, amount)
- Statement parsing: Cached by first 1000 chars of content

**Benefits:**
- Instant responses for repeated merchants
- Reduced API costs
- Offline re-categorization

**Cache size**: 10,000 entries (auto-pruned by age)

## Rate Limiting

Default: 10 requests/minute

**Behavior:**
- Track requests per minute
- When limit hit, wait until next minute
- Log warning: "Rate limit hit, waiting {ms}"

**Tuning:**
```bash
# Increase for paid plans
LLM_RATE_LIMIT=60

# Decrease for shared accounts
LLM_RATE_LIMIT=5
```

## Cost Estimation

Codex via ChatGPT subscription:
- Uses your existing ChatGPT Plus subscription
- No per-token billing
- Subject to ChatGPT usage limits

OpenAI API (future):
- ~$0.01 per 1,000 transactions (categorization)
- ~$0.05 per PDF statement (parsing)

**Tips to reduce costs:**
- Enable caching (`LLM_CACHE_ENABLED=true`)
- Use merchant rules for common patterns
- Lower rate limit for non-critical imports

## Testing

### Mock Provider

For development without LLM access:

```typescript
import { LLMProvider } from './lib/llm-provider.js';

const provider = new LLMProvider({
  provider: 'none',  // Returns null for all requests
  cacheEnabled: false,
  timeout: 30000,
  rateLimit: { requestsPerMinute: 10 },
});

const result = await provider.categorizeMerchant('Starbucks', -567, ['Coffee']);
// Returns: null
```

### Unit Tests

Run with mocked Codex:

```bash
npm test tests/unit/llm-provider.test.ts
```

Tests include:
- Merchant categorization
- Statement parsing
- Caching behavior
- Rate limiting
- Error handling

## Troubleshooting

### "LLM provider not configured"

Solution: Set `LLM_PROVIDER=codex` in `.env`

### "Codex binary not found"

Solution:
1. Install Codex: `npm install -g codex-cli`
2. Verify path: `which codex`
3. Update `CODEX_BIN` in `.env`

### "Codex authentication failed"

Solution:
1. Login on host: `codex login`
2. Verify session: `codex ping`
3. Mount `~/.codex/auth.json` read-only at `/codex-auth/auth.json` (sessions stay on tmpfs)

### "Rate limit exceeded"

Solution:
1. Reduce `LLM_RATE_LIMIT`
2. Enable caching
3. Batch imports with delays

### Low confidence results

Too many transactions going to review queue:

Solution:
1. Add more merchant rules
2. Train on historical data
3. Provide example categories in config

## Security

### Codex Sandbox

Codex runs in restricted mode:
- `--json`: JSON output only, no interactive prompts
- No file writes
- No network access beyond LLM API
- Read-only document access

### Data Privacy

- Merchant names sent to LLM (public data)
- Amounts sent to LLM (rounded to nearest dollar)
- Account numbers **never** sent to LLM
- Personal info **never** sent to LLM

### Audit Trail

All LLM requests logged:
```json
{
  "level": "info",
  "message": "Merchant categorization requested",
  "merchant": "WHOLE FOODS",
  "amount": 4599,
  "confidence": 0.95
}
```

## Roadmap

- [ ] OpenAI API provider
- [ ] Anthropic Claude provider
- [ ] Fine-tuned models for specific banks
- [ ] Merchant database learning
- [ ] Category suggestions based on spending patterns
- [ ] Budget forecasting
- [ ] Natural language queries ("How much did I spend on dining last month?")

## Further Reading

- [Codex CLI Documentation](https://codex.ai/docs/cli)
- [OpenAI API Reference](https://platform.openai.com/docs)
- [Bulk Import Guide](./BULK_IMPORT.md)
- [Gmail Setup Guide](./GMAIL_SETUP.md)
