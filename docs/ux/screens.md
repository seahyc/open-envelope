# OpenEnvelope — screens (ASCII wireframes)

State IDs refer to `journey-map.md` (S-xx, daily driver) and `docs/ux/onboarding-general.md` (G-xx, any-couple first run). Mobile frames are 375 px wide (~40 chars), desktop ~100 chars. All data is made up.

## M1. Home — mobile  (S-30, S-41..S-44, mascot)
```
┌──────────────────────────────────────┐
│ ✉ 190                     Oct 2026 ▾ │
│                                      │
│            READY TO ASSIGN           │
│            S$1,240.00                │
│   [████████████░░░░░░░░] 61% funded  │
│                                      │
│               ▄▀▀▀▀▄                 │
│              █ o  o █   (Penny)      │
│              █  ‿‿  █                │
│               ▀▄▄▄▄▀                 │
│      Penny is hungry. 2 over.        │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ 190 to check · ~15 min      →  │  │
│  └────────────────────────────────┘  │
│  Eating Out      −S$32.40 OVER    →  │
│  Transport       −S$8.10  OVER    →  │
│                                      │
│ ─────────────────────────────────────│
│  ⌂      ⌕190     ◎      ≡      ▣     │
│ home   review  budget ledger accts   │
└──────────────────────────────────────┘
```
Variants: RTA 0 → "Every dollar has a job." no bar caption; RTA<0 → `−S$120.00` inverted + "over-assigned" + `[ fix ]`.

## D1. Home — desktop (S-30)
```
┌────┬──────────────────────────────────────────────────────────────────────────────┐
│ ⌂  │  READY TO ASSIGN                          ▄▀▀▄  Penny is hungry.             │
│ ⌕  │  S$1,240.00   [ assign ]                  █oo█  2 envelopes over.            │
│190 │  [██████████████░░░░░░] 61% funded        ▀▄▄▀                               │
│ ◎  │ ──────────────────────────────────────────────────────────────────────────── │
│ ≡  │  TO DO                                 │ RECENT                              │
│ ▣  │  190 to check          [ review ]      │ Tue 14 Oct Kopi Corner     −S$4.80 ~│
│    │  Eating Out −S$32.40 OVER [ cover ]    │ Tue 14 Oct FairMart       −S$62.15 ✓│
│ ⚙  │  OCBC 360 Jul ≠ off S$20.00 [ fix ]    │ Mon 13 Oct Salary      +S$6,000.00 ✓│
└────┴──────────────────────────────────────────────────────────────────────────────┘
```

## M2. First run with imported data (S-03, S-10)
```
┌──────────────────────────────────────┐
│ WELCOME                              │
│                                      │
│ Found 6 accounts and 1,0xx           │
│ transactions (Mar–Sep).              │
│ 190 need a look.                     │
│                                      │
│ Your name   [ Alex          ]   │
│ Partner     [ Sam             ]   │
│             optional · can add later │
│ Currency    SGD (S$)                 │
│                                      │
│ [        start reviewing →        ]  │
│ skip for now                         │
└──────────────────────────────────────┘
```
Empty-DB variant (S-02): same frame, text "Nothing here yet. Penny's empty." button `[ set up → ]` then M5 Import.

## M3. Review card — mobile (S-20, S-21, S-26)
```
┌──────────────────────────────────────┐
│ ← REVIEW            12/190 [█░░░░░░] │
│ ┌──────────────────────────────────┐ │
│ │ Kopi Corner ×23 in queue         │ │
│ │ All → Food ▸ Hawker?             │ │
│ │ [ accept all 23 ]  ☐ always      │ │
│ └──────────────────────────────────┘ │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │
│ ┃ KOPI CORNER                      ┃ │
│ ┃ −S$4.80                          ┃ │
│ ┃ Tue 14 Oct · DBS card            ┃ │
│ ┃                                  ┃ │
│ ┃ guess  Food ▸ Hawker             ┃ │
│ ┃        [████░░] 62%              ┃ │
│ ┃ [Hawker] [Coffee] [Groceries] [⌕]┃ │
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛▌│
│                                      │
│ [   accept   ]      skip   transfer  │
│  swipe → accept   ← skip             │
└──────────────────────────────────────┘
```

## D3. Review — desktop list + card (S-20, S-21, S-22)
```
┌────┬──────────────────────────────────────┬───────────────────────────────────────┐
│    │ REVIEW 190   filter: [all reasons ▾] │  KOPI CORNER                          │
│    │ ☐ ≠ OCBC 360 Jul off S$20.00         │  −S$4.80 · Tue 14 Oct · DBS card      │
│    │ ☐ ⇄ OCBC 360 −S$500 ↔ DBS card       │  guess Food ▸ Hawker [████░░] 62%     │
│    │ ▸ Kopi Corner ×23      Hawker 62%    │  1 Hawker  2 Coffee  3 Groceries  / … │
│    │ ☑ Kopi Corner  −S$4.80               │                                       │
│    │ ☑ Kopi Corner  −S$3.60               │  [ accept ⏎ ]  s skip  t transfer     │
│    │ ▸ FairMart ×9          Groceries 88% │  u undo   x select   c set category   │
│    │ ☐ Unknown Pte Ltd −S$129.00   ?      │                                       │
│    │ 2 selected → [ set category c ]      │  ? keyboard help                      │
└────┴──────────────────────────────────────┴───────────────────────────────────────┘
```

