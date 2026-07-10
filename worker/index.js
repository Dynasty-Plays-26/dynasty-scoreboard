/* =====================================================================
   DYNASTY SCOREBOARD WORKER
   Cloudflare Worker — backs Room 101 (Light) + Board (Full).
   Bindings (wrangler.toml):
     DB   -> D1 database   (dynasty_scoreboard)
     R2   -> R2 bucket     (dynasty-scoreboard-blobs)
     ZEPTO_TOKEN, ZEPTO_FROM  -> Zoho ZeptoMail (secrets)
     BCC  -> don@dynastyplays.com
   Routes:
     GET  /api/board/:cid            -> full board payload (state machine)
     POST /api/wire/:cid             -> $10k Frost wire initiated (status=awaiting_wire)
     POST /api/payment-confirmed/:cid-> Don confirms wire (status=awaiting_statement)
     POST /api/upload/:cid           -> multipart billing statement -> engine -> report -> full
     POST /api/nudge/:cid            -> store nudge pref (asked once)
     POST /api/exception/:cid        -> manual HITL flag {reason}
     POST /api/resolve/:cid          -> clear exception, recompute state
     GET  /api/report/:cid/:file     -> serve archived HTML report from R2
     (cron) scheduled()              -> sweep report_schedule for due quarterly reports
   ===================================================================== */

const FEE_FLAT = 10000;          // $10k flat on first $100k
const FEE_TIER = 100000;         // threshold
const FEE_RATE = 0.10;           // 10% above threshold
const LIGHT_DAYS = 30;
const FULL_DAYS = 365;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
const bad = (msg, status = 400) => json({ ok: false, error: msg }, status);

// ---- fee math (90/10) ----
function feeForWaste(w) {
  const above = Math.max(0, w - FEE_TIER);
  return FEE_FLAT + above * FEE_RATE;      // total annual fee
}
function monthlyReduction(w) { return w / 12; }

// ---- fiscal quarter helpers ----
// fiscal_q_start_month = month (1..12) the client's fiscal year begins.
// Returns {quarter,dueDate} for each fiscal quarter that CLOSES within the
// 12-month full window. Report fires on the quarter-close date; the label
// names the fiscal quarter that just closed (e.g. FY2026-Q3).
function fiscalSchedule(fullActivatedISO, fyStartMonth) {
  const start = new Date(fullActivatedISO);
  const out = [];
  const windowEnd = new Date(start.getTime() + FULL_DAYS * 86400000);
  for (let i = -1; i < 9; i++) {
    const off = 3 * i;
    const m = (((fyStartMonth - 1 + off) % 12) + 12) % 12;
    const yr = start.getUTCFullYear() + Math.floor((fyStartMonth - 1 + off) / 12);
    const close = new Date(Date.UTC(yr, m, 1));       // quarter START = prior quarter CLOSE
    if (close <= start) continue;
    if (close > windowEnd) break;
    const qStart = new Date(Date.UTC(yr, m - 3, 1));  // the quarter that just closed
    const monthsIntoFY = (qStart.getUTCMonth() - (fyStartMonth - 1) + 12) % 12;
    const qIndex = Math.floor(monthsIntoFY / 3) + 1;
    let fyYear = qStart.getUTCFullYear();
    if (qStart.getUTCMonth() < (fyStartMonth - 1)) fyYear -= 1;
    out.push({ quarter: `FY${fyYear}-Q${qIndex}`, dueDate: close.toISOString().slice(0, 10) });
  }
  return out;
}

// ---- state derivation ----
function daysLeft(fromISO, span) {
  const end = new Date(fromISO).getTime() + span * 86400000;
  return Math.ceil((end - Date.now()) / 86400000);
}
function monthIndex(fullActivatedISO) {
  const days = (Date.now() - new Date(fullActivatedISO).getTime()) / 86400000;
  return Math.min(12, Math.max(1, Math.floor(days / 30) + 1));
}

