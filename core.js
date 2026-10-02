// core.js — plot lookup logic (iSofMap first, КАИС as fallback).
// Port of the kais-plot-lookup skill. Runs in the browser; all network calls go
// through the Cloudflare Worker (see worker.js). Needs a global DOMParser.
(function (root) {
  "use strict";

  // ---------------- configuration ----------------
  const LAYERS = [
    { layer: "gdp_close_2010", group: "ОУП", label: "Устройствена зона по ОУП", multi: true },
    { layer: "gdp_far_2010", group: "ОУП", label: "Територия за далекоперспективно развитие" },
    { layer: "gdp_limitvalues", group: "ОУП", label: "Пределни стойности (Жм1–3, Жв)" },
    { layer: "gdp_specificrulesareas", group: "ОУП", label: "Зона със специфични правила и норми" },
    { layer: "reg_border", group: "ПУП", label: "Регулация – обхват на заповед" },
    { layer: "reg_quarter", group: "ПУП", label: "Регулационен квартал", multi: true },
    { layer: "reg_parcel", group: "ПУП", label: "УПИ", multi: true },
    { layer: "approvaltext", group: "ПУП", label: "Акт за одобряване" },
    { layer: "proposal_pup", group: "ПУП", label: "Допусната процедура за ПУП" },
    { layer: "reg_proposal", group: "ПУП", label: "Допускане до изработване на ПУП" },
    { layer: "zeasement", group: "ПУП", label: "Сервитут" },
    { layer: "pp_border_p", group: "ПУП", label: "Парцеларен план извън регулация" },
    { layer: "mon_zone", group: "НКЦ", label: "Групова НКЦ" },
    { layer: "mon_single", group: "НКЦ", label: "Единична НКЦ" },
    { layer: "mon_culturalimmovable", group: "НКЦ", label: "Граници на единична НКЦ" },
    { layer: "mon_securityzone", group: "НКЦ", label: "Охранителна зона на НКЦ" },
    { layer: "mon_archaeology", group: "НКЦ", label: "Археологическа НКЦ" },
    { layer: "municipal_immovable", group: "Собственост", label: "Общински поземлен имот" },
    { layer: "expropriation_part", group: "Собственост", label: "Отчужден имот" },
    { layer: "expropriation_art16", group: "Собственост", label: "По чл. 16 / чл. 22, ал. 8 ЗУТ" },
    { layer: "sanitaryprotectionzone", group: "Други", label: "Санитарно-охранителна зона" },
  ];
  const GROUPS = ["ОУП", "ПУП", "НКЦ", "Собственост", "Други"];
  const DROP_ROWS = new Set(["Административен район"]);
  const KEEP_AREA_IN = new Set(["reg_parcel", "reg_quarter"]);
  const PLOT_RE = /^\d{5}\.\d{1,5}\.\d{1,5}$/;

  // ---------------- API client ----------------
  class Api {
    constructor(base) { this.base = String(base || "").replace(/\/+$/, ""); }
    async iso(params) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) q.append(k, String(v));
      const r = await fetch(`${this.base}/isofmap?${q}`);
      const t = await r.text();
      if (!r.ok) throw new Error(errText(t, r.status));
      return t;
    }
    async kais(id, miss) {
      const r = await fetch(`${this.base}/kais?id=${encodeURIComponent(id)}&miss=${miss || 3}`);
      const t = await r.text();
      if (!r.ok) throw new Error(errText(t, r.status));
      return JSON.parse(t);
    }
  }
  function errText(t, status) {
    try { return JSON.parse(t).error || `HTTP ${status}`; } catch { return `HTTP ${status}: ${t.slice(0, 120)}`; }
  }

  // ---------------- identifiers ----------------
  function parseIds(text) {
    const src = String(text || "");
    const out = [], seen = new Set();
    for (const tok of src.split(/[\s,;]+/).filter(Boolean)) {
      const s = tok.replace(/^ПИ/i, "");
      if (!s || /^(ПИ|№)$/i.test(tok)) continue;
      const m = s.match(/^(\d{5}\.\d{1,5}\.\d{1,5})((?:\.\d{1,5}){0,2})$/);
      if (!m) {
        if (/\d{5}\./.test(s)) out.push({ input: tok, error: `„${tok}“ не е валиден идентификатор. Очакван формат: ЕКАТТЕ.район.имот, напр. 44063.6207.271` });
        continue;
      }
      const extra = m[2].split(".").filter(Boolean).length;
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({
        input: tok, id: m[1],
        note: extra === 1 ? `${s} е идентификатор на сграда — показан е имотът ${m[1]}.`
            : extra === 2 ? `${s} е самостоятелен обект — показан е имотът ${m[1]}. Данни за обекта изискват вход в КАИС.`
            : null,
      });
    }
    if (!out.length && /УПИ/i.test(src)) {
      out.push({ input: src, error: "УПИ номерът не е кадастрален идентификатор. Въведете номера на поземления имот (ЕКАТТЕ.район.имот)." });
    }
    return out;
  }

  // ---------------- value helpers ----------------
  function num(v) {
    if (v == null) return null;
    const s = String(v).replace(/\s/g, "").replace(",", ".");
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const nodata = (v) => (!v || ["няма данни", "-", "—"].includes(String(v).trim().toLowerCase()) ? null : v);
  function orderOf(t) {
    if (!t) return null;
    const m = t.match(/№\s*(\S+)\s+от\s+(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}/${m[4]}.${m[3]}.${m[2]} г.` : t;
  }
  function shortOrder(o) {
    if (!o) return "—";
    const m = o.match(/(РД-[\d-]+\/[\d.]+ ?г\.?)/);
    return m ? m[1] : o;
  }
  const grab = (txt, re) => { const m = txt.match(re); return m ? m[1].trim() : null; };
  const after = (lines, head) => { const i = lines.indexOf(head); return i >= 0 && i + 1 < lines.length ? lines[i + 1] : null; };
  const round1 = (x) => Math.round(x * 10) / 10;

  // ---------------- parsing ----------------
  const cellText = (el) => {
    el.querySelectorAll("br").forEach((b) => b.replaceWith(" "));
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  };

  function parseGfi(html) {
    if (!html || !html.trim()) return [];
    const doc = new DOMParser().parseFromString(html, "text/html");
    const feats = [];
    for (const tb of doc.querySelectorAll("table")) {
      const body = tb.querySelector("tbody") || tb;
      const rows = [];
      for (const tr of Array.from(body.children).filter((c) => c.tagName === "TR")) {
        const cells = Array.from(tr.children).filter((c) => c.tagName === "TD" || c.tagName === "TH");
        if (cells.length < 2) continue;
        const k = cellText(cells[0]), v = cellText(cells[1]);
        if (v) rows.push([k || "Описание", v]);
      }
      if (rows.length) feats.push(rows);
    }
    return feats;
  }

  function parseGml(text) {
    if (!/featureMember/.test(text)) {
      if (/Exception/.test(text)) throw new Error("WFS: " + text.replace(/<[^>]+>|\s+/g, " ").trim().slice(0, 200));
      return [];
    }
    const rings = [];
    const re = /<(?:\w+:)?outerBoundaryIs>[\s\S]*?<(?:\w+:)?coordinates[^>]*>([\s\S]*?)<\/(?:\w+:)?coordinates>/g;
    let m;
    while ((m = re.exec(text))) {
      const pts = [];
      for (const tok of m[1].trim().split(/\s+/)) {
        const xy = tok.split(",");
        if (xy.length >= 2) pts.push([parseFloat(xy[0]), parseFloat(xy[1])]); // [E, N]
      }
      if (pts.length > 2) rings.push(pts);
    }
    return rings;
  }

  function htmlLines(html) {
    const d = new DOMParser().parseFromString(html || "", "text/html");
    d.querySelectorAll("script,style,a").forEach((e) => e.remove());
    return Array.from(d.querySelectorAll("h5,h6,p,div,li,td,th"))
      .filter((e) => e.children.length === 0)
      .map((e) => (e.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  function cleanFeature(layer, rows) {
    const out = {};
    for (const [k, v] of rows) {
      if (DROP_ROWS.has(k)) continue;
      if (k.startsWith("Площ") && !KEEP_AREA_IN.has(layer)) continue; // whole zone/order area
      out[k] = v;
    }
    return out;
  }

  // ---------------- geometry ----------------
  function inside([x, y], rings) {
    let c = false;
    for (const ring of rings) {
      for (let i = 0, n = ring.length; i < n; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
        if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) c = !c;
      }
    }
    return c;
  }
  function edgeDist([x, y], rings) {
    let best = Infinity;
    for (const ring of rings) {
      for (let i = 0, n = ring.length; i < n; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
        const dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
        const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / L));
        best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
      }
    }
    return best;
  }
  // Primary point = interior point farthest from the boundary; extras spread across
  // the plot (≥ 1 m from edges) to detect plots split by zone / УПИ / квартал.
  function samplePoints(rings, grid = 12, maxPts = 5) {
    const xs = rings.flat().map((p) => p[0]), ys = rings.flat().map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const cand = [];
    for (let i = 0; i <= grid; i++) for (let j = 0; j <= grid; j++) {
      const p = [x0 + ((x1 - x0) * (i + 0.5)) / (grid + 1), y0 + ((y1 - y0) * (j + 0.5)) / (grid + 1)];
      if (inside(p, rings)) cand.push([edgeDist(p, rings), p]);
    }
    if (!cand.length) return [[(x0 + x1) / 2, (y0 + y1) / 2]];
    cand.sort((a, b) => b[0] - a[0]);
    const primary = cand[0][1];
    const margin = Math.min(1.0, cand[0][0] * 0.5);
    const ok = cand.filter(([d]) => d >= margin).map(([, p]) => p);
    const by = (f, cmp) => ok.reduce((a, b) => (cmp(f(b), f(a)) ? b : a));
    const extras = [by((p) => p[0], (a, b) => a < b), by((p) => p[0], (a, b) => a > b),
                    by((p) => p[1], (a, b) => a < b), by((p) => p[1], (a, b) => a > b)];
    const pts = [primary];
    for (const p of extras) if (pts.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > 2)) pts.push(p);
    return pts.slice(0, maxPts);
  }

  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
  }

  // ---------------- iSofMap ----------------
  async function isoRings(api, cad, typename) {
    const filter = `<Filter><PropertyIsEqualTo><PropertyName>cadnumber</PropertyName><Literal>${cad}</Literal></PropertyIsEqualTo></Filter>`;
    return parseGml(await api.iso({ SERVICE: "WFS", VERSION: "1.0.0", REQUEST: "GetFeature", TYPENAME: typename, FILTER: filter }));
  }

  async function gfi(api, layer, n, e, d = 0.5) {
    const t = await api.iso({
      SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetFeatureInfo", LAYERS: layer, QUERY_LAYERS: layer,
      STYLES: "", CRS: "EPSG:7801", BBOX: `${n - d},${e - d},${n + d},${e + d}`,
      WIDTH: 101, HEIGHT: 101, I: 50, J: 50, INFO_FORMAT: "text/html", FEATURE_COUNT: 20,
    });
    if (t.includes("ServiceException")) throw new Error(t.replace(/<[^>]+>|\s+/g, " ").trim().slice(-160));
    return parseGfi(t);
  }

  async function featureFor(api, layer, cad, [e, n]) {
    for (const f of await gfi(api, layer, n, e)) {
      const d = Object.fromEntries(f);
      if (d["КИ"] === cad) return d;
    }
    return null;
  }

  async function isoCadastre(api, cad, pts, missLimit, progress) {
    let d = null;
    for (const pt of pts) { d = await featureFor(api, "cad_immovable", cad, pt); if (d) break; }
    d = d || {};
    const plot = {
      id: cad,
      location: d["Адрес"] || null,
      area_m2: num(d["Площ, определена от ЦМ (кв. м.)"]),
      ntp: d["НТП"] || null,
      territory: d["Предназначение"] || null,
      ownership: nodata(d["Вид собственост"]),
      old_number: d["Стар кадастрален номер"] || null,
      quarter: d["Квартал по регулация"] || null,
      upi: d["УПИ"] || null,
      locality: d["Местност"] || null,
      order: orderOf(d["Заповеди"]),
      neighbours: null, // not available in iSofMap
    };
    const buildings = [];
    let misses = 0;
    for (let n = 1; n <= 100 && misses < missLimit; n++) {
      const bid = `${cad}.${n}`;
      const brings = await isoRings(api, bid, "cad_building");
      if (!brings.length) { misses++; continue; }
      misses = 0;
      progress && progress(`сграда ${bid}`);
      let bd = null;
      for (const pt of samplePoints(brings, 8)) { bd = await featureFor(api, "cad_building", bid, pt); if (bd) break; }
      bd = bd || {};
      buildings.push({
        id: bid, number: n, rings: brings,
        built_up_area_m2: num(bd["Застроена площ, определена от ЦМ (кв. м.)"]),
        floors: num(bd["Брой етажи"]),
        purpose: bd["Предназначение"] || null,
        ownership: nodata(bd["Вид собственост"]),
        units: num(bd["Брой СОС"]),
      });
    }
    return finishCadastre({ found: true, source: "iSofMap", plot, buildings });
  }

  function finishCadastre(c) {
    const total = c.buildings.reduce((s, b) => s + (b.built_up_area_m2 || 0), 0);
    c.buildings_total_built_up_m2 = round1(total);
    c.existing_coverage_pct = c.plot.area_m2 ? round1((100 * total) / c.plot.area_m2) : null;
    return c;
  }

  async function isoLookup(api, cad, { missLimit = 3, concurrency = 6, progress } = {}) {
    const rings = await isoRings(api, cad, "cad_immovable");
    if (!rings.length) return { found: false, plot_id: cad, note: "Имотът не е намерен в iSofMap (извън Столична община или невалиден номер)" };
    const pts = samplePoints(rings);
    const jobs = [];
    for (const cfg of LAYERS) (cfg.multi ? pts : pts.slice(0, 1)).forEach(([e, n], i) => jobs.push({ layer: cfg.layer, i, n, e }));

    let done = 0;
    const layerTask = pool(jobs, concurrency, async (j) => {
      try { return { j, feats: await gfi(api, j.layer, j.n, j.e) }; }
      catch (ex) { return { j, feats: [], err: String(ex.message || ex) }; }
      finally { done++; progress && progress(`iSofMap слоеве ${done}/${jobs.length}`); }
    });
    const [results, cadastre] = await Promise.all([layerTask, isoCadastre(api, cad, pts, missLimit, progress)]);

    const layers = {}, errors = {};
    for (const { j, feats, err } of results) {
      if (err) { errors[j.layer] = errors[j.layer] || err; continue; }
      const entry = (layers[j.layer] = layers[j.layer] || []);
      for (const f0 of feats) {
        const f = cleanFeature(j.layer, f0);
        const key = JSON.stringify(f);
        if (Object.keys(f).length && !entry.some((x) => JSON.stringify(x) === key)) entry.push(f);
      }
    }
    const outLayers = LAYERS.filter((c) => (layers[c.layer] || []).length)
      .map((c) => ({ layer: c.layer, group: c.group, label: c.label, features: layers[c.layer] }));
    const flags = [];
    for (const [lay, what] of [["gdp_close_2010", "повече от една устройствена зона по ОУП"],
                               ["reg_parcel", "повече от един УПИ"],
                               ["reg_quarter", "повече от един регулационен квартал"]]) {
      if ((layers[lay] || []).length > 1) flags.push(`Имотът попада в ${what} — всяка част следва своите правила; проверете границите в ПУП.`);
    }
    return { found: true, plot_id: cad, rings, sample_points: pts, layers: outLayers, flags, errors, cadastre };
  }

  // ---------------- КАИС ----------------
  async function kaisLookup(api, id, missLimit = 3) {
    const j = await api.kais(id, missLimit);
    if (!j.found) return { found: false, plot: { id }, note: j.note || "Не е намерен в КАИС" };
    const pl = htmlLines(j.plot.html), pt = pl.join(" | ");
    const nb = after(pl, "Съседи");
    const plot = {
      id, location: j.plot.location,
      area_m2: num(grab(pt, /(?:^|[ ,])площ ([\d\s.,]+?) кв\. ?м/)),
      ownership: grab(pt, /вид собств\. ([^,|]+)/),
      territory: grab(pt, /вид територия ([^,|]+)/),
      ntp: grab(pt, /НТП (.+?), площ/),
      old_number: grab(pt, /стар номер ([^,|]+)/),
      quarter: grab(pt, /квартал ([^,|]+)/),
      order: after(pl, "Основна заповед"),
      neighbours: nb ? nb.split(",").map((s) => s.trim()).filter(Boolean) : [],
    };
    const buildings = j.buildings.map((b) => {
      const bt = htmlLines(b.html).join(" | ");
      return {
        id: b.id, number: b.number,
        built_up_area_m2: num(grab(bt, /застроена площ ([\d\s.,]+?) кв\. ?м/)),
        floors: num(grab(bt, /брой етажи (\d+)/)),
        purpose: grab(bt, /функц\. предн\. (.+?), (?:брой етажи|застроена площ|Брой върхове)/),
        ownership: grab(bt, /вид собств\. ([^,|]+)/),
      };
    });
    return finishCadastre({ found: true, source: "КАИС", plot, buildings, truncated: !!j.truncated });
  }

  // ---------------- combined ----------------
  async function lookupOne(api, id, { withKais = false, kaisOnly = false, missLimit = 3, progress } = {}) {
    const res = { plot_id: id, primary: null, cadastre: null, isofmap: null, kais: null, notes: [] };
    if (!kaisOnly) {
      let iso;
      try { iso = await isoLookup(api, id, { missLimit, progress }); }
      catch (e) {
        iso = { error: String(e.message || e) };
        res.notes.push(`iSofMap е недостъпен (${iso.error}) — данните са от КАИС, без ОУП/ПУП.`);
      }
      res.isofmap = iso;
      if (iso.found) { res.primary = "iSofMap"; res.cadastre = iso.cadastre; delete iso.cadastre; }
    }
    if (kaisOnly || !res.primary || withKais) {
      progress && progress("КАИС");
      let k;
      try { k = await kaisLookup(api, id, missLimit); } catch (e) { k = { error: String(e.message || e) }; }
      res.kais = k;
      if (!res.primary) {
        if (k.found) {
          res.primary = "КАИС"; res.cadastre = k;
          if (res.isofmap && res.isofmap.found === false) res.notes.push("Няма данни в iSofMap (извън Столична община) — кадастърът е от КАИС, без ОУП/ПУП.");
        } else if (k.error) res.notes.push(`КАИС грешка: ${k.error}`);
      }
      if (k.truncated) res.notes.push("КАИС: има повече сгради, отколкото Worker-ът може да провери наведнъж — списъкът е непълен.");
    }
    res.analysis = analyze(res);
    return res;
  }

  // ---------------- interpretation ----------------
  const LIMIT_KEYS = /Плътност|КИНТ|озеленена|Кота корниз/i;

  function firstFeat(iso, layer) {
    const L = iso && iso.layers && iso.layers.find((x) => x.layer === layer);
    return L ? L.features : [];
  }

  function analyze(r) {
    const warnings = [], notes = [];
    const iso = r.isofmap && r.isofmap.found ? r.isofmap : null;
    const cad = r.cadastre;
    if (iso) {
      warnings.push(...iso.flags);
      const has = (lay) => firstFeat(iso, lay).length > 0;
      const groups = new Set(iso.layers.map((L) => L.group));
      if (has("proposal_pup") || has("reg_proposal")) warnings.push("Има допусната процедура / допускане до изработване на ПУП — регулацията вероятно ще се промени.");
      if (groups.has("НКЦ")) warnings.push("Имотът е в обхват на недвижима културна ценност — проектът изисква съгласуване с НИНКН.");
      if (has("municipal_immovable") || has("expropriation_part") || has("expropriation_art16")) warnings.push("Има данни за общинска собственост или отчуждаване — това засяга собствеността и застроимостта.");

      const oup = firstFeat(iso, "gdp_close_2010");
      const upi = firstFeat(iso, "reg_parcel");
      const oupCat = oup.length === 1 ? (oup[0]["Устройствена категория"] || oup[0]["Код"] || "").trim() : "";
      if (oupCat && upi.length === 1 && upi[0]["Устройствена зона"]) {
        const upiCat = upi[0]["Устройствена зона"].split(/\s+-\s+/)[0].trim();
        if (upiCat && upiCat !== oupCat) warnings.push(`Зоната по ПУП (${upiCat}) се различава от зоната по ОУП (${oupCat}).`);
      }

      // ОУП "град/околоградски район" pairs
      const paired = oup.some((f) => Object.entries(f).some(([k, v]) => LIMIT_KEYS.test(k) && v.includes("/")));
      if (paired) {
        const loc = (cad && cad.plot.location) || "";
        const which = /гр\.?\s*София/i.test(loc) ? "За имот в гр. София важи първата стойност."
          : /^с\.|\bс\.\s/.test(loc) ? "Имотът е в село — важи втората стойност (околоградски район); минимумът е за разширения на населени места."
          : "Първата стойност е за гр. София, втората — за селата в Столична община.";
        notes.push(`Показателите по ОУП са във формат „град/околоградски район“. ${which}`);
      }
      notes.push("Показателите по ОУП са пределни стойности. Действащите параметри идват от ПУП (застроителния план).");
      if (!groups.has("ПУП")) notes.push("Няма дигитализиран ПУП в iSofMap — това обикновено значи, че регулацията не е въведена или имотът е извън регулация, а не че няма правила.");

      // Area of УПИ vs ПИ
      if (cad && cad.plot.area_m2 && upi.length === 1) {
        const ua = num(upi[0]["Площ, определена от ЦМ (кв. м.)"]);
        if (ua && Math.abs(ua - cad.plot.area_m2) / cad.plot.area_m2 > 0.02) {
          notes.push(`УПИ е ${ua} кв. м, а ПИ е ${cad.plot.area_m2} кв. м — вероятно има придаваеми или отнемаеми части по регулация.`);
        }
      }
    }
    if (cad) notes.push("Процентът застроена площ е изчислен от кадастралните данни и не е регулативна плътност. КККР може да изостава от ново строителство.");

    // Indicative maxima from the УПИ (ПУП) parameters
    let maxima = null;
    if (iso) {
      const upi = firstFeat(iso, "reg_parcel");
      if (upi.length === 1) {
        const f = upi[0];
        const pick = (re) => { const e = Object.entries(f).find(([k]) => re.test(k)); return e ? e[1] : null; };
        // Paired ОУП-style values ("50/25 до 40"): use the city value only for гр. София;
        // village values are ranges, so no single figure is computed for them.
        const loc = (cad && cad.plot.location) || "";
        const city = /гр\.?\s*София/i.test(loc);
        const val = (v) => {
          if (v == null) return null;
          if (!v.includes("/")) return num(v) ?? num((v.match(/\d+(?:[.,]\d+)?/) || [])[0]);
          if (!city) return undefined;
          const m = v.split("/")[0].match(/\d+(?:[.,]\d+)?/);
          return m ? num(m[0]) : null;
        };
        const plt = val(pick(/Плътност/i)), kint = val(pick(/КИНТ/i)), oz = val(pick(/озеленена/i)), h = val(pick(/корниз/i));
        const paired = [plt, kint, oz, h].includes(undefined);
        const area = num(f["Площ, определена от ЦМ (кв. м.)"]) || (cad && cad.plot.area_m2);
        if (area && !paired && (plt != null || kint != null)) {
          maxima = {
            paired_city: Object.values(f).some((v) => String(v).includes("/")),
            base_area_m2: area,
            built_up_m2: plt != null ? Math.round((area * plt) / 100) : null,
            gross_m2: kint != null ? Math.round(area * kint) : null,
            green_m2: oz != null ? Math.round((area * oz) / 100) : null,
            cornice_m: h,
          };
        }
      }
    }
    return { warnings, notes, maxima };
  }

  // ---------------- Markdown (for copy) ----------------
  const fmt = (v, unit = "") => (v == null ? "—" : `${v}${unit}`);
  const esc = (v) => String(v).replace(/\|/g, "/");

  function toMarkdown(r) {
    const out = [];
    const c = r.cadastre;
    if (c) {
      const p = c.plot;
      out.push(`**ПИ ${p.id}** — ${p.location || ""}`, "", `_Кадастрални данни: ${r.primary}_`, "",
        "| Параметър | Стойност |", "|---|---|",
        `| Площ | ${fmt(p.area_m2, " кв. м")} |`, `| НТП | ${fmt(p.ntp)} |`,
        `| Вид територия | ${fmt(p.territory)} |`, `| Собственост | ${fmt(p.ownership)} |`,
        `| Стар номер / квартал | ${fmt(p.old_number)} / ${fmt(p.quarter)} |`);
      if (p.upi) out.push(`| УПИ | ${p.upi} |`);
      if (p.locality) out.push(`| Местност | ${p.locality} |`);
      out.push(`| Основна заповед | ${shortOrder(p.order)} |`);
      if (p.neighbours) out.push(`| Съседи | ${p.neighbours.join(", ") || "—"} |`);
      out.push("");
      if (c.buildings.length) {
        out.push("| Сграда | Предназначение | Етажи | Застроена площ |", "|---|---|---|---|");
        for (const b of c.buildings) out.push(`| ${b.id} | ${fmt(b.purpose)} | ${fmt(b.floors)} | ${fmt(b.built_up_area_m2, " кв. м")} |`);
        out.push("", `Обща застроена площ: ${c.buildings_total_built_up_m2} кв. м` +
          (c.existing_coverage_pct != null ? ` (≈ ${c.existing_coverage_pct}% от имота, изчислено от кадастралните данни)` : ""));
      } else out.push("Няма регистрирани сгради в имота.");
      out.push("");
    } else out.push(`**ПИ ${r.plot_id}** — не е намерен нито в iSofMap, нито в КАИС.`, "");

    const a = r.analysis || { warnings: [], notes: [] };
    for (const w of a.warnings) out.push(`⚠️ ${w}`);
    if (a.warnings.length) out.push("");

    const iso = r.isofmap;
    if (iso && iso.found) {
      out.push("### Устройствени данни (iSofMap)", "");
      let cur = null;
      for (const L of iso.layers) {
        if (L.group !== cur) { cur = L.group; out.push(`**${cur}**`, ""); }
        L.features.forEach((f, i) => {
          out.push(`| ${L.label}${L.features.length > 1 ? ` (${i + 1})` : ""} | |`, "|---|---|");
          for (const [k, v] of Object.entries(f)) out.push(`| ${k} | ${esc(v)} |`);
          out.push("");
        });
      }
      const present = new Set(iso.layers.map((L) => L.group));
      const missing = ["ПУП", "НКЦ"].filter((g) => !present.has(g));
      if (missing.length) out.push(`Няма данни в iSofMap за: ${missing.join(", ")}.`, "");
    }
    const k = r.kais;
    if (r.primary === "iSofMap" && k && k.found) {
      out.push("### КАИС (допълнително)", "");
      if (k.plot.neighbours && k.plot.neighbours.length) out.push(`Съседи: ${k.plot.neighbours.join(", ")}`, "");
      const d = kaisDiffs(r);
      out.push(d.length ? `⚠️ Разлики: ${d.join("; ")} — iSofMap може да изостава от КККР.` : "Площта и сградите съвпадат с КАИС.", "");
    }
    if (a.maxima) {
      const m = a.maxima;
      out.push(`Ориентировъчно по показателите на УПИ (${m.base_area_m2} кв. м${m.paired_city ? ", градски стойности" : ""}): ЗП до ${fmt(m.built_up_m2, " кв. м")}, РЗП до ${fmt(m.gross_m2, " кв. м")}, озеленяване мин. ${fmt(m.green_m2, " кв. м")}, корниз до ${fmt(m.cornice_m, " м")}. Пределни стойности — реалното застрояване зависи и от линиите на застрояване, отстоянията и ЗУТ.`, "");
    }
    for (const n of [...r.notes, ...a.notes]) out.push(`_${n}_`, "");
    return out.join("\n").trim() + "\n";
  }

  function kaisDiffs(r) {
    const k = r.kais, c = r.cadastre, d = [];
    if (!k || !k.found || !c) return d;
    if (k.plot.area_m2 !== c.plot.area_m2) d.push(`площ КАИС ${k.plot.area_m2} / iSofMap ${c.plot.area_m2} кв. м`);
    if (k.buildings.length !== c.buildings.length) d.push(`сгради КАИС ${k.buildings.length} / iSofMap ${c.buildings.length}`);
    return d;
  }

  root.PlotLookup = { Api, LAYERS, GROUPS, PLOT_RE, parseIds, lookupOne, isoLookup, kaisLookup, analyze, toMarkdown, kaisDiffs, shortOrder, samplePoints };
})(typeof window !== "undefined" ? window : globalThis);
