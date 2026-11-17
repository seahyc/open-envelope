# Bulk Historical Import

Import years of historical statements in one command.

## Overview

OpenEnvelope can batch-import entire folder trees of bank statements:
- **CSV files**: Generic CSV format
- **OFX/QFX files**: Open Financial Exchange (US banks)
- **PDF statements**: Bank statement PDFs (requires adapter or LLM)
- **Email files**: RFC822 .eml files

## Quick Start

### 1. Organize Your Statements

Create a folder structure mapping to your accounts:

```
statements/
├── OCBC_CreditCard/
│   ├── 2024-01_OCBC_CC_xxxx.pdf
│   ├── 2024-02_OCBC_CC_xxxx.pdf
│   └── 2024-03_OCBC_CC_xxxx.pdf
├── DBS_Account/
│   ├── 2024-01_DBS_Checking.csv
│   └── 2024-02_DBS_Checking.csv
├── CPF/
│   ├── 2024-Q1_CPF_Statement.pdf
│   └── 2024-Q2_CPF_Statement.pdf
└── OCBC_Savings/
    └── transactions.csv
```

### 2. Create Account Mappings

Copy the example config:

```bash
cp accounts.yaml.example accounts.yaml
```

Edit `accounts.yaml`:

```yaml
accounts:
  - folderPattern: "OCBC_CreditCard"
    accountAlias: "xxxx"  # Last 4 digits of card
    accountName: "OCBC Credit Card"
  
  - folderPattern: "DBS_Account"
    accountAlias: "yyyy"
    accountName: "DBS Checking"
  
  - folderPattern: "CPF"
    accountAlias: "cpf"
    accountName: "CPF Account"
  
  - folderPattern: "OCBC_Savings"
    accountAlias: "savings"
    accountName: "OCBC Savings"
```

**Note**: `accounts.yaml` is gitignored to protect your account structure.

### 3. Run Import

**CLI (recommended for local):**

```bash
npm run import -- ./statements
```

**API (for remote/programmatic):**

```bash
curl -X POST https://your-openenvelope.com/api/bulk-import \
  -H "X-Auth-User: you@example.com" \
  -H "Content-Type: application/json" \
  -d '{"directory": "/data/statements"}'
```

## Import Output

```
Loaded 4 account mappings from accounts.yaml

Importing from: ./statements

=== Import Summary ===

✓ statements/OCBC_CreditCard/2024-01_OCBC_CC_xxxx.pdf
  Adapter: pdf
  Observations: 45
  New transactions: 45

✓ statements/DBS_Account/2024-01_DBS_Checking.csv
  Adapter: csv-generic
  Observations: 23
  New transactions: 23

○ statements/OCBC_CreditCard/2024-01_OCBC_CC_xxxx.pdf (Already imported)

✗ statements/Unknown/statement.txt
  Error: No adapter found

=== Statistics ===

Total files: 12
Success: 10
Skipped: 1
Errors: 1
Total observations: 456
New transactions: 456
```

## Features

### Idempotent Imports

Re-running import is safe:
- Documents are content-hashed (SHA-256)
- Duplicate documents are skipped
- Observations are deterministically ID'd
- Re-importing the same file is a no-op

```bash
# First run: imports 100 transactions
npm run import -- ./statements

# Second run: skips all files
npm run import -- ./statements
# Output: "Already imported" for all files
```

### Adapter Detection

OpenEnvelope automatically picks the right adapter:
- `.csv` → CSV adapter
- `.ofx`, `.qfx` → OFX adapter
- `.pdf` → PDF adapter (or LLM fallback)
- `.eml` → Email adapter

### Account Hint Mapping

Folder patterns map to account aliases:

```yaml
- folderPattern: "OCBC_CreditCard"
  accountAlias: "xxxx"
```

Files in `OCBC_CreditCard/` are tagged with `accountHint: "xxxx"`.

During transaction matching, OpenEnvelope finds the account with alias `xxxx`.

### Folder Pattern Matching

Patterns use regex matching:

```yaml
# Match any folder containing "OCBC"
- folderPattern: ".*OCBC.*"
  accountAlias: "ocbc"

# Match exact folder name
- folderPattern: "^DBS_Checking$"
  accountAlias: "dbs-checking"

# Match multiple patterns (first match wins)
- folderPattern: "360_Account|360_Savings"
  accountAlias: "360"
```

