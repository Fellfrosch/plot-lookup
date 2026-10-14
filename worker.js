// Cloudflare Worker — справка за поземлен имот + лог на търсенията.
//
// Един Worker обслужва всичко на един адрес (напр. https://plot-lookup.<акаунт>.workers.dev):
//   GET  /  , /index.html, /core.js        -> страницата (взема се от GitHub репото, PAGE_SOURCE)
//   GET  /isofmap?SERVICE=WMS|WFS&REQUEST=…  -> прокси към http://www.isofmap.bg/owsmap
//   GET  /kais?id=44063.6207.271[&miss=3]    -> КАИС имот + сгради (суров HTML на панела)
//   POST /log    {"plot":"68134.1107.331"}   -> записва търсене: имот, имейл, време
//   GET  /admin  [?email=…&plot=…&days=30&format=csv] -> списък с търсенията, само за ADMIN_EMAIL
//   GET  /health                             -> проверка, че Worker-ът работи
//
// Защо Worker: iSofMap е само по http (браузърът блокира такива заявки от https страница),
// а КАИС иска сесия и CSRF токен. Цялата обработка на данните е в браузъра (core.js).
//
// Вход: Cloudflare Access (One-time PIN по имейл) пред целия адрес. Worker-ът сам проверява
// подписа на Access токена, така че имейлът в лога не може да бъде подправен.
//
// Bindings и променливи (Settings → Bindings / Variables and Secrets):
//   DB              – D1 база (binding с име DB)
//   TEAM_DOMAIN     – напр. all1studio.cloudflareaccess.com
//   POLICY_AUD      – AUD tag на Access приложението (няколко — разделени със запетая)
//   ADMIN_EMAIL     – единственият имейл с достъп до /admin (по-добре като Secret)
//   PAGE_SOURCE     – откъде да се взема страницата; по подразбиране GitHub репото по-долу
//   RETENTION_DAYS  – след колко дни записите се трият (по подразбиране 365)
// Когато TEAM_DOMAIN и POLICY_AUD са зададени, всяка заявка без валиден вход се отказва.

const PAGE_SOURCE_DEFAULT = "https://raw.githubusercontent.com/fellfrosch/plot-lookup/main";
const PAGE_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/core.js": ["core.js", "text/javascript; charset=utf-8"],
};

const ISO_BASES = ["http://www.isofmap.bg", "http://isofmap.bg"];
const KAIS = "https://kais.cadastre.bg";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const PLOT_RE = /^\d{5}\.\d{1,5}\.\d{1,5}$/;
const LOG_RE = /^\d{5}\.\d{1,5}\.\d{1,5}(\.\d{1,3})?$/;
const ISO_SERVICES = new Set(["WMS", "WFS"]);
const ISO_REQUESTS = new Set(["GetFeature", "GetFeatureInfo", "GetCapabilities"]);
// Безплатният план позволява 50 подзаявки на извикване; оставяме резерв.
const KAIS_BUDGET = 46;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      // ---- вход ----
      const accessOn = Boolean(env.TEAM_DOMAIN && env.POLICY_AUD);
      const email = accessOn ? await verifiedEmail(req, env) : null;
      if (accessOn && !email) {
        return text("Нужен е вход с разрешен имейл. Презаредете страницата.", 401);
      }

      // ---- страницата ----
      if (req.method === "GET" && PAGE_FILES[url.pathname]) return await page(url.pathname, env);
      if (url.pathname === "/health") return json({ ok: true, service: "plot-lookup", access: accessOn });

      // ---- данни ----
      if (req.method === "GET" && url.pathname === "/isofmap") return await isofmap(url);
      if (req.method === "GET" && url.pathname === "/kais") return await kais(url);

      // ---- лог ----
      if (req.method === "POST" && url.pathname === "/log") {
        if (!email) return json({ error: "Записът изисква вход през Cloudflare Access" }, 401);
        if (!env.DB) return json({ error: "Няма D1 binding с име DB" }, 500);
        const { plot } = await req.json().catch(() => ({}));
        if (typeof plot !== "string" || !LOG_RE.test(plot.trim())) {
          return json({ error: "Невалиден идентификатор на имот" }, 400);
        }
        await env.DB.prepare("INSERT INTO searches (plot, email, ts) VALUES (?, ?, ?)")
          .bind(plot.trim(), email, Math.floor(Date.now() / 1000)).run();
        return json({ ok: true });
      }

      if (req.method === "GET" && url.pathname === "/admin") {
        const adminEmail = String(env.ADMIN_EMAIL || "").trim().toLowerCase();
        if (!email || !adminEmail || email !== adminEmail) return text("Нямате достъп до тази страница.", 403);
        return await admin(url, env);
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  },

  // Ежедневно изтриване на стари записи (Cron Trigger, напр. "0 3 * * *")
  async scheduled(_event, env) {
    if (!env.DB) return;
    const days = parseInt(env.RETENTION_DAYS || "365", 10);
    await env.DB.prepare("DELETE FROM searches WHERE ts < ?")
      .bind(Math.floor(Date.now() / 1000) - days * 86400).run();
  },
};

