# Справка за поземлен имот

Уеб страница, която по кадастрален идентификатор (напр. `44063.6207.271`) показва
кадастъра и сградите, ОУП, ПУП/УПИ, НКЦ и общинската собственост, плюс очертанието на имота.
За Столична община данните са от iSofMap, за останалата страна от КАИС.

```
GitHub Pages (index.html + core.js)  ──►  Cloudflare Worker (worker.js)  ──►  iSofMap / КАИС
```

Worker-ът е нужен по две причини. iSofMap работи само по http, а GitHub Pages е https,
и браузърът блокира такива заявки. КАИС пък изисква сесия и CSRF токен и не позволява
заявки от чужди сайтове. Worker-ът само пренася данните; цялата обработка е в `core.js`.

## 1. Cloudflare Worker

**През сайта на Cloudflare (най-лесно):**

1. Dashboard → **Workers & Pages** → **Create** → **Create Worker**.
2. Име: `plot-lookup` → **Deploy**.
3. **Edit code** → изтрийте примерния код, поставете съдържанието на `worker.js` → **Deploy**.
4. Запишете адреса, например `https://plot-lookup.petar.workers.dev`.
   Отворен в браузъра, трябва да покаже `{"ok":true,...}`.

**Или с Wrangler:** `npx wrangler deploy` в тази папка.

**По желание — ограничаване до вашия сайт:** Worker → Settings → Variables →
добавете `ALLOWED_ORIGINS` = `https://ВАШИЯТ-ПРОФИЛ.github.io`. Тогава други сайтове не
могат да го вграждат. (Това не е защита срещу скриптове, само срещу чужди страници.)

## 2. GitHub Pages

1. В `index.html` сменете реда
   `window.PLOT_API = "https://plot-lookup.YOUR-SUBDOMAIN.workers.dev";`
   с адреса на вашия Worker.
2. Качете `index.html`, `core.js` и `.nojekyll` в repo (напр. `plot-lookup`).
   `worker.js`, `wrangler.toml` и този README могат да са в същото repo.
3. Repo → **Settings → Pages** → Source: *Deploy from a branch*, Branch: `main`, папка `/ (root)`.
4. След минута страницата е на `https://ВАШИЯТ-ПРОФИЛ.github.io/plot-lookup/`.

Връзки към конкретна справка: `…/plot-lookup/?id=68134.630.52`
(няколко: `?id=ID1,ID2`, със сравнение с КАИС: `&kais=1`).

## Лимити (безплатен план на Cloudflare)

- 100 000 заявки на ден към Worker-а. Една справка в София прави около 40–60
  (по една на слой на iSofMap), тоест около 2 000 справки на ден.
- 50 подзаявки на едно извикване. За КАИС това стига за около 13 сгради в имота;
  при повече страницата показва бележка, че списъкът е непълен.

## Локален тест

```
npx wrangler dev                     # Worker на http://localhost:8787
python3 -m http.server 8000          # страницата на http://localhost:8000
```
и временно сложете `window.PLOT_API = "http://localhost:8787"`.

## Поддръжка

- Слоевете на iSofMap са в `LAYERS` в началото на `core.js` (същият списък като
  `isofmap_layers.json` в скила). Пълният каталог:
  `http://www.isofmap.bg/owsmap?SERVICE=WMS&REQUEST=GetCapabilities`.
- Ако КАИС смени страницата си, проверете регулярните изрази в `kaisLookup` (`core.js`)
  и извличането на токена в `worker.js`.