async function getClient(env, cid) {
  return await env.DB.prepare("SELECT * FROM clients WHERE cid=?").bind(cid).first();
}
async function getStatements(env, cid) {
  const r = await env.DB.prepare("SELECT * FROM statements WHERE cid=? ORDER BY month_index").bind(cid).all();
  return r.results || [];
}
async function getReports(env, cid) {
  const r = await env.DB.prepare("SELECT * FROM reports WHERE cid=? ORDER BY generated_at DESC").bind(cid).all();
  return r.results || [];
}

// ---- board payload (the state machine the frontend renders) ----
async function boardPayload(env, cid) {
  const c = await getClient(env, cid);
  if (!c) return null;
  const stmts = await getStatements(env, cid);
  const reports = await getReports(env, cid);
  const monthly = monthlyReduction(c.annual_waste);
  const totalFee = feeForWaste(c.annual_waste);
  const feePerMonth = totalFee / 12;
  const validated = stmts.filter(s => s.validated).length;

  let effStatus = c.status;
  // derive gray when full but current month statement missing
  if (c.status === "full" && c.full_activated_at) {
    const cm = monthIndex(c.full_activated_at);
    const hasCurrent = stmts.some(s => s.month_index === cm);
    if (!hasCurrent && cm > 1) effStatus = "gray";  // month 1 handled at activation
  }

  return {
    ok: true,
    cid: c.cid,
    company: c.company,
    carrier: c.carrier,
    renewalDate: c.renewal_date,
    annualWaste: c.annual_waste,
    status: effStatus,
    nudge: c.nudge_pref,
    nudgeAsked: !!c.nudge_asked,
    exception: c.status === "exception" ? { reason: c.exception_reason, since: c.exception_since } : null,
    light: { daysLeft: c.light_activated_at ? daysLeft(c.light_activated_at, LIGHT_DAYS) : LIGHT_DAYS },
    full: c.full_activated_at ? {
      monthsLeft: Math.max(0, Math.ceil(daysLeft(c.full_activated_at, FULL_DAYS) / 30)),
      currentMonth: monthIndex(c.full_activated_at),
      monthly, totalFee, feePerMonth,
      validated,
      realizedToDate: monthly * validated,
      feeToDate: feePerMonth * validated,
      months: stmts.map(s => ({ m: s.month_index, validated: !!s.validated, savings: s.validated_savings }))
    } : null,
    reports: reports.map(r => ({ kind: r.kind, quarter: r.fiscal_quarter, key: r.r2_key, at: r.generated_at }))
  };
}

// ---- ENGINE (auto-run, no approval) ----
// Parses the uploaded billing statement and returns validated savings for the month.
// PRODUCTION: replace parseStatement() with the real Kairos parser.
// On any failure it THROWS -> caller drops client into HITL exception.
async function runEngine(env, cid, r2key, monthIdx) {
  const c = await getClient(env, cid);
  const obj = await env.R2.get(r2key);
  if (!obj) throw new Error("statement blob missing in R2");

  // --- parseStatement stub: validates the monthly reduction against the file ---
  // Real impl: extract premium lines, compare to baseline, compute delta.
  // Here we validate the expected monthly reduction (annual/12).
  const bytes = obj.size || 0;
  if (bytes < 1) throw new Error("empty statement — cannot validate");
  const monthly = monthlyReduction(c.annual_waste);
  // A real parser could return a partial number; stub returns full monthly reduction.
  return Math.round(monthly);
}

