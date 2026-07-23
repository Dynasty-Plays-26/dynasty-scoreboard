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

const FEE_OWNER_SHARE = 0.80;   // owner keeps 80% of RECOVERED dollars
const FEE_DYNASTY_SHARE = 0.20;  // Dynasty 20% of RECOVERED only (joined at the hip)
const FEE_ACTIVATION = 10000;   // $10k Tier-1 gate when waste ≥ $100k — stands either way
const FEE_WASTE_GATE = 100000;  // minimum staged waste to invite T1 activation
const LIGHT_DAYS = 30;
const FULL_DAYS = 365;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
const bad = (msg, status = 400) => json({ ok: false, error: msg }, status);

// ---- fee math (two-layer · owner-first) ----
// Layer 1 — ACTIVATION: waste ≥ $100k → $10k flat Tier-1. Identify · analyze · report.
//           Owner holds the recovery switch (ads + disads). $10k STANDS if they never recover.
// Layer 2 — RECOVERY: only if owner recovers. Dynasty 20% of recovered $ · owner keeps 80%.
//           Joined at the hip on recovered dollars only. This is about the owner, not Dynasty.
// feeForWaste(w) = projected Dynasty share IF the full staged amount is recovered (not a bill on staging).
function feeForWaste(w) {
  return Math.round((Number(w) || 0) * FEE_DYNASTY_SHARE);
}
function activationDue(w) {
  return (Number(w) || 0) >= FEE_WASTE_GATE ? FEE_ACTIVATION : 0;
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
// Parses the uploaded billing statement and returns validated monthly savings.
// CONTRACT: return a positive integer (validated monthly premium reduction) on success,
// or THROW on any problem -> caller drops the client into the 24-hour HITL exception.
// This keeps a bad/unreadable statement from ever lighting the board with a wrong number.
//
// v0 parser: pulls text out of the uploaded PDF, finds the current-period premium
// total, compares it to the client's stored baseline premium, and derives the realized
// monthly reduction. A sanity band guards against plausible-but-wrong figures.
// Hand-off: swap extractText()/findPremiumTotal() for the Kairos carrier-format parser;
// the throw->HITL contract below must be preserved.

const SANITY_BAND = 0.15; // realized reduction must land within +/-15% of expected

async function runEngine(env, cid, r2key, monthIdx) {
  const c = await getClient(env, cid);
  if (!c) throw new Error("client record not found");
  const obj = await env.R2.get(r2key);
  if (!obj) throw new Error("statement blob missing in R2");

  const buf = new Uint8Array(await obj.arrayBuffer());
  if (buf.byteLength < 1024) throw new Error("statement too small to be a real billing PDF");

  const contentType = (obj.httpMetadata && obj.httpMetadata.contentType) || "";
  const looksPdf = buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
  if (!looksPdf && !/pdf/i.test(contentType)) throw new Error("uploaded file is not a PDF billing statement");

  const text = await extractText(buf);
  if (!text || text.replace(/\s/g, "").length < 40) {
    throw new Error("could not extract readable text (scanned/encrypted PDF -> needs OCR)");
  }

  // Confirm this statement belongs to the plan: carrier or company must appear.
  const hay = text.toLowerCase();
  const carrierHit = c.carrier && hay.includes(c.carrier.toLowerCase().split(" ")[0]);
  const companyHit = c.company && hay.includes(c.company.toLowerCase().split(" ")[0]);
  if (!carrierHit && !companyHit) {
    throw new Error("statement does not reference the client carrier or company");
  }

  const currentPremium = findPremiumTotal(text);
  if (currentPremium == null) throw new Error("no premium/amount-due total found on statement");

  // Baseline: the pre-optimization monthly premium the plan started at.
  // baseline_monthly_premium is seeded on the client record at renewal intake.
  const baseline = Number(c.baseline_monthly_premium) || 0;
  if (baseline <= 0) throw new Error("no baseline monthly premium on record to compare against");

  const realized = baseline - currentPremium;
  if (realized <= 0) throw new Error(`no reduction detected (current ${currentPremium} >= baseline ${baseline})`);

  // Sanity band: realized must be near the expected monthly reduction (annual waste / 12).
  const expected = monthlyReduction(c.annual_waste);
  const lo = expected * (1 - SANITY_BAND), hi = expected * (1 + SANITY_BAND);
  if (realized < lo || realized > hi) {
    throw new Error(`realized reduction ${Math.round(realized)} outside sanity band [${Math.round(lo)}, ${Math.round(hi)}] for expected ${Math.round(expected)}`);
  }

  return Math.round(realized);
}

// PDF text extraction. Decompresses FlateDecode content streams (the common case)
// via DecompressionStream, then pulls text from Tj/TJ show operators. Falls back to
// reading uncompressed streams directly. Returns "" when nothing readable is found
// (scanned/encrypted PDFs), which runEngine treats as a HITL trigger.
async function extractText(bytes) {
  const latin = new TextDecoder("latin1").decode(bytes);
  let corpus = "";

  // Walk every `stream ... endstream` block. Inflate FlateDecode; keep raw otherwise.
  const streamRe = /stream\r?\n/g;
  let sm;
  while ((sm = streamRe.exec(latin)) !== null) {
    const start = sm.index + sm[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) continue;
    let raw = bytes.subarray(start, end);
    // Inspect the dictionary preceding this stream for its filter chain.
    const dictHead = latin.slice(Math.max(0, sm.index - 260), sm.index);
    try {
      // Filters apply in order; ASCII85/ASCIIHex first, then Flate.
      if (/ASCII85Decode/.test(dictHead)) raw = ascii85Decode(raw);
      else if (/ASCIIHexDecode/.test(dictHead)) raw = asciiHexDecode(raw);
      if (/FlateDecode/.test(dictHead)) corpus += await inflate(raw) + " ";
      else corpus += new TextDecoder("latin1").decode(raw) + " ";
    } catch (_) { /* skip unreadable stream */ }
  }
  if (!corpus) corpus = latin; // no stream markers -> scan whole file

  // Pull text out of show operators in the (now decompressed) content.
  let out = "";
  const showRe = /\((?:\\.|[^\\()])*\)\s*Tj|\[(?:[^\]]*)\]\s*TJ/g;
  let m;
  while ((m = showRe.exec(corpus)) !== null) {
    const strRe = /\(((?:\\.|[^\\()])*)\)/g;
    let s;
    while ((s = strRe.exec(m[0])) !== null) {
      out += s[1].replace(/\\([()\\])/g, "$1").replace(/\\[nr]/g, " ") + " ";
    }
  }
  // Fallback: any parenthesized literal in the decompressed corpus.
  if (out.replace(/\s/g, "").length < 40) {
    const litRe = /\(((?:\\.|[^\\()]){2,})\)/g;
    let l;
    while ((l = litRe.exec(corpus)) !== null) out += l[1].replace(/\\([()\\])/g, "$1") + " ";
  }
  return out;
}

