// Storage schema of one workspace (SQLite). Append a new entry to change it; never edit a shipped one.
import type { Store } from "../ports/store";

export const MIGRATIONS = [
  `CREATE TABLE claims (n INTEGER PRIMARY KEY, instance TEXT NOT NULL, role TEXT NOT NULL, since INTEGER NOT NULL, touched INTEGER NOT NULL);
CREATE TABLE origins (n INTEGER PRIMARY KEY, origin TEXT NOT NULL, instance TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE handed (n INTEGER NOT NULL, sha TEXT NOT NULL, PRIMARY KEY (n, sha));
CREATE TABLE answers (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL, ts INTEGER NOT NULL, text TEXT NOT NULL, via TEXT NOT NULL);
CREATE TABLE entered (n INTEGER PRIMARY KEY, state TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE inbox (n INTEGER PRIMARY KEY, comment_id INTEGER, kind TEXT NOT NULL, card TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL, skip_seq INTEGER NOT NULL DEFAULT 0, answered_at INTEGER);
CREATE TABLE messages (message_id INTEGER PRIMARY KEY, n INTEGER NOT NULL, kind TEXT NOT NULL, html TEXT, open INTEGER NOT NULL DEFAULT 0);
CREATE TABLE idem (key TEXT NOT NULL, caller TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (key, caller));
CREATE TABLE updates (update_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE postponed (n INTEGER PRIMARY KEY, comment_id INTEGER, card TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, since INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE albums (group_id TEXT NOT NULL, msg TEXT NOT NULL, ts INTEGER NOT NULL);`,
];

export const TABLES = ["claims", "origins", "handed", "answers", "entered", "inbox", "messages", "idem", "updates", "meta", "postponed", "albums"];

export function migrate(db: Store) {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (v INTEGER NOT NULL)");
  const done = db.rows<{ v: number }>("SELECT count(*) AS v FROM _migrations")[0].v;
  MIGRATIONS.slice(done).forEach((m, i) => {
    db.exec(m);
    db.exec("INSERT INTO _migrations VALUES (?)", done + i + 1);
  });
}