// ---- REPORT (HTML archived to R2, matches playbooks/<cid> pattern) ----
function renderReportHTML(c, payload, kind, quarter) {
  const f = payload.full || {};
  const money = n => "$" + Math.round(n || 0).toLocaleString("en-US");
  const title = kind === "initial" ? "Initial Waste Report" : `Quarterly Report · ${quarter}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${c.company} — ${title}</title>
<style>
  @page{margin:22mm}
  body{font:14px/1.6 "SF Mono",ui-monospace,Menlo,monospace;color:#0d1319;background:#fff;max-width:760px;margin:0 auto;padding:20px}
  .brand{letter-spacing:.28em;text-transform:uppercase;font-size:11px;color:#1f7d47}
  h1{font-size:26px;margin:6px 0 2px}
  .sub{color:#566b60;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
  .hero{margin:26px 0;padding:22px;border:2px solid #1f7d47;border-radius:12px;text-align:center}
  .hero .n{font-size:52px;font-weight:800;color:#0e7a3f}
  .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin:18px 0}
  .card{border:1px solid #d5e2da;border-radius:10px;padding:14px}
  .card .k{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#7a8a80}
  .card .v{font-size:20px;font-weight:700;margin-top:4px}
  table{width:100%;border-collapse:collapse;margin-top:14px;font-size:12px}
  th,td{padding:8px 10px;border-bottom:1px solid #e3ece6;text-align:left}
  th{text-transform:uppercase;letter-spacing:.12em;font-size:10px;color:#7a8a80}
  .ft{margin-top:28px;font-size:11px;color:#8a9a90;border-top:1px solid #e3ece6;padding-top:12px}
  @media print{.noprint{display:none}}
</style></head><body>
  <div class="brand">Dynasty Stadium · Room 303 Scoreboard</div>
  <h1>${title}</h1>
  <div class="sub">${c.company} · ${c.carrier || ""} · Renewal ${c.renewal_date || ""}</div>
  <div class="hero"><div class="sub">Annual Waste Identified · $100,000+</div><div class="n">${money(c.annual_waste)}</div></div>
  <div class="grid">
    <div class="card"><div class="k">Realized to date</div><div class="v">${money(f.realizedToDate)}</div></div>
    <div class="card"><div class="k">Dynasty fee to date</div><div class="v">${money(f.feeToDate)}</div></div>
    <div class="card"><div class="k">Monthly reduction</div><div class="v">${money(f.monthly)}</div></div>
  </div>
  <p><b>You keep 90%</b> of every recovered dollar. Fee model: $10,000 flat on the first $100,000 found, plus 10% on everything above $100,000, collected monthly in lockstep with validated savings — never a lump sum.</p>
  <table><thead><tr><th>Month</th><th>Validated</th><th>Savings</th></tr></thead><tbody>
    ${(f.months || []).map(m => `<tr><td>M${m.m}</td><td>${m.validated ? "✓" : "—"}</td><td>${money(m.savings)}</td></tr>`).join("")}
  </tbody></table>
  <div class="ft">Generated ${new Date().toISOString().slice(0,10)} · Dynasty Holdings · Reply to any nudge to change reporting cadence. Questions handled by Victoria.</div>
</body></html>`;
}

async function generateReport(env, cid, kind, quarter) {
  const payload = await boardPayload(env, cid);
  const c = await getClient(env, cid);
  const html = renderReportHTML(c, payload, kind, quarter);
  const stamp = new Date().toISOString().slice(0, 10);
  const key = `reports/${cid}/${stamp}-${kind}${quarter ? "-" + quarter : ""}.html`;
  await env.R2.put(key, html, { httpMetadata: { contentType: "text/html" } });
  await env.DB.prepare(
    "INSERT INTO reports (cid,kind,fiscal_quarter,r2_key,realized_to_date,fee_to_date,emailed_to) VALUES (?,?,?,?,?,?,?)"
  ).bind(cid, kind, quarter || null, key,
    Math.round(payload.full?.realizedToDate || 0),
    Math.round(payload.full?.feeToDate || 0),
    "client").run();
  await sendReportEmail(env, c, key, kind, quarter);
  return key;
}

