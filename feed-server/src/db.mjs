// ============================================================
//  SQLite 저장소 (node:sqlite — 네이티브 의존성 없음, Node 22+ 내장)
//
//  ※ PM2 cluster 2 instances + cron 프로세스가 같은 파일을 동시에 연다.
//     WAL + busy_timeout 이 없으면 SQLITE_BUSY 로 쓰기가 실패한다.
// ============================================================
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 종류별 신선도 기준 — 이 나이를 넘으면 stale 로 표시하고, 클라이언트가 폴백한다 */
export const KINDS = {
  top_story: { maxAgeMs: 90 * 60_000, label: "TOP STORY" },
  key_event: { maxAgeMs: 18 * 3600_000, label: "NEXT KEY EVENT" },
  // 최근 발표된 종목의 결과(예상 상회/하회) + 시장반응(주가 %). 발표 직후엔 색인이 없어
  // 조금 시차가 있지만, 발표 뒤 몇 시간 유효하면 되므로 8시간.
  earnings_recap: { maxAgeMs: 8 * 3600_000, label: "EARNINGS RECAP" },
  // 오늘 시장의 핵심 이벤트·뉴스 2~4개 + 각각의 영향 한 줄. 연설/증언/실적콜 같은
  // 예정 이벤트는 시작시각을 실어 화면이 카운트다운·LIVE NOW 뱃지를 계산한다.
  market_brief: { maxAgeMs: 4 * 3600_000, label: "TODAY BRIEF" },
  // 라이브/예정 방송 후보 (연준 회견·정부 이벤트·실적콜). 사람이 /control 에서 골라 송출한다.
  live_videos: { maxAgeMs: 3 * 3600_000, label: "LIVE VIDEOS" }
};

let db;

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);

  // WAL: 읽기(웹 워커 2개)와 쓰기(cron)가 서로 막지 않게 한다.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS feed_current (
      kind         TEXT PRIMARY KEY,
      payload      TEXT    NOT NULL,
      model        TEXT,
      generated_at INTEGER NOT NULL,   -- Claude 가 만든 시각 (진짜 신선도)
      received_at  INTEGER NOT NULL    -- 서버가 받은 시각
    );

    CREATE TABLE IF NOT EXISTS feed_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      kind         TEXT    NOT NULL,
      payload      TEXT    NOT NULL,
      model        TEXT,
      generated_at INTEGER NOT NULL,
      received_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hist_kind_time
      ON feed_history(kind, received_at DESC);
  `);

  return db;
}

export function putItem({ kind, payload, model, generatedAt }) {
  const now = Date.now();
  const json = JSON.stringify(payload);
  db.prepare(
    `INSERT INTO feed_current (kind, payload, model, generated_at, received_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET
       payload = excluded.payload, model = excluded.model,
       generated_at = excluded.generated_at, received_at = excluded.received_at`
  ).run(kind, json, model ?? null, generatedAt, now);

  db.prepare(
    `INSERT INTO feed_history (kind, payload, model, generated_at, received_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(kind, json, model ?? null, generatedAt, now);

  // 종류별 최근 200건만 보존 (24시간 방송 × 30분 주기여도 무한 증가하지 않게)
  db.prepare(
    `DELETE FROM feed_history
      WHERE kind = ?
        AND id NOT IN (SELECT id FROM feed_history WHERE kind = ?
                        ORDER BY received_at DESC LIMIT 200)`
  ).run(kind, kind);

  return { kind, receivedAt: now };
}

export function getAll() {
  const rows = db.prepare(`SELECT * FROM feed_current`).all();
  const now = Date.now();
  const items = {};
  for (const r of rows) {
    const cfg = KINDS[r.kind];
    if (!cfg) continue; // 알 수 없는 종류는 내보내지 않는다
    const ageMs = now - r.generated_at;
    items[r.kind] = {
      payload: JSON.parse(r.payload),
      model: r.model,
      generatedAt: r.generated_at,
      ageSec: Math.max(0, Math.round(ageMs / 1000)),
      // ★ 낡았으면 숨기지 않고 낡았다고 말한다. 클라이언트가 폴백을 결정한다.
      stale: ageMs > cfg.maxAgeMs
    };
  }
  return { serverNow: now, items };
}

export function getHistory(kind, limit = 20) {
  return db
    .prepare(
      `SELECT payload, model, generated_at, received_at
         FROM feed_history WHERE kind = ?
        ORDER BY received_at DESC LIMIT ?`
    )
    .all(kind, Math.min(100, Math.max(1, limit)))
    .map((r) => ({
      payload: JSON.parse(r.payload),
      model: r.model,
      generatedAt: r.generated_at,
      receivedAt: r.received_at
    }));
}

export function stats() {
  const c = db.prepare(`SELECT COUNT(*) n FROM feed_current`).get();
  const h = db.prepare(`SELECT COUNT(*) n FROM feed_history`).get();
  return { current: c.n, history: h.n };
}
