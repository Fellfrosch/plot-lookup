# Справка за поземлен имот

Уеб страница, която по кадастрален идентификатор (напр. `44063.6207.271`) показва
кадастъра и сградите, ОУП, ПУП/УПИ, НКЦ и общинската собственост, плюс очертанието на имота.
За Столична община данните са от iSofMap, за останалата страна от КАИС.
Всяко търсене се записва с имейла на колегата; списъкът е видим само за администратора.

```
Колега ──► Cloudflare Access (вход с код по имейл)
              │
              ▼
      Cloudflare Worker  plot-lookup.petar-ppenchev.workers.dev
        ├─ /  , /core.js   ◄── взема страницата от GitHub (това repo)
        ├─ /isofmap, /kais ──► iSofMap / КАИС
        ├─ /log            ──► D1 база (имот, имейл, време)
        └─ /admin          ──► списък с търсенията (само ADMIN_EMAIL)
```

GitHub пази кода. Промяна в `index.html` или `core.js` тук се вижда на сайта до 5 минути
след commit. Промяна в `worker.js` трябва да се постави ръчно в Cloudflare.

Старият адрес `https://fellfrosch.github.io/plot-lookup/` пренасочва към Worker-а.

## Файлове

| Файл | Къде живее |
|---|---|
| `index.html`, `core.js`, `.nojekyll` | GitHub (оттам ги чете Worker-ът) |
| `worker.js` | Копира се в Cloudflare → Worker → Edit code |
| `schema.sql` | Изпълнява се веднъж в D1 конзолата |
| `wrangler.toml` | Само ако деплойваш с `npx wrangler deploy` |

## Настройки на Worker-а

| Име | Вид | Стойност |
|---|---|---|
| `DB` | D1 binding | базата `plot-lookup-db` |
| `TEAM_DOMAIN` | Text | `<екип>.cloudflareaccess.com` |
| `POLICY_AUD` | Text | AUD tag на Access приложението |
| `ADMIN_EMAIL` | Secret | твоят имейл |
| `RETENTION_DAYS` | Text, по желание | `365` |
| `PAGE_SOURCE` | Text, по желание | по подразбиране `https://raw.githubusercontent.com/fellfrosch/plot-lookup/main` |
| Cron Trigger | Trigger | `0 3 * * *` (нощно изтриване на стари записи) |

Докато `TEAM_DOMAIN` и `POLICY_AUD` не са зададени, страницата работи без вход и без лог.

## Лимити (безплатен план)

- 100 000 заявки на ден към Worker-а; справка в София прави 40–60, т.е. ~2 000 справки на ден.
- 50 подзаявки на извикване — за КАИС около 13 сгради в имот.
- Cloudflare Access: безплатен до 50 потребители.
- D1: 5 GB и 100 000 записа на ден — далеч над нуждите.

## Поддръжка

- Слоевете на iSofMap са в `LAYERS` в началото на `core.js`.
  Каталог: `http://www.isofmap.bg/owsmap?SERVICE=WMS&REQUEST=GetCapabilities`.
- Ако КАИС смени страницата си, проверете регулярните изрази в `kaisLookup` (`core.js`)
  и извличането на токена в `worker.js`.
- Имейлите са лични данни: бележката във footer-а уведомява колегите, а записите над
  `RETENTION_DAYS` се трият автоматично.

© 2026 Petar Penchev / All1 Studio. Built with Claude.
