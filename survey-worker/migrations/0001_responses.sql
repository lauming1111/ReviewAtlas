-- Migration number: 0001 	 uninstall survey answers
CREATE TABLE responses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_on TEXT NOT NULL,  -- UTC date, YYYY-MM-DD. Day granularity on purpose: no time of day is kept.
  version    TEXT,           -- extension version from ?v=, or NULL
  reasons    TEXT NOT NULL,  -- JSON array of reason slugs
  note       TEXT            -- free text, at most 1000 characters, or NULL
);
