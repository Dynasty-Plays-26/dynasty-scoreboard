# Dynasty Scoreboard — Production Wiring

> **v0 SMOKE TEST** — controlled-branch pilot build (`v0-smoke-test`). Wired to the
> live stack for the first employer pilots. Auto-deploy from every branch is intentionally
> OFF until pilot results are reviewed. Legacy diagnostic prototype preserved under `legacy/`.

Room 101 / Tier 01 Light board → Frost wire → statement upload → engine →
initial report → Room 303 Full board (12-month). Persistence in D1 + R2.

## Structure

```
dynasty-scoreboard/
├── wrangler.toml            # Worker + D1 + R2 + cron config
├── schema/schema.sql        # D1 tables
├── worker/index.js          # API + engine + reports + cron
└── public/
    ├── room-101/index.html  # LIGHT board (Tier 01) — no prototype controls
    └── board/index.html     # FULL board (Room 303) — activation, gray-out, reports, nudge
```

## The flow

1. **Room 101 / Tier 01 — Light board.** Header + Waste Box hero + 30-day expiry + CTA. No prototype controls.
2. **Unlock CTA → Frost wire.** `POST /api/wire/:cid` → `status=awaiting_wire`, reveals Frost wire panel (ref `DYN-<cid>`). Canonical Frost-only path; Stripe/Netlify stay decommissioned.
3. **Payment confirmed.** Don confirms receipt → `POST /api/payment-confirmed/:cid` → `status=awaiting_statement`. Client is routed to the Full board's activation step.
4. **Statement upload → engine (auto-run).** `POST /api/upload/:cid` (multipart `statement`). PDF → R2 `statements/<cid>/<m>.pdf`. Engine validates savings. **On success:** first upload sets `status=full`, starts the 12-month clock, builds the fiscal-quarter report schedule, and generates the **initial printable report**. **On failure:** client drops to `status=exception` (HITL) — the engine never shows a bad number.
5. **Full board — Room 303.** 12-month run, 90/10 fee logic, progress bar + true-up, realized/fee to date, report history. Nudge asked once (Quarterly default).
6. **Gray-out.** Missing current-month statement → `status` derives to `gray` (board desaturates, banner shows). Next upload relights.
7. **Quarterly reports.** Cron sweeps `report_schedule` daily; fires each fiscal quarter's report on close date, archives HTML to R2, emails via ZeptoMail (BCC Don). Skips clients on HITL hold.

## State machine

`light → awaiting_wire → awaiting_statement → full ⇄ gray`
Any state → `exception` (auto on engine failure OR manual flag) → `resolve` back to prior state.

## Fee model (90/10)

- `$10,000` flat on the first `$100,000` found.
- `+10%` on everything above `$100,000`.
- Total fee ÷ 12, collected **monthly in lockstep** with validated savings — never a lump sum.
- Examples: $175K → $17,500 total ($1,458/mo). $250K → $25,000 ($2,083/mo). $100K → $10,000 ($833/mo).

## Fiscal quarters

`clients.fiscal_q_start_month` (1–12) sets the fiscal year start. On activation, the Worker computes each fiscal quarter that closes within the 12-month window and writes `report_schedule` rows. Reports fire on quarter-close and are labeled by the quarter that just closed (e.g. `FY2026-Q3`). Verified for Jan / Oct / Jul fiscal starts.

## Endpoints

| Method | Route | Purpose |
|---|---|---|
| GET  | `/api/board/:cid` | Board payload (state machine) |
| POST | `/api/wire/:cid` | $10k Frost wire initiated |
| POST | `/api/payment-confirmed/:cid` | Don confirms wire received |
| POST | `/api/upload/:cid` | Statement → engine → report → Full activation |
| POST | `/api/nudge/:cid` | Store nudge pref (asked once) |
| POST | `/api/exception/:cid` | Manual HITL flag `{reason}` |
| POST | `/api/resolve/:cid` | Clear exception |
| GET  | `/api/report/:cid/:file` | Serve archived HTML report |
| cron | `scheduled()` | Sweep due quarterly reports (daily 13:00 UTC) |

## Deploy

```bash
# 1. D1
wrangler d1 create dynasty_scoreboard          # paste id into wrangler.toml
wrangler d1 execute dynasty_scoreboard --file=schema/schema.sql

# 2. R2
wrangler r2 bucket create dynasty-scoreboard-blobs

# 3. Secrets (Zoho ZeptoMail)
wrangler secret put ZEPTO_TOKEN
wrangler secret put ZEPTO_FROM

# 4. Ship
wrangler deploy

# Frontends: publish public/ via the dynasty-stadium-2 Pages project
# (routes /room-101/ and /board/).
```

## What's stubbed for production hand-off

- **`runEngine()`** in `worker/index.js` — statement parser is a stub that validates the expected monthly reduction. Drop in the real Kairos billing-statement parser here; keep the `throw → HITL exception` contract so parse failures always land in the 24-hour human loop.
- **Frost wire account numbers** — served from `/rooms/101/wire`; the board shows the reference only.
- Client records are seeded from the Tier-0 renewal upload that issues the `cid`.
