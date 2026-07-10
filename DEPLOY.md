# Dynasty Scoreboard — Go-Live Runbook (Moves 4 & 5)

Everything on `main` is merged and QA'd. These are the two steps that require
your Cloudflare account auth (D1/R2/secret provisioning + Git wiring) — they can't
run headless. Budget ~5 minutes.

Account: `0aaf25d2e2ffa7d18c01d096d4b9b843` · Pages project: `dynasty-stadium-2`
Hostname: `stadium.dynastyplays.com`

---

## Move 5 — provision + deploy the Worker (do this first)

Run from the repo root after `git pull` on `main`:

```bash
# 0. one-time: authenticate wrangler to your account
npx wrangler login            # or: export CLOUDFLARE_API_TOKEN=...

# 1. D1 database
npx wrangler d1 create dynasty_scoreboard
#   -> copy the printed database_id into wrangler.toml (replace REPLACE_WITH_D1_ID)
npx wrangler d1 execute dynasty_scoreboard --remote --file=schema/schema.sql

# 2. R2 bucket (statements + archived reports)
npx wrangler r2 bucket create dynasty-scoreboard-blobs

# 3. secrets (Zoho ZeptoMail)
npx wrangler secret put ZEPTO_TOKEN
npx wrangler secret put ZEPTO_FROM

# 4. ship the Worker (API + engine + cron)
npx wrangler deploy

# 5. seed the first pilot client (includes the new baseline_monthly_premium)
npx wrangler d1 execute dynasty_scoreboard --remote --command "
INSERT INTO clients (cid, company, carrier, renewal_date, annual_waste, baseline_monthly_premium, status, fiscal_q_start_month, nudge_pref, nudge_asked)
VALUES ('DP-2026-0714','Lone Star Fabrication LLC','Blue Cross Blue Shield of Texas','2026-11-01',175000,60833,'light',1,'quarterly',0);
"
```

Smoke-check: `https://stadium.dynastyplays.com/api/board/DP-2026-0714` should return the Light-board payload.

> **baseline_monthly_premium matters now:** the v0 engine derives realized savings as
> `baseline − current-statement premium`, so every pilot client must be seeded with a
> real baseline. Missing/zero baseline → statement upload routes straight to HITL by design.

---

## Move 4 — wire Git auto-deploy, scoped to `main` only

Cloudflare dashboard → **Workers & Pages → dynasty-stadium-2 → Settings → Builds & deployments → Git integration → Connect GitHub**:

1. Authorize the GitHub app for `Dynasty-Plays-26/dynasty-scoreboard`.
2. **Production branch:** set to `main` (only).
3. **Preview deployments:** set to **"None"** (or "Custom branches" with an empty list) so
   pilot/feature branches do **not** auto-deploy. This is the controlled-branch guarantee.
4. Build command: none needed (static `public/` + Worker deployed via `wrangler`), or set
   your Pages build if you serve the frontends through Pages.

After this, a push to `main` redeploys production; anything else stays dark until you promote it.

---

## What's live vs. pending

- ✅ Code on `main` (merged PR #1 + real engine parser).
- ✅ Engine verified against 6 cases; good statement validates to the exact figure, all bad inputs route to HITL.
- ⏳ Move 5 (wrangler provision + deploy) — needs your Cloudflare auth; script above.
- ⏳ Move 4 (Git integration, main-only) — dashboard steps above.

Once you've run these, ping me the `database_id` if you want me to commit the filled-in `wrangler.toml` back to `main`.