## Advanced Usage

### API Endpoint

`POST /api/bulk-import`

**Request:**
```json
{
  "directory": "/data/statements",
  "accountMappings": [
    {
      "folderPattern": "OCBC_CreditCard",
      "accountAlias": "xxxx",
      "accountName": "OCBC Credit Card"
    }
  ]
}
```

**Response:**
```json
{
  "results": [
    {
      "file": "statements/OCBC_CreditCard/2024-01.pdf",
      "status": "success",
      "adapter": "pdf",
      "observations": 45,
      "newTransactions": 45,
      "matched": 0
    }
  ],
  "stats": {
    "total": 12,
    "success": 10,
    "skipped": 1,
    "error": 1,
    "observations": 456,
    "newTransactions": 456
  }
}
```

### Docker Integration

Mount your statements folder:

```yaml
# docker-compose.yml
services:
  openenvelope:
    volumes:
      - ./statements:/statements:ro
      - ./accounts.yaml:/app/accounts.yaml:ro
```

Run import:

```bash
docker compose exec openenvelope npm run import -- /statements
```

### Cron Scheduled Import

Import new statements automatically:

```bash
# crontab
0 3 * * * cd /path/to/openenvelope && npm run import -- ./statements >> /var/log/import.log 2>&1
```

Or with Docker:

```bash
0 3 * * * cd /path/to/openenvelope && docker compose exec -T openenvelope npm run import -- /statements >> /var/log/import.log 2>&1
```

## LLM Fallback Parsing

For unknown statement formats, enable LLM parsing:

```bash
LLM_PROVIDER=codex
CODEX_BIN=/usr/local/bin/codex
CODEX_HOME=/home/node/.codex
```

When a PDF has no matching adapter, OpenEnvelope:
1. Extracts text from PDF
2. Sends to LLM with strict schema
3. Validates returned observations
4. Creates transactions via normal flow

**Important**: LLM never writes balances directly. All LLM-parsed data goes through:
- Observation creation
- Transaction matching
- Reconciliation
- Human review queue

See [LLM.md](./LLM.md) for details.

## Troubleshooting

### "No adapter found"

File type not supported or extension wrong:
- Check file extension (`.csv`, `.pdf`, `.ofx`)
- Verify file is readable
- Check adapter supports that bank's format

### "Already imported" for new file

File content is identical to previous import:
- Hash collision (very rare)
- File was copied with different name
- Use `--force` flag to re-import (not implemented yet)

### Account hint not mapped

Folder pattern doesn't match:
- Check `accounts.yaml` patterns
- Use regex tester (regex101.com)
- Add catch-all pattern:
  ```yaml
  - folderPattern: ".*"
    accountAlias: "unknown"
    accountName: "Uncategorized"
  ```

### Import runs but no transactions

Observations created but not matched to accounts:
- Check account aliases in OpenEnvelope match `accounts.yaml`
- Review observation IDs in database
- Check transaction matching logic

## Performance

Import speed:
- **CSV**: ~1000 transactions/sec
- **OFX**: ~500 transactions/sec
- **PDF** (text): ~100 transactions/sec
- **PDF** (LLM): ~5 transactions/sec (rate limited)

For large imports (10,000+ transactions):
- Use CSV when possible
- Batch PDF imports overnight
- Monitor LLM rate limits

## Security

- `accounts.yaml` is gitignored by default
- Statement files should be kept private
- Mount statement folders read-only in Docker
- LLM parsing uses read-only sandbox (Codex)
- Original documents stored content-hashed

## Migration from Other Tools

### From YNAB

1. Export YNAB transactions as CSV
2. Organize by account name
3. Map folder patterns in `accounts.yaml`
4. Import: `npm run import -- ./ynab-export`

### From Mint

1. Export Mint transactions (CSV per account)
2. Organize files by account
3. Create `accounts.yaml` mappings
4. Import and reconcile

### From Excel/Spreadsheets

1. Export sheets as CSV
2. Ensure columns: Date, Description, Amount
3. Create `accounts.yaml` entry
4. Import: OpenEnvelope auto-detects CSV format