// ---------------- помощни ----------------
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function text(t, status = 200) {
  return new Response(t, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (ts) => new Date(ts * 1000).toLocaleString("bg-BG", { timeZone: "Europe/Sofia" });

// ---------------- страницата от GitHub ----------------
async function page(path, env) {
  const [file, type] = PAGE_FILES[path];
  const base = String(env.PAGE_SOURCE || PAGE_SOURCE_DEFAULT).replace(/\/+$/, "");
  // Кеш 5 минути: промяна в GitHub се вижда до 5 мин. след commit.
  const r = await fetch(`${base}/${file}`, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!r.ok) return text(`Страницата не може да се зареди от ${base}/${file} (HTTP ${r.status}).`, 502);
  return new Response(r.body, {
    headers: { "Content-Type": type, "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff" },
  });
}

// ---------------- Cloudflare Access JWT ----------------
let certs = { keys: null, at: 0 };

async function accessKeys(env) {
  if (certs.keys && Date.now() - certs.at < 3600_000) return certs.keys;
  const r = await fetch(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error("Access certs unavailable");
  certs = { keys: (await r.json()).keys, at: Date.now() };
  return certs.keys;
}

function b64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// Връща потвърдения имейл или null. Проверява подписа, аудиторията, издателя и срока.
export async function verifiedEmail(req, env) {
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  try {
    const dec = new TextDecoder();
    const header = JSON.parse(dec.decode(b64url(h)));
    const payload = JSON.parse(dec.decode(b64url(p)));
    const jwk = (await accessKeys(env)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const allowedAud = String(env.POLICY_AUD || "").split(",").map((s) => s.trim()).filter(Boolean);
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.some((a) => allowedAud.includes(a))) return null;
    if (payload.iss !== `https://${env.TEAM_DOMAIN}`) return null;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload.email ? String(payload.email).toLowerCase() : null;
  } catch {
    return null;
  }
}

// ---------------- /admin ----------------
async function admin(url, env) {
  if (!env.DB) return text("Няма D1 binding с име DB.", 500);
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const plot = (url.searchParams.get("plot") || "").trim();
  const days = parseInt(url.searchParams.get("days") || "0", 10);

  const where = [], binds = [];
  if (email) { where.push("email LIKE ?"); binds.push(`%${email}%`); }
  if (plot) { where.push("plot LIKE ?"); binds.push(`${plot}%`); }
  if (days > 0) { where.push("ts >= ?"); binds.push(Math.floor(Date.now() / 1000) - days * 86400); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows, top, users] = await env.DB.batch([
    env.DB.prepare(`SELECT plot, email, ts FROM searches ${w} ORDER BY ts DESC LIMIT 1000`).bind(...binds),
    env.DB.prepare(`SELECT plot, COUNT(*) AS n, COUNT(DISTINCT email) AS users, MAX(ts) AS last
                    FROM searches ${w} GROUP BY plot ORDER BY n DESC, last DESC LIMIT 20`).bind(...binds),
    env.DB.prepare(`SELECT email, COUNT(*) AS n, COUNT(DISTINCT plot) AS plots, MAX(ts) AS last
                    FROM searches ${w} GROUP BY email ORDER BY n DESC LIMIT 50`).bind(...binds),
  ]);

  if (url.searchParams.get("format") === "csv") {
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = ["plot,email,time"]
      .concat(rows.results.map((r) => [r.plot, r.email, fmt(r.ts)].map(q).join(",")))
      .join("\n");
    return new Response("﻿" + csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="searches.csv"',
        "Cache-Control": "no-store",
      },
    });
  }

  const csvLink = new URL(url); csvLink.searchParams.set("format", "csv");
  const html = `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Търсения на имоти</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 1.5rem; color: #1d2329; background: #fff; }
  h1 { font-size: 1.25rem; } h2 { font-size: 1rem; margin-top: 2rem; }
  form { display: flex; flex-wrap: wrap; gap: .5rem; align-items: end; }
  label { display: grid; gap: .2rem; font-size: .8rem; }
  input, button { font: inherit; padding: .35rem .5rem; }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; font-size: .875rem; min-width: 32rem; }
  th, td { text-align: left; padding: .35rem .75rem .35rem 0; border-bottom: 1px solid #e3e6e8; }
  th { font-weight: 600; }
  td a { color: inherit; }
  .muted { color: #5b6670; font-size: .85rem; }
</style></head><body>
<h1>Търсения на имоти</h1>
<form>
  <label>Имейл <input name="email" value="${esc(email)}"></label>
  <label>Имот <input name="plot" value="${esc(plot)}" placeholder="68134.1107"></label>
  <label>Последните дни <input name="days" type="number" min="0" value="${days || ""}"></label>
  <button>Филтрирай</button> <a href="/admin">Изчисти</a> <a href="${esc(csvLink.pathname + csvLink.search)}">Свали CSV</a> <a href="/">Към справката</a>
</form>
<h2>Потребители</h2>
<div class="wrap"><table><tr><th>Имейл</th><th>Търсения</th><th>Различни имоти</th><th>Последно</th></tr>
${users.results.map((r) => `<tr><td><a href="/admin?email=${encodeURIComponent(r.email)}">${esc(r.email)}</a></td><td>${r.n}</td><td>${r.plots}</td><td>${fmt(r.last)}</td></tr>`).join("")}
</table></div>
<h2>Най-търсени имоти</h2>
<div class="wrap"><table><tr><th>Имот</th><th>Търсения</th><th>Потребители</th><th>Последно</th></tr>
${top.results.map((r) => `<tr><td><a href="/?id=${encodeURIComponent(r.plot)}">${esc(r.plot)}</a></td><td>${r.n}</td><td>${r.users}</td><td>${fmt(r.last)}</td></tr>`).join("")}
</table></div>
<h2>Всички търсения</h2>
<p class="muted">Показани ${rows.results.length} записа (до 1000, най-новите първо).</p>
<div class="wrap"><table><tr><th>Време</th><th>Имот</th><th>Имейл</th></tr>
${rows.results.map((r) => `<tr><td>${fmt(r.ts)}</td><td><a href="/?id=${encodeURIComponent(r.plot)}">${esc(r.plot)}</a></td><td>${esc(r.email)}</td></tr>`).join("")}
</table></div>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// ---------------- iSofMap ----------------
async function isofmap(url) {
  const q = url.searchParams;
  const svc = (q.get("SERVICE") || "").toUpperCase();
  const op = q.get("REQUEST") || "";
  if (!ISO_SERVICES.has(svc) || !ISO_REQUESTS.has(op)) {
    return json({ error: "Only WMS/WFS GetFeature, GetFeatureInfo and GetCapabilities are proxied" }, 400);
  }
  let last = "";
  for (const base of ISO_BASES) {
    try {
      const r = await fetch(`${base}/owsmap?${q.toString()}`, {
        headers: { "User-Agent": UA, "Accept-Language": "bg,en;q=0.8" },
      });
      if (r.status >= 500) { last = `${base}: HTTP ${r.status}`; continue; }
      const body = await r.arrayBuffer();
      return new Response(body, {
        status: r.status,
        headers: {
          // iSofMap не винаги декларира charset; съдържанието е UTF-8.
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "private, max-age=3600",
        },
      });
    } catch (e) {
      last = `${base}: ${e.message || e}`;
    }
  }
  return json({ error: `iSofMap unreachable — ${last}` }, 502);
}

// ---------------- КАИС ----------------
class Budget extends Error {}

async function kais(url) {
  const id = (url.searchParams.get("id") || "").trim();
  if (!PLOT_RE.test(id)) return json({ error: "Invalid id. Expected ЕКАТТЕ.район.имот" }, 400);
  const miss = Math.min(6, Math.max(1, parseInt(url.searchParams.get("miss") || "3", 10) || 3));

  const jar = {};
  let budget = KAIS_BUDGET;
  const xhr = { "X-Requested-With": "XMLHttpRequest", Referer: `${KAIS}/bg/Map` };

  const go = async (path, opts = {}) => {
    if (--budget < 0) throw new Budget();
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await fetch(KAIS + path, {
      ...opts,
      headers: { "User-Agent": UA, "Accept-Language": "bg,en;q=0.8", ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
    });
    const sc = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
    for (const c of sc) {
      const nv = c.split(";")[0];
      const i = nv.indexOf("=");
      if (i > 0) jar[nv.slice(0, i).trim()] = nv.slice(i + 1).trim();
    }
    return r;
  };

  // 1. Сесия + CSRF токен от страницата на картата.
  let tok = null;
  for (let attempt = 0; attempt < 2 && !tok; attempt++) {
    const html = await (await go("/bg/Map")).text();
    const m = html.match(/name="__RequestVerificationToken"[^>]*?value="([^"]+)"/) ||
              html.match(/value="([^"]+)"[^>]*?name="__RequestVerificationToken"/);
    if (m) tok = m[1];
  }
  if (!tok) return json({ error: "КАИС: no __RequestVerificationToken on /bg/Map" }, 502);

  // 2. FastSearch пази търсенето в сесията; ReadFoundObjects го връща.
  const find = async (kw) => {
    const p = new URLSearchParams({ KeyWords: kw, ServiceObjectHash: "", LimitSearchExtent: "false",
      LimitResultCount: "false", _: String(Date.now()) });
    await (await go(`/bg/Map/FastSearch?${p}`, { headers: xhr })).text();
    const r = await go("/bg/Map/ReadFoundObjects", {
      method: "POST",
      headers: { ...xhr, "X-CSRF-TOKEN": tok, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "sort=&page=1&pageSize=50&group=&filter=",
    });
    const t = await r.text();
    if (!t.trim()) return [];
    let data;
    try { data = JSON.parse(t).Data || []; }
    catch { throw new Error(`КАИС: unexpected ReadFoundObjects response: ${t.slice(0, 120)}`); }
    return data.filter((d) => d.Number === kw);
  };

  // 3. GetObjectInfo приема намерения запис като параметри и връща HTML на панела.
  const info = async (obj) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) p.append(k, v == null ? "" : String(v));
    return (await go(`/bg/Map/GetObjectInfo/?${p}`, { headers: xhr })).text();
  };

  const out = { found: false, id, plot: null, buildings: [], truncated: false };
  try {
    const hits = await find(id);
    const plot = hits.find((d) => d.Type === 1); // 1 = ПИ, 2 = Сграда
    if (!plot) {
      out.note = hits.length ? `Идентификаторът съществува, но не е поземлен имот (Type ${hits[0].Type})` : "Не е намерен в КАИС";
      return json(out);
    }
    out.found = true;
    out.plot = { location: plot.ShortDescription || null, html: await info(plot) };

    // 4. Сградите са ID.1, ID.2, … — търсим, докато има `miss` поредни пропуска.
    let misses = 0;
    for (let n = 1; n <= 100 && misses < miss; n++) {
      const bid = `${id}.${n}`;
      const b = (await find(bid)).filter((d) => d.Type === 2);
      if (!b.length) { misses++; continue; }
      misses = 0;
      out.buildings.push({ id: bid, number: n, html: await info(b[0]) });
    }
  } catch (e) {
    if (!(e instanceof Budget)) throw e;
    out.truncated = true; // твърде много сгради за едно извикване на безплатния план
  }
  return json(out);
}