// ASCII85 decode (PDF variant: whitespace ignored, 'z' -> 4 zero bytes, ~> terminator).
function ascii85Decode(u8) {
  const s = new TextDecoder("latin1").decode(u8);
  const out = [];
  let tuple = 0, count = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "~") break;
    if (/\s/.test(ch)) continue;
    if (ch === "z" && count === 0) { out.push(0, 0, 0, 0); continue; }
    const v = ch.charCodeAt(0) - 33;
    if (v < 0 || v > 84) continue;
    tuple = tuple * 85 + v; count++;
    if (count === 5) {
      out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255);
      tuple = 0; count = 0;
    }
  }
  if (count > 0) {
    for (let k = count; k < 5; k++) tuple = tuple * 85 + 84;
    const bytesOut = count - 1;
    const b = [(tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255];
    for (let k = 0; k < bytesOut; k++) out.push(b[k]);
  }
  return new Uint8Array(out);
}

// ASCIIHex decode (PDF: hex pairs, whitespace ignored, > terminator).
function asciiHexDecode(u8) {
  const s = new TextDecoder("latin1").decode(u8).replace(/\s/g, "");
  const hex = s.slice(0, s.indexOf(">") >= 0 ? s.indexOf(">") : s.length);
  const padded = hex.length % 2 ? hex + "0" : hex;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.substr(i * 2, 2), 16);
  return out;
}

// Inflate a zlib/deflate byte range using the runtime DecompressionStream.
// Tries zlib ("deflate") first, then raw ("deflate-raw").
async function inflate(u8) {
  for (const fmt of ["deflate", "deflate-raw"]) {
    try {
      const ds = new DecompressionStream(fmt);
      const stream = new Response(u8).body.pipeThrough(ds);
      const out = await new Response(stream).arrayBuffer();
      const txt = new TextDecoder("latin1").decode(new Uint8Array(out));
      if (txt && txt.length) return txt;
    } catch (_) { /* try next format */ }
  }
  throw new Error("inflate failed");
}

// Find the billing period's premium / amount-due total.
// Prefers labeled lines; falls back to the largest currency figure on the page.
function findPremiumTotal(text) {
  const norm = text.replace(/\u00a0/g, " ");
  const labels = [
    /total\s+amount\s+due[^0-9$]*\$?\s*([0-9][0-9,]*\.?[0-9]{0,2})/i,
    /total\s+premium[^0-9$]*\$?\s*([0-9][0-9,]*\.?[0-9]{0,2})/i,
    /amount\s+due[^0-9$]*\$?\s*([0-9][0-9,]*\.?[0-9]{0,2})/i,
    /current\s+charges[^0-9$]*\$?\s*([0-9][0-9,]*\.?[0-9]{0,2})/i,
    /premium\s+total[^0-9$]*\$?\s*([0-9][0-9,]*\.?[0-9]{0,2})/i,
  ];
  for (const re of labels) {
    const m = norm.match(re);
    if (m) {
      const v = Number(m[1].replace(/,/g, ""));
      if (isFinite(v) && v > 0) return v;
    }
  }
  // Fallback: largest $-amount that looks like a monthly premium (>= $1,000).
  const nums = [...norm.matchAll(/\$\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{2})?|[0-9]{4,}(?:\.[0-9]{2})?)/g)]
    .map(x => Number(x[1].replace(/,/g, "")))
    .filter(v => isFinite(v) && v >= 1000);
  if (nums.length) return Math.max(...nums);
  return null;
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
  <p><b>This is about you, not Dynasty.</b> Tier-1 activation is a <b>$10,000</b> flat fee when waste is $100,000+ — paid so we identify, analyze, and report. You hold the recovery switch. The $10,000 stands whether you recover or not. <b>Only if you recover</b> do we join at the hip: you keep <b>80%</b> of every recovered dollar; Dynasty takes <b>20%</b> of recovered only, collected monthly in lockstep — never a lump sum.</p>
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