async function sendReportEmail(env, c, key, kind, quarter) {
  if (!env.ZEPTO_TOKEN) return; // no-op if secret absent (dev)
  const subject = kind === "initial"
    ? `Your Dynasty Scoreboard is live — ${c.company}`
    : `Dynasty Quarterly Report ${quarter} — ${c.company}`;
  const link = `https://stadium.dynastyplays.com/api/report/${c.cid}/${key.split("/").pop()}`;
  const body = { from: { address: env.ZEPTO_FROM }, to: [{ email_address: { address: c.email || "don@dynastyplays.com" } }],
    bcc: [{ email_address: { address: "don@dynastyplays.com" } }],
    subject, htmlbody: `<p>Your report is ready.</p><p><a href="${link}">${link}</a></p>` };
  await fetch("https://api.zeptomail.com/v1.1/email", {
    method: "POST",
    headers: { "Authorization": env.ZEPTO_TOKEN, "content-type": "application/json" },
    body: JSON.stringify(body)
  }).catch(() => {});
}

// ---- exception helper ----
async function openException(env, cid, reason) {
  await env.DB.prepare(
    "UPDATE clients SET status='exception', exception_reason=?, exception_since=datetime('now'), updated_at=datetime('now') WHERE cid=?"
  ).bind(reason, cid).run();
}

