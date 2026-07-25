import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ============================================================
//  거시 이벤트 기록 (최근 7일)
//
//  왜 직접 쌓는가:
//   · Finnhub 경제 캘린더는 무료 티어에서 403 (실측)
//   · 피드 서버는 **다음 이벤트 1개**(key_event)만 들고 있고 히스토리 엔드포인트가 없다
//     (/api/history, /api/events, /api/macro 전부 404 로 확인)
//   → 지난 이벤트 목록을 주는 무료 소스가 없다. 지어낼 수는 없으니,
//     피드에서 이벤트를 볼 때마다 여기에 적어 두고 7일치를 굴린다.
//
//  한계를 분명히 해 둔다: **처음엔 비어 있고 시간이 지나며 찬다.**
//  화면도 그 사실을 그대로 말한다("collecting…"). 없는 과거를 만들어내지 않는다.
//
//  실제치/컨센서스(예: CPI 3.2% vs 3.1% 예상)는 여전히 없다 —
//  그건 유료 경제 캘린더가 필요하다. 여기 적히는 건 "무슨 일정이 언제 있었나"까지다.
// ============================================================

export type MacroEntry = {
  id: string;          // title|whenET — 중복 방지 키
  title: string;
  whenET: string;      // ISO
  importance: number;  // 1~5
  note: string;
  /** 이 항목을 처음 본 시각 */
  seenAt: number;
};

const WEEK_MS = 7 * 864e5;
const MAX = 40;
const FILE = ".data/macro-log.json";

let mem: MacroEntry[] | null = null;

function load(): MacroEntry[] {
  if (mem) return mem;
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    mem = Array.isArray(raw) ? raw.filter((x) => x && typeof x.id === "string") : [];
  } catch {
    mem = []; // 파일이 없으면 빈 기록으로 시작한다 (에러 아님)
  }
  return mem!;
}

function save(rows: MacroEntry[]) {
  mem = rows;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(rows), "utf8");
  } catch {
    /* 디스크에 못 써도 메모리 기록은 유지한다 — 방송을 멈출 이유가 없다 */
  }
}

/** 피드에서 본 거시 이벤트를 기록한다 (이미 있으면 무시) */
export function recordMacro(e: {
  title?: string; whenET?: string; importance?: number; note?: string;
}): void {
  const title = String(e?.title ?? "").trim();
  const whenET = String(e?.whenET ?? "").trim();
  if (!title || !whenET) return;
  const t = Date.parse(whenET);
  if (!Number.isFinite(t)) return;

  const rows = load();
  const id = `${title}|${whenET}`;
  if (rows.some((r) => r.id === id)) return;

  rows.push({
    id, title, whenET,
    importance: Math.max(1, Math.min(5, Number(e.importance) || 3)),
    note: String(e.note ?? "").slice(0, 300),
    seenAt: Date.now()
  });
  // 오래된 것 정리 + 상한
  const cutoff = Date.now() - WEEK_MS;
  const kept = rows
    .filter((r) => Date.parse(r.whenET) > cutoff)
    .sort((a, b) => Date.parse(b.whenET) - Date.parse(a.whenET))
    .slice(0, MAX);
  save(kept);
}

/** 이미 지난 거시 이벤트, 최근순. 7일 넘은 건 제외된다. */
export function recentMacro(limit = 5): MacroEntry[] {
  const now = Date.now();
  const cutoff = now - WEEK_MS;
  return load()
    .filter((r) => {
      const t = Date.parse(r.whenET);
      return t <= now && t > cutoff;   // 이미 지났고, 1주일 안쪽
    })
    .sort((a, b) => Date.parse(b.whenET) - Date.parse(a.whenET))
    .slice(0, limit);
}
