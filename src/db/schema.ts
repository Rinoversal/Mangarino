export const SCHEMA_VERSION = 1;

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('folder','imported')),
  uri TEXT NOT NULL UNIQUE,
  label TEXT,
  last_scan_ms INTEGER
);
CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  title_override TEXT,
  cover_uri TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS archives (
  id INTEGER PRIMARY KEY,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cbz','dir')),
  uri TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER,
  volume REAL,
  chapter REAL,
  year INTEGER,
  page_count INTEGER NOT NULL DEFAULT 0,
  has_panels INTEGER NOT NULL DEFAULT 0,
  indexed_ms INTEGER,
  sort_key TEXT NOT NULL,
  error TEXT,
  cover_uri TEXT
);
CREATE INDEX IF NOT EXISTS idx_archives_series ON archives(series_id, sort_key);
CREATE TABLE IF NOT EXISTS zip_entries (
  archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  entry_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  method INTEGER NOT NULL,
  flags INTEGER NOT NULL,
  crc32 INTEGER NOT NULL,
  comp_size INTEGER NOT NULL,
  uncomp_size INTEGER NOT NULL,
  local_header_offset INTEGER NOT NULL,
  data_offset INTEGER,
  PRIMARY KEY (archive_id, entry_index)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pages (
  archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL,
  entry_index INTEGER,
  uri TEXT,
  entry_name TEXT NOT NULL,
  chapter REAL,
  page_no INTEGER,
  extra TEXT,
  width INTEGER,
  height INTEGER,
  panels_json TEXT,
  PRIMARY KEY (archive_id, page_index)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS progress (
  archive_id INTEGER PRIMARY KEY REFERENCES archives(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL,
  panel_index INTEGER,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS series_progress (
  series_id INTEGER PRIMARY KEY REFERENCES series(id) ON DELETE CASCADE,
  archive_id INTEGER NOT NULL,
  page_index INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY,
  archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL,
  opened_ms INTEGER NOT NULL,
  closed_ms INTEGER,
  pages_read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_history_time ON history(opened_ms DESC);
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY,
  archive_id INTEGER NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL,
  panel_index INTEGER,
  note TEXT,
  created_ms INTEGER NOT NULL,
  UNIQUE (archive_id, page_index, panel_index)
);
CREATE TABLE IF NOT EXISTS page_cache (
  archive_id INTEGER NOT NULL,
  page_index INTEGER NOT NULL,
  uri TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  last_access_ms INTEGER NOT NULL,
  PRIMARY KEY (archive_id, page_index)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_page_cache_lru ON page_cache(last_access_ms);
`;