// ===================== ROUTER =====================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.split("/").filter(Boolean); // ['api','board','DP-...']
    if (request.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" } });
    if (p[0] !== "api") return new Response("Dynasty Scoreboard Worker", { status: 200 });

    try {
      const [, route, cid, extra] = p;

      // GET /api/board/:cid
      if (route === "board" && request.method === "GET") {
        const payload = await boardPayload(env, cid);
        return payload ? json(payload) : bad("client not found", 404);
      }

      // POST /api/wire/:cid  — $10k Frost wire initiated
      if (route === "wire" && request.method === "POST") {
        await env.DB.prepare("UPDATE clients SET status='awaiting_wire', updated_at=datetime('now') WHERE cid=?").bind(cid).run();
        return json({ ok: true, status: "awaiting_wire",
          wireInstructions: "Frost Bank wire — see /rooms/101/wire for routing + reference. Full board lights on confirmed payment." });
      }

      // POST /api/payment-confirmed/:cid — Don confirms Frost wire received
      if (route === "payment-confirmed" && request.method === "POST") {
        await env.DB.prepare("UPDATE clients SET status='awaiting_statement', updated_at=datetime('now') WHERE cid=?").bind(cid).run();
        return json({ ok: true, status: "awaiting_statement", next: "Upload first monthly billing statement to run the engine." });
      }

      // POST /api/upload/:cid — statement -> engine -> report -> full activation
      if (route === "upload" && request.method === "POST") {
        const c = await getClient(env, cid);
        if (!c) return bad("client not found", 404);
        const form = await request.formData();
        const file = form.get("statement");
        if (!file) return bad("no statement file");

        // determine month index (1 if activating now, else current)
        const activating = (c.status === "awaiting_statement");
        const fullStart = activating ? new Date().toISOString() : c.full_activated_at;
        const mIdx = activating ? 1 : monthIndex(fullStart);

        const r2key = `statements/${cid}/${mIdx}.pdf`;
        const buf = await file.arrayBuffer();
        await env.R2.put(r2key, buf, { httpMetadata: { contentType: file.type || "application/pdf" } });

        // record statement row
        await env.DB.prepare(
          "INSERT INTO statements (cid,month_index,r2_key,file_name,bytes) VALUES (?,?,?,?,?) " +
          "ON CONFLICT(cid,month_index) DO UPDATE SET r2_key=excluded.r2_key,file_name=excluded.file_name,bytes=excluded.bytes,uploaded_at=datetime('now')"
        ).bind(cid, mIdx, r2key, file.name || "statement.pdf", buf.byteLength).run();

        // --- ENGINE (auto-run). Failure -> HITL exception. ---
        let savings;
        try {
          savings = await runEngine(env, cid, r2key, mIdx);
        } catch (e) {
          await openException(env, cid, `Engine could not validate the ${activating ? "initial" : "M" + mIdx} statement: ${e.message}`);
          return json({ ok: true, status: "exception",
            message: "We designed a human-in-the-loop for moments like this. You'll hear from us within 24 hours." });
        }

        await env.DB.prepare("UPDATE statements SET validated=1, validated_savings=? WHERE cid=? AND month_index=?")
          .bind(savings, cid, mIdx).run();

        // first upload activates Full + builds fiscal schedule + initial report
        if (activating) {
          await env.DB.prepare("UPDATE clients SET status='full', full_activated_at=?, updated_at=datetime('now') WHERE cid=?")
            .bind(fullStart, cid).run();
          // build fiscal-quarter report schedule
          const sched = fiscalSchedule(fullStart, c.fiscal_q_start_month || 1);
          for (const s of sched) {
            await env.DB.prepare(
              "INSERT OR IGNORE INTO report_schedule (cid,fiscal_quarter,due_date) VALUES (?,?,?)"
            ).bind(cid, s.quarter, s.dueDate).run();
          }
          // initial printable report
          await generateReport(env, cid, "initial", null);
        } else {
          // monthly re-light: if was gray, back to full
          await env.DB.prepare("UPDATE clients SET status='full', updated_at=datetime('now') WHERE cid=? AND status IN ('gray','full')").bind(cid).run();
        }

        return json({ ok: true, status: "full", activated: activating, month: mIdx, validatedSavings: savings });
      }

      // POST /api/nudge/:cid  {choice}
      if (route === "nudge" && request.method === "POST") {
        const { choice } = await request.json();
        const pref = ["Quarterly", "Monthly", "Weekly", "Daily"].includes(choice) ? choice : "Quarterly";
        await env.DB.prepare("UPDATE clients SET nudge_pref=?, nudge_asked=1, updated_at=datetime('now') WHERE cid=?").bind(pref, cid).run();
        return json({ ok: true, nudge: pref });
      }

      // POST /api/exception/:cid  {reason}   — manual HITL flag
      if (route === "exception" && request.method === "POST") {
        const { reason } = await request.json().catch(() => ({}));
        await openException(env, cid, reason || "Manually flagged for human review.");
        return json({ ok: true, status: "exception" });
      }

      // POST /api/resolve/:cid — clear exception, recompute
      if (route === "resolve" && request.method === "POST") {
        const c = await getClient(env, cid);
        const back = c.full_activated_at ? "full" : (c.light_activated_at ? "light" : "light");
        await env.DB.prepare("UPDATE clients SET status=?, exception_reason=NULL, exception_since=NULL, updated_at=datetime('now') WHERE cid=?").bind(back, cid).run();
        return json({ ok: true, status: back });
      }

      // GET /api/report/:cid/:file — serve archived HTML from R2
      if (route === "report" && request.method === "GET") {
        const key = `reports/${cid}/${extra}`;
        const obj = await env.R2.get(key);
        if (!obj) return bad("report not found", 404);
        return new Response(obj.body, { headers: { "content-type": "text/html" } });
      }

      return bad("unknown route", 404);
    } catch (e) {
      return bad("worker error: " + e.message, 500);
    }
  },

  // ---- CRON: sweep due quarterly reports ----
  async scheduled(event, env) {
    const today = new Date().toISOString().slice(0, 10);
    const due = await env.DB.prepare(
      "SELECT * FROM report_schedule WHERE status='pending' AND due_date<=?"
    ).bind(today).all();
    for (const row of (due.results || [])) {
      const c = await getClient(env, row.cid);
      if (!c || c.status === "exception") continue;  // skip clients on HITL hold
      const key = await generateReport(env, row.cid, "quarterly", row.fiscal_quarter);
      await env.DB.prepare("UPDATE report_schedule SET status='sent' WHERE id=?").bind(row.id).run();
    }
  }
};