## M4a. Possible transfer (S-23)
```
┌──────────────────────────────────────┐
│ ← REVIEW · transfer?        40/190   │
│ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │
│ ┃ OCBC 360        −S$500.00        ┃ │
│ ┃ Mon 6 Oct       "PAYMENT DBS"    ┃ │
│ ┃          ⇄                       ┃ │
│ ┃ DBS card        +S$500.00        ┃ │
│ ┃ Tue 7 Oct       "PAYMENT RECD"   ┃ │
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ │
│ Card payment. Moves money out of     │
│ "DBS card payment" envelope.         │
│ [ link as transfer ]                 │
│ not a transfer   pick other leg      │
└──────────────────────────────────────┘
```

## M4b. Unbalanced period (S-24, S-33)
```
┌──────────────────────────────────────┐
│ ← OCBC 360 · Jul 2026                │
│ statement closing    S$4,210.33      │
│ we add up to         S$4,190.33      │
│ ≠ off by             S$20.00         │
│                                      │
│ Likely:                              │
│ • missing +S$20.00 (no line found)   │
│ • none doubled                       │
│                                      │
│ [ add missing line ]                 │
│ mark duplicate   accept with note    │
└──────────────────────────────────────┘
```

## M5. Import (S-12..S-19b)
```
┌──────────────────────────────────────┐
│ IMPORT                               │
│ ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐  │
│   drop or tap to add statements      │
│   PDF · CSV · OFX                    │
│ └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘  │
│ dbs-card-aug.pdf                     │
│ [██████░░░░] categorise 7/11         │
│ ocbc-jul.pdf    ✓ 84 lines · 12 ?    │
│ ocbc-jul.pdf    = already have this  │
│ srs-q3.pdf      🔒 locked [ unlock ] │
│ weird.pdf       ✕ unknown layout     │
│                 [ pick account ]     │
│ [ review 12 → ]       pipeline view  │
└──────────────────────────────────────┘
```
Sheets: unlock (password input + "not stored"), pick account (radio list with last-4, `+ new`), partial parse (list of raw lines with `[ fix ]`). Failure row: `✕ parse failed · retry · details`.

## M6. Budget (S-40..S-48)
```
┌──────────────────────────────────────┐
│ ‹  OCT 2026  ›          RTA S$1,240  │
│ FOOD                                 │
│ Groceries                  S$212.40  │
│ [████████░░░░] of S$500              │
│ Hawker                      S$88.00  │
│ [██████░░░░░░] of S$200              │
│ Eating Out            −S$32.40 OVER  │
│ [████████████]!  [ cover ]           │
│ CREDIT CARD PAYMENTS                 │
│ DBS card payment           S$812.30  │
│ card balance S$812.30 ✓ covered      │
│ HOME                                 │
│ Rent / Mortgage          S$2,400.00  │
│ [████████████] of S$2,400 ✓          │
│ [ + envelope ]   [ assign underfunded ]│
└──────────────────────────────────────┘
```
Assign sheet (S-47): `Groceries  assigned [ S$500.00 ]  −  +`, `quick: last month S$480 · target S$500 · underfunded S$12`. Cover sheet (S-44): list of envelopes with available, tap one, amount defaults to shortfall. Empty (S-48): Penny + "No envelopes. Start from your categories?" `[ create from categories ]`. Rollover toast (S-46).

## M7. Ledger (S-50..S-57)
```
┌──────────────────────────────────────┐
│ LEDGER   [ ⌕ search          ]  ⚲   │
│ all accts ▾  oct ▾  needs review ☐   │
│ TUE 14 OCT                           │
│ Kopi Corner               −S$4.80 ~  │
│ Food ▸ Hawker · DBS card  pending    │
│ FairMart                 −S$62.15 ✓  │
│ Groceries ÷2 · OCBC card             │
│ MON 13 OCT                           │
│ Salary                +S$6,000.00 ✓  │
│ Income · OCBC 360                    │
│ ░░░░░░░░░░░░░░ loading more          │
└──────────────────────────────────────┘
```
Edit sheet: payee, date, amount (locked 🔒 "from statement"), category, memo, `split`, `void`. Split: rows + `[left: S$12.00]`, save disabled until 0. Conflict modal (S-57): two columns "Sam's · yours", `[ keep hers ] [ use mine ]`. Desktop: table with columns Date · Payee · Category · Account · Amount · State, inline edit on Enter.

