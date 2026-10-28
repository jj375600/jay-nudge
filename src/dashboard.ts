import { createHash } from "node:crypto";

/**
 * The owner's dashboard: one static page with no data in it. It asks for the admin token, then fetches
 * /admin/summary with an Authorization header, so the page itself needs no login and the token never goes in a URL.
 * Everything from the server is written with textContent (never innerHTML), and the Content-Security-Policy only
 * allows this exact script (by hash), so injected text can't run.
 */
const STYLE = `
:root{--bg:#070b1a;--card:#0e1530;--line:#1d2850;--text:#e8ecfa;--muted:#8d98bd;--orange:#ff6b1a;--green:#35c27a;--red:#e5534b;--blue:#5b8def}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px 64px}
h1{margin:0;font-size:1.5rem;letter-spacing:.04em;text-transform:uppercase}h1 span{color:var(--orange)}
.sub{color:var(--muted);margin:.25rem 0 1.5rem}
h2{font-size:.8rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:2rem 0 .75rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat b{display:block;font-size:1.9rem;line-height:1.1}.stat span{color:var(--muted);font-size:.85rem}
.row{display:grid;grid-template-columns:minmax(120px,1.2fr) 2fr auto;gap:12px;align-items:center;padding:12px 16px;border-top:1px solid var(--line)}
.row:first-child{border-top:0}.who b{display:block}.who span{color:var(--muted);font-size:.82rem}
.strip{display:flex;gap:4px}.d{width:18px;height:18px;border-radius:5px;background:#18214a}
.d.completed{background:var(--green)}.d.missed{background:var(--red)}.d.skipped{background:var(--blue)}.d.pending{background:#3a4575}
.streak{text-align:right;white-space:nowrap}.streak b{font-size:1.25rem;color:var(--orange)}.streak span{display:block;color:var(--muted);font-size:.78rem}
.tag{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:99px;background:#3a1d1d;color:#ff9b94;font-size:.72rem}
.msg{display:grid;grid-template-columns:130px 1fr auto;gap:10px;padding:10px 16px;border-top:1px solid var(--line);font-size:.9rem}
.msg:first-child{border-top:0}.msg .dir{color:var(--muted)}.msg .st{color:var(--muted);font-size:.8rem}.msg .body{overflow-wrap:anywhere}
.legend{display:flex;flex-wrap:wrap;gap:14px;color:var(--muted);font-size:.8rem;margin-top:10px}.legend i{display:inline-block;width:12px;height:12px;border-radius:4px;margin-right:6px;vertical-align:-1px}
form{display:flex;gap:8px;flex-wrap:wrap;margin:1rem 0}input{flex:1;min-width:220px;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit}
button{padding:10px 18px;border:0;border-radius:8px;background:var(--orange);color:#1a0b02;font:inherit;font-weight:700;cursor:pointer}
.err{color:#ff9b94;min-height:1.4em}.empty{padding:16px;color:var(--muted)}
@media(max-width:560px){.row{grid-template-columns:1fr auto}.strip{grid-column:1/3;order:3}}
`;

const SCRIPT = `
"use strict";
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
let token = "";
try { token = sessionStorage.getItem("nudge-admin") || ""; } catch {}

function stat(value, label) { const c = el("div", "card stat"); c.append(el("b", "", String(value)), el("span", "", label)); return c; }

function render(s) {
  const stats = $("stats"); stats.replaceChildren(
    stat(s.contacts.total - s.contacts.optedOut, "clients getting texts"),
    stat(s.contacts.optedOut, "opted out"),
    stat((s.messagesLast24h.sent || 0) + (s.messagesLast24h.delivered || 0), "texts sent, last 24h"),
    stat(s.checkinsRecent.completed || 0, "workouts logged, last 2 days"),
    stat(s.scheduleQueue.delayed || 0, "check-ins and reminders queued"),
    stat((s.messagesLast24h.failed || 0) + (s.messagesLast24h.undelivered || 0), "failed, last 24h"));

  const list = $("clients"); list.replaceChildren();
  if (!s.clients.length) list.append(el("div", "empty", "No clients yet."));
  for (const c of s.clients) {
    const row = el("div", "row"); const who = el("div", "who"); const name = el("b", "", c.name);
    if (c.optedOut) name.append(el("span", "tag", "opted out"));
    who.append(name, el("span", "", c.phone + " · " + c.timezone.replace("_", " ")));
    const strip = el("div", "strip"); strip.setAttribute("role", "img");
    strip.setAttribute("aria-label", "Last 14 days: " + c.days.map((d) => d).join(", "));
    for (const d of c.days) { const dot = el("span", "d " + d); dot.title = d; strip.append(dot); }
    const streak = el("div", "streak"); streak.append(el("b", "", c.current + " day" + (c.current === 1 ? "" : "s")), el("span", "", "best " + c.best + " · " + c.last7 + " of last 7"));
    row.append(who, strip, streak); list.append(row);
  }

  const log = $("recent"); log.replaceChildren();
  if (!s.recent.length) log.append(el("div", "empty", "No messages yet."));
  for (const m of s.recent) {
    const row = el("div", "msg"); row.append(el("span", "dir", m.direction === "inbound" ? "← " + (m.phone || "?") : "→ " + (m.phone || "?")), el("span", "body", m.body), el("span", "st", m.status));
    log.append(row);
  }
  $("updated").textContent = "Updated " + new Date().toLocaleTimeString();
}

async function load() {
  $("err").textContent = "";
  try {
    const res = await fetch("/admin/summary", { headers: { Authorization: "Bearer " + token } });
    if (res.status === 401) { $("err").textContent = "That token isn't right."; $("login").hidden = false; $("dash").hidden = true; return; }
    if (!res.ok) throw new Error("status " + res.status);
    render(await res.json());
    $("login").hidden = true; $("dash").hidden = false;
    try { sessionStorage.setItem("nudge-admin", token); } catch {}
  } catch (e) { $("err").textContent = "Could not load: " + e.message; }
}

$("login").addEventListener("submit", (e) => { e.preventDefault(); token = $("token").value.trim(); $("token").value = ""; load(); });
$("refresh").addEventListener("click", load);
if (token) load();
`;

const BODY = `<main>
<h1>JAY-<span>NUDGE</span></h1>
<p class="sub">Text-message accountability bot · owner dashboard (read-only; phone numbers are masked)</p>
<form id="login"><label for="token" hidden>Admin token</label><input id="token" type="password" autocomplete="off" placeholder="Admin token" required><button>Open dashboard</button></form>
<p class="err" id="err" role="alert"></p>
<div id="dash" hidden>
  <div class="grid" id="stats"></div>
  <h2>Clients and their last 14 days</h2>
  <div class="card" style="padding:0" id="clients"></div>
  <div class="legend"><span><i style="background:#35c27a"></i>worked out</span><span><i style="background:#5b8def"></i>rest day</span><span><i style="background:#e5534b"></i>missed</span><span><i style="background:#3a4575"></i>waiting for reply</span><span><i style="background:#18214a"></i>no check-in</span></div>
  <h2>Latest messages</h2>
  <div class="card" style="padding:0" id="recent"></div>
  <p class="sub"><span id="updated"></span> <button id="refresh" type="button" style="margin-left:8px;padding:4px 12px;font-size:.85rem">Refresh</button></p>
</div>
</main>`;

const scriptHash = createHash("sha256").update(SCRIPT).digest("base64");

export const DASHBOARD_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${scriptHash}'`,
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>JAY-NUDGE dashboard</title><style>${STYLE}</style></head>
<body>${BODY}<script>${SCRIPT}</script></body></html>`;
