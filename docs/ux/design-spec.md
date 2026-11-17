# OpenEnvelope — design spec ("Charlie" style)

Reference: Walking Charlie App Store screenshots. What we take: white paper, black type, black pill CTAs, light-grey rounded surfaces, one big number, `[██████    ]` bracket bars, tiny pixel icons, a mascot whose body tells you the state, deadpan captions, a 5-icon bottom bar. Colour lives in the pixel art and rewards — not in body text or chrome. What we don't: hiding numbers behind the mascot, colour-only meaning, rainbow on every bar (rainbow is a goal-hit / all-clear moment).

## 1. Tokens
### Colour
Chrome stays black / white / grey. Pixel icons, progress fill, mascot, stars, and badges carry colour.

| Token | Value | Use | Contrast on #FFF |
|---|---|---|---|
| `--paper` | `#FFFFFF` | page background | — |
| `--ink` | `#111111` | text, pill CTAs, brackets | 18.9:1 |
| `--ink-2` | `#5C5C5C` | secondary text, targets | 6.7:1 |
| `--ink-3` | `#9A9A9A` | placeholder, empty bar cells, inactive tab icons | 2.8:1 (decorative only, never sole text) |
| `--line` | `#E6E6E6` | dividers, tab-bar rule | — |
| `--wash` | `#F2F2F2` | rounded surface cards, back-button tiles, pressed rows | — |
| `--accent` / `--pin` | `#E24B4A` | overspent cells, review badge, Charlie's red map pin | 4.6:1 on white (text: pair with "OVER"/count, never colour alone) |
| `--ok` | `#1F9D57` | balanced tick, funded-enough text | 4.5:1 |
| `--bar` | `#3DDC84` | in-progress filled `█` cells (Charlie's green donut) | decorative |
| `--gold` | `#F5C518` | pixel stars, gold badges | decorative |
| `--silver` | `#C0C7D1` | silver stars / badges | decorative |
| `--cyan` | `#3DD6F5` | cyan stars, sweat drops | decorative |
| `--bronze` | `#C47A3A` | bronze badges | decorative |
| `--rainbow` | `#FF3B30 → #FF9500 → #FFCC00 → #34C759 → #007AFF → #AF52DE` | goal-hit bar, all-clear digits, mission complete | decorative |

Category pixel icons (not text): Food orange `#F4A259`, Transport blue `#4C9BE8`, Retail purple `#A56DFF`, Housing grass `#7CB342` + brown `#C47A3A`, Tax slate `#6B7C93`, Income green, Transfer teal `#2BB8B3`, Refund pink `#E86BA5`, Fee gold, Interest lime.

Dark mode: not in v1 (Charlie has none). `prefers-contrast: more` swaps `--ink-2` to `--ink`; icons keep colour.

### Type
| Role | Font | Licence | Size/line | Notes |
|---|---|---|---|---|
| Display (titles, mascot captions in headers) | **Silkscreen** (Jason Kottke) | SIL OFL 1.1 | 28/32 mobile, 40/44 desktop | Pixel font; uppercase only, use for ≤ 3 words. |
| Big number | **JetBrains Mono** Bold, tabular | SIL OFL 1.1 | 40/44 mobile, 56/60 desktop | All-clear moment: rainbow-clipped digits (Charlie's `15,700` steps). |
| Body, UI, numbers | **JetBrains Mono** Regular/Bold | SIL OFL 1.1 | 15/22 body, 13/18 small, 17/24 merchant | Tabular digits by default. |
| Fallback | `ui-monospace, "SF Mono", Menlo, monospace` | system | | |
Self-host (`/fonts`), `font-display: swap`. Scale: 11 (meta) · 13 · 15 · 17 · 22 · 28 · 40 · 56. No italics.

### Spacing, borders, radius, shadows
- 4-px grid: 4, 8, 12, 16, 24, 32, 48, 64. Screen side padding 20 mobile / 32 desktop. Big number gets 64 above & below.
- Surfaces: grey `--wash` fill, 12 px radius, no ink outline (Charlie's cards and back buttons). Inputs and black pill CTAs keep 2 px ink.
- Pixel icons never rounded; `image-rendering: pixelated` / `crisp-edges`; integer scale (12 px sprites at 24 px).
- Shadows: **none** on grey cards. Pixel shadow (`4px 4px 0 #111`) only on modals.
- Motion: steps not easing (`steps(4)`), 120–200 ms. `prefers-reduced-motion` → none.

## 2. Number formatting
- `S$1,234.56`, always 2 dp. Locale `en-SG`.
- Negatives: leading real minus `−S$32.40` **plus** a word or shape, never colour alone:
  - envelope available < 0 → `−S$32.40 OVER` with the amount on inverted block (white on ink).
  - outflow in ledger → `−S$4.80`; inflow → `+S$3,200.00` (explicit plus).
  - RTA < 0 → big number `−S$120.00` and caption "Over-assigned by S$120.00."
- Big numbers drop cents ≥ S$10,000 only in the Home hero when width < 360 px; tap reveals cents.
- All-clear / goal-hit big numbers use rainbow-clipped digits plus a caption, never rainbow alone.
- Foreign amounts: secondary line `USD 12.00 · @1.3517`.
- Dates: `Tue 14 Oct` in lists, `14 Oct 2026` in detail, months `Oct 2026`.
- Percentages integer: `62%`.

## 3. Components
### Progress bar (signature)
`[████████░░░░]` rendered as mono cells, 12 mobile / 20 desktop. Empty `░` `--ink-3`. In-progress filled `█` use `--bar` green. Goal hit / fully funded / review queue cleared: each filled cell walks the rainbow. Overspent: red `--accent` cells plus a `!` and the word `OVER` — never colour alone. Always paired with a numeric label; `aria-hidden` on the glyphs, `role="progressbar"` + `aria-valuenow` on the wrapper.

### Buttons
- Primary: ink fill, white text, 2 px ink border, radius 12, height 48, mono bold 15. Charlie's black pills.
- Secondary / back: `--wash` fill, ink text, radius 12 (Charlie's grey back button).
- Ghost/text: underline on hover/focus.
- Destructive: secondary with `--accent` text and border; confirm step required.
- Disabled: `--ink-3` border/text + reason in `title` and inline helper.
- Icon button: 44×44 min, 24 px pixel icon on `--wash` tile.

### Inputs
Height 48, 2 px ink border, radius 12, mono 17 (≥16 avoids iOS zoom). Money inputs right-aligned, prefix `S$` inside, `inputmode="decimal"`. Error: ink border stays, accent 2 px left bar + message below starting "✕".

### Envelope row
```
Groceries                    S$212.40
[██████████░░]  of S$500 · spent S$287.60
```
Line 1 name (17) + available (17 bold, right). Line 2 coloured bar + meta (13 `--ink-2`). Overspent: inverted `−S$32.40 OVER` and red cells + `!`.

### Transaction row
```
Tue 14 Oct  Kopi Corner              −S$4.80
            Food ▸ Hawker · DBS card   ~ pending
```
Markers (text, not colour): `~` provisional, `?` needs review, `⇄` transfer, `✓` reconciled, `÷` split. L1 category shown with its coloured pixel icon.

### Review card
Grey `--wash` surface, radius 12. Merchant 22 bold, amount 28 mono, date/account 13. Guess chip row (top 3 categories with pixel icons + `/`). Confidence bar in `--bar` green. Footer: `[ accept ⏎ ]  skip s`. Counter `12 / 190` + bracket bar. Bulk banner above card when merchant count > 1. Clearing a merchant group shows a pixel star on the undo toast (no modal). Queue hitting zero: happy Penny, rainbow bar, rainbow `0`, three gold stars.

### Tab bar
5 pixel icons 24 px. Charlie: inactive icons are light-grey line art; the active icon is in its own colour (map pin red, etc.). We do the same — no long labels on mobile (accessible name only) so Transactions/Accounts cannot collide. Desktop rail 72 px: icon + 11 px label. Home envelope, Review magnifier (badge count), Budget green donut, Ledger scroll, Accounts bank. Import / Reconcile / Pipeline are not tabs; they live in a More menu on Accounts.

### Toasts
Bottom, above tab bar, ink fill white text, radius 12, 1 line + one action (`undo`). Reward toasts include a gold pixel star. 10 s for undo, 4 s otherwise. `role="status"`.

### Modals / sheets
Mobile: bottom sheet, full width. Desktop: centred 480 px, pixel shadow. Esc closes.

### Empty states
Mascot (72 px, 3× a 16 px sprite) + one sentence + one button. Queue empty is a quiet celebration (stars + rainbow), not a blocking modal.

### Strips
Offline / stale / session: full-width 32 px strip top, `--wash` fill, ink text.

### Mascot — "Penny" the envelope
A 16×16 pixel envelope with cream paper, gold flap, pink cheeks, stubby legs, drawn at ~3× (72 px). Colour tells the health state; caption still required.
| State | Trigger | Look | Caption |
|---|---|---|---|
| Fed | RTA = 0 and no overspent / queue empty | cream, blush, smile | "Every dollar has a job." / "Nothing to check. Penny approves." |
| Hungry | RTA > 0 | flap open | "Penny is hungry. S$1,240.00 to assign." |
| Stuffed | RTA < 0 | red body, sweat drops | "Penny is over-stuffed." |
| Torn | ≥1 envelope overspent | red + tear | "Penny has a hole. 2 envelopes over." |
| Busy | pipeline running | carrying a paper | "Penny is reading your statements." |
| Squinting | review queue > 0 | worried, sweat, squint | "190 things look odd to Penny." |
| Asleep | offline/session | Zzz | "Penny dozed off." |
Priority when several apply: Torn > Stuffed > Squinting > Hungry > Fed. Mascot is `role="img"` with alt = caption.

### Rewards
Small, non-blocking: gold pixel star on merchant-group clear; three stars + rainbow digits + rainbow bar when the review queue hits zero. Same rainbow language as Charlie's Lightning Thighs bar and `15,700` achievement digits.

## 4. Accessibility
- WCAG 2.2 AA: all text ≥ 4.5:1 (`--ink-2` 6.7:1); `--ink-3` never carries information alone. Colourful icons and rainbow bars are decorative next to text labels.
- Focus: 3 px `--ink` outline + 2 px offset on every focusable; never removed.
- Tap targets ≥ 44×44 (rows 56, buttons 48, icon buttons 44).
- No colour-only meaning: overspend = word "OVER" + `!` + inverted or red cells; reconcile = `✓ balanced` / `≠ off S$20.00`; active tab = coloured icon **and** `aria-current`.
- Screen readers: amounts read as "minus 32 dollars 40, over"; bars expose value; tab buttons use `aria-label`.
- Text zoom to 200% without horizontal scroll; pixel font only for ≤ 3-word headings.

## 5. Responsive
- 375 px base: single column, icon-only bottom tabs, hero number 40 px; tables become rows. Content starts at the top — no Import/Reconcile/Pipeline row on every screen.
- ≥ 768: left rail, Home/Review/Budget content max 1040 centred in the area beside the rail (32 px side padding); Ledger/Accounts/Pipeline max 1280. Home hero text stays a centred readable cluster; CTA and cards span the column. Review stays stacked.
- ≥ 1280: Review shows merchant group list (left 40%) + card (right). Budget may later show envelope list + detail side panel.
- Never horizontal scroll at 375 except the /pipeline graph (pan/zoom).
- Safari: `100dvh`, safe-area insets, `-webkit-tap-highlight-color: transparent`, inputs ≥16 px.

## 6. Microcopy voice
Deadpan, short, present tense, the mascot is the butt of the joke, never the user. Numbers stay exact. No exclamation marks except celebrations (max one).
| Place | Copy |
|---|---|
| Home, hungry | "S$1,240.00 is sitting around. Penny is hungry." |
| Home, fed | "Every dollar has a job. Penny is content." |
| Overspent | "Eating Out is S$32.40 over. Cover it?" |
| Overassigned | "You assigned S$120.00 you don't have." |
| Review counter | "190 to check. About 15 minutes." |
| Bulk | "Kopi Corner, 23 times. All Food ▸ Hawker?" |
| Queue empty | "Nothing to check. Penny approves." |
| Duplicate upload | "Already have this one. Nothing changed." |
| Locked PDF | "This PDF is locked. Banks usually use your NRIC + date of birth." |
| Unknown format | "Never seen this layout. Penny can try reading it anyway." |
| Unbalanced | "Off by S$20.00. Something's missing or doubled." |
| Balanced | "Balanced. To the cent." |
| Session expiry | "Your session napped. Sign in again — your edit is saved." |
| Offline | "Offline. Showing what we had at 14:02." |
| Conflict | "Sam changed this 2 min ago. Keep hers or yours?" |
| Month rollover | "October started. Leftovers rolled over." |
| Empty ledger | "No transactions. Penny is very thin." |
