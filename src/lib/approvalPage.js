/**
 * The phone approval page: GET /approve/:id?exp=…&sig=…
 *
 * Opened from a Pushover notification. No Mission Control key needed: the link's
 * signature (choice "view") proves it came from the brain, and the page carries one
 * signed decide link per choice, all with the same 7-day expiry. Deciding still goes
 * through POST /api/approvals/:id/decide, so a decision is recorded once, ever.
 */
import { getApproval, signDecision, verifyDecisionSig } from "./approvals.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer", // the URL carries signatures; don't hand it to anyone
  "x-robots-tag": "noindex",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; connect-src 'self'",
};

/** Shared shell for the small signed phone pages (approvals, KFB messages). */
export function page(title, inner, status = 200, extraCss = "") {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap">
<style>
:root{--bg:#0b0b0d;--panel:#131316;--panel2:#17171b;--border:#26262b;--text:#e8e8ea;--muted:#8a8a93;--faint:#54545c;--accent:#c7d2db;--good:#6bbf8a;--warn:#c9a36b;--bad:#c97b7b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Inter,system-ui,sans-serif;padding:24px 16px}
main{max-width:520px;margin:0 auto}h1{font-size:18px;font-weight:600;margin:0 0 4px}
.meta{color:var(--muted);font-size:12.5px;margin-bottom:18px}
.opt{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px}
.opt b{display:block;margin-bottom:2px}.opt span{color:var(--muted);font-size:13px}
button{width:100%;margin-top:10px;padding:11px;border-radius:8px;border:1px solid var(--border);background:var(--panel2);color:var(--accent);font:600 14px Inter,system-ui,sans-serif}
button.no{color:var(--bad)}button:disabled{opacity:.4}
.done{padding:14px;border-radius:10px;background:var(--panel);border:1px solid var(--border)}
.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
${extraCss}</style></head><body><main>${inner}</main></body></html>`;
  return new Response(html, { status, headers: HEADERS });
}

export async function handleApprovalPage(request, env, id) {
  const url = new URL(request.url);
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  const ap = await getApproval(env.DB, id);
  // Same answer for "no such approval" and "bad link": don't confirm what exists.
  if (!ap || !(await verifyDecisionSig(env.APPROVAL_SIGNING_KEY, ap, "view", sig, exp))) {
    return page("Link not valid", `<h1>This link isn't valid</h1><div class="meta">It may have expired (links last 7 days). Open Mission Control to decide instead.</div>`, 403);
  }
  if (ap.status !== "pending") {
    const label = ap.choice === "reject" ? "Rejected" : (ap.options.find((o) => o.id === ap.choice) || {}).label || ap.status;
    return page("Already decided", `<h1>${esc(ap.title)}</h1><div class="done">Already decided: <b>${esc(label)}</b> <span class="meta">(${esc(ap.status)})</span></div>`);
  }
  const choices = [...ap.options.map((o) => ({ id: o.id, label: o.label, detail: o.detail })), { id: "reject", label: "Reject" }];
  const buttons = [];
  for (const c of choices) {
    const s = await signDecision(env.APPROVAL_SIGNING_KEY, ap, c.id, Number(exp));
    const action = `/api/approvals/${ap.id}/decide?choice=${encodeURIComponent(c.id)}&exp=${encodeURIComponent(exp)}&sig=${s}`;
    buttons.push(c.id === "reject"
      ? `<button class="no" data-a="${esc(action)}">Reject</button>`
      : `<div class="opt"><b>${esc(c.label)}</b>${c.detail ? `<span>${esc(c.detail)}</span>` : ""}<button data-a="${esc(action)}">Choose this</button></div>`);
  }
  const inner = `<h1>${esc(ap.title)}</h1>
<div class="meta">${esc(ap.dept)}${ap.store ? " · " + esc(ap.store.toUpperCase()) : ""} · requested ${esc(ap.created_at.slice(0, 16).replace("T", " "))} UTC</div>
<div id="choices">${buttons.join("")}</div><div id="out"></div>
<script>
document.querySelectorAll("button[data-a]").forEach(function(b){
  b.addEventListener("click", async function(){
    document.querySelectorAll("button").forEach(function(x){x.disabled=true});
    var out=document.getElementById("out");
    try{
      var r=await fetch(b.dataset.a,{method:"POST"}); var j=await r.json();
      document.getElementById("choices").hidden=true;
      out.innerHTML=j.ok?'<div class="done good">Recorded: '+(j.status==="rejected"?"Rejected":"Approved")+'</div>'
        :'<div class="done warn">Not recorded: '+String(j.error||r.status).replace(/[<>&]/g,"")+'</div>';
    }catch(e){ out.innerHTML='<div class="done bad">Couldn\\'t reach the brain. Nothing was recorded; try again.</div>'; document.querySelectorAll("button").forEach(function(x){x.disabled=false}); }
  });
});
</script>`;
  return page(ap.title, inner);
}
