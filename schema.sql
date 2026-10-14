-- Cloudflare D1: един ред на търсене – имот, имейл (потвърден от Cloudflare Access), време.
-- Изпълни веднъж в D1 → plot-lookup-db → Console.
CREATE TABLE IF NOT EXISTS searches (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  plot  TEXT    NOT NULL,          -- напр. 68134.1107.331
  email TEXT    NOT NULL,          -- от Cloudflare Access
  ts    INTEGER NOT NULL           -- Unix време в секунди
);
CREATE INDEX IF NOT EXISTS idx_searches_plot  ON searches(plot);
CREATE INDEX IF NOT EXISTS idx_searches_email ON searches(email);
CREATE INDEX IF NOT EXISTS idx_searches_ts    ON searches(ts);