## M8. Accounts (S-31, S-32, S-33)
```
┌──────────────────────────────────────┐
│ ACCOUNTS                             │
│ BUDGET                               │
│ OCBC 360           S$4,210.33        │
│   Sep ✓ balanced                     │
│ Joint (DBS)        S$1,020.00        │
│   Sep ✓ balanced                     │
│ CREDIT                               │
│ DBS card            −S$812.30        │
│ OCBC card           −S$240.10        │
│ TRACKING (off-budget)                │
│ CPF               S$xx,xxx.xx        │
│ SRS                S$x,xxx.xx        │
│ [ + account ]                        │
└──────────────────────────────────────┘
```
Account detail: periods list `Mar ✓ … Jul ≠ off S$20.00`, `starting balance S$3,500.00 on 1 Mar [ edit ]`, aliases. Starting-balance sheet: date + amount, suggestion "earliest statement opened at S$3,500.00 [ use ]".

## Global states (every screen)
```
loading:  ░░░░░░░░░░░░░░░░░░░░  (skeleton rows, after 300 ms)
error:    ┌ ✕ Couldn't load (500). Nothing was saved. [ retry ] ┐
offline:  ▔ offline · showing 14:02 data ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
stale:    ▔ Sam changed 3 things · [ refresh ] ▔▔▔▔▔▔▔▔▔▔▔▔▔▔
session:  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
          ┃ Penny dozed off (zzz)            ┃
          ┃ Your session napped. Your edit   ┃
          ┃ is saved.   [ sign in again ]    ┃
          ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```
Pipeline (`/pipeline`, S-60): unchanged React Flow graph, restyled: white nodes, 2 px ink border, mono labels, counts `parse 84`, failed node `✕` + accent outline. Linked from Settings and import errors only.

## Onboarding (general) — G-states

See `docs/ux/onboarding-general.md` for every state, transition, empty/partial/error/abandoned path. These frames are the P1 welcome + P2 consent pair at 375; desktop (1280) is the same column centred at 480 px (`oe-onboard`).

### M-G20 Welcome (G-20)
```
┌──────────────────────────────────────┐
│                                      │
│               ▄▀▀▀▀▄                 │
│              █ o  o █   Penny        │
│              █  ‿‿  █                │
│               ▀▄▄▄▄▀                 │
│                                      │
│ HI.                                  │
│ One household budget. You and        │
│ your person. Penny watches the       │
│ envelopes.                           │
│                                      │
│ [           let's go             ]   │
│ I have an invite                     │
└──────────────────────────────────────┘
```

### M-G41 P2 consent (G-41)
```
┌──────────────────────────────────────┐
│ JOIN                                 │
│                                      │
│ Alex invited you to Garden Budget.   │
│ Shared: budget, ledger, envelopes.   │
│ Private: your receipts, calendar,    │
│ location — off until you connect.    │
│                                      │
│ ☐ I understand my partner can see    │
│   shared transactions, and I choose  │
│   which of my Connections to turn on.│
│                                      │
│ [             join               ]   │
│ decline                              │
└──────────────────────────────────────┘
```

Build sequence for any-couple (blocks screens.md steps 4–9 and context-signals follow-ons): tenancy → auth/invite → these screens → Connections re-scoped. Do not implement steps 4–9 in that pass.

## Implementation order (fastest path to "reviewing 190 lines, then budgeting")
1. **Foundation (½ day).** Plain CSS tokens + fonts (`styles.css`), `src/client/api.ts` wrapper (JSON check → session-expired modal, error card, offline strip), real routing (`/`, `/review`, `/budget`, `/ledger`, `/accounts`, `/pipeline`), bottom tab bar / left rail. Depends on the other agent's CSS + gate fixes.
2. **Review queue backend (1 day).** `GET /api/review` returning transaction-joined items grouped by merchant; `POST /api/review/:id/resolve`, `POST /api/review/bulk {ids, category, rememberRule}`, `undo`. Reuse `categorize` + `rememberLabel`.
3. **Review UI (1–1.5 days).** M3/D3: card, guess chips, same-merchant bulk accept, keyboard map, swipe, undo toast, empty state. → user can clear ~190 lines (target: under 20 min with bulk).
4. **Transfer + unbalanced cards (1 day).** M4a/M4b on existing transfer/reconciliation services. (All prod periods are balanced today, so this ranks after categories.)
5. **Starting balances + accounts (½ day).** SGD fix, edit sheet, M8.
6. **Budget core (2 days).** Envelopes from L2 categories, assign = set, move/cover, RTA carry-forward & overspend rules, credit-card payment envelopes, M6 + Home M1 with Penny.
7. **Ledger (1 day).** Paging/search/filter, provisional/matched markers, edit/split/void.
8. **Import UX (1 day).** Distinct outcomes (duplicate, locked, unknown, pick account, partial), per-file stage progress.
9. **Collaboration polish (½ day).** `updated_at` optimistic locking + conflict modal, stale strip, partner add, rollover toast.
