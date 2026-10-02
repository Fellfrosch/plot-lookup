// Cloudflare Worker — network bridge for the plot lookup page.
//
//   GET /isofmap?SERVICE=WMS|WFS&REQUEST=...   -> proxied to http://www.isofmap.bg/owsmap
//   GET /kais?id=44063.6207.271[&miss=3]       -> КАИС plot + buildings (raw panel HTML)
//   GET /                                      -> health check
//
// iSofMap is HTTP-only, so an HTTPS page (GitHub Pages) can't call it directly
// (mixed content). КАИС needs a cookie session + CSRF token and sends no CORS
// headers. All parsing happens in the browser (core.js); this file only moves bytes.
//
// Optional env var ALLOWED_ORIGINS: comma-separated list of origins allowed to use
// the Worker, e.g. "https://petar.github.io,http://localhost:8000". Default "*".

const ISO_BASES = ["http://www.isofmap.bg", "http://isofmap.bg"];
const KAIS = "https://kais.cadastre.bg";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const PLOT_RE = /^\d{5}\.\d{1,5}\.\d{1,5}$/;
const ISO_SERVICES = new Set(["WMS", "WFS"]);
const ISO_REQUESTS = new Set(["GetFeature", "GetFeatureInfo", "GetCapabilities"]);
// Free plan allows 50 subrequests per invocation; keep a margin.
const KAIS_BUDGET = 46;

export default {
  async fetch(req, env) {
    const cors = corsFor(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors.headers });
    if (!cors.ok) return json({ error: "Origin not allowed" }, 403, cors.headers);
    if (req.method !== "GET") return json({ error: "Only GET is supported" }, 405, cors.headers);

    const url = new URL(req.url);
    try {
      if (url.pathname === "/isofmap") return await isofmap(url, cors.headers);
      if (url.pathname === "/kais") return await kais(url, cors.headers);
      if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, service: "plot-lookup" }, 200, cors.headers);
      return json({ error: "Not found" }, 404, cors.headers);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502, cors.headers);
    }
  },
};

function corsFor(req, env) {
  const allow = String(env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("Origin") || "";
  const any = allow.includes("*");
  // Requests without an Origin header (opening the URL directly) are allowed so the
  // health check works in a browser tab; browsers always send Origin on fetch() from a page.
  const ok = any || !origin || allow.includes(origin);
  return {
    ok,
    headers: {
      "Access-Control-Allow-Origin": any ? "*" : origin || allow[0] || "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ---------------- iSofMap ----------------
async function isofmap(url, cors) {
  const q = url.searchParams;
  const svc = (q.get("SERVICE") || "").toUpperCase();
  const op = q.get("REQUEST") || "";
  if (!ISO_SERVICES.has(svc) || !ISO_REQUESTS.has(op)) {
    return json({ error: "Only WMS/WFS GetFeature, GetFeatureInfo and GetCapabilities are proxied" }, 400, cors);
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
          ...cors,
          // iSofMap doesn't always declare a charset; the content is UTF-8.
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch (e) {
      last = `${base}: ${e.message || e}`;
    }
  }
  return json({ error: `iSofMap unreachable — ${last}` }, 502, cors);
}

// ---------------- КАИС ----------------
class Budget extends Error {}

async function kais(url, cors) {
  const id = (url.searchParams.get("id") || "").trim();
  if (!PLOT_RE.test(id)) return json({ error: "Invalid id. Expected ЕКАТТЕ.район.имот" }, 400, cors);
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

  // 1. Session + CSRF token from the map page.
  let tok = null;
  for (let attempt = 0; attempt < 2 && !tok; attempt++) {
    const html = await (await go("/bg/Map")).text();
    const m = html.match(/name="__RequestVerificationToken"[^>]*?value="([^"]+)"/) ||
              html.match(/value="([^"]+)"[^>]*?name="__RequestVerificationToken"/);
    if (m) tok = m[1];
  }
  if (!tok) return json({ error: "КАИС: no __RequestVerificationToken on /bg/Map" }, 502, cors);

  // 2. FastSearch stores the search in the session; ReadFoundObjects returns it.
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

  // 3. GetObjectInfo takes the found record as query params, returns panel HTML.
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
      return json(out, 200, cors);
    }
    out.found = true;
    out.plot = { location: plot.ShortDescription || null, html: await info(plot) };

    // 4. Buildings are ID.1, ID.2, … — probe until `miss` consecutive misses.
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
    out.truncated = true; // too many buildings for one invocation on the free plan
  }
  return json(out, 200, cors);
}
