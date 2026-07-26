import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isNearDuplicate } from "./dedupe";

// ============================================================
//  TOP STORY 이력
//
//  왜 필요한가:
//   24시간 방송에서 TOP STORY 는 몇 시간마다 갈린다. 그런데 화면엔 **지금 것 하나뿐**이라,
//   중간에 들어온 시청자는 "오늘 무슨 일이 있었나"를 전혀 알 수 없었다.
//   방금 갈린 직전 스토리조차 흔적 없이 사라졌다.
//   → 갈릴 때마다 여기 쌓아 두고 화면 좌측에 직전 3건을 보여준다.
//
//  중요한 설계 하나:
//   Claude 는 같은 사건을 **매번 조금씩 다르게** 쓴다.
//     "Fed decision collides with Big Tech earnings"
//     "Fed rate decision meets megacap earnings this week"
//   문자열이 다르다고 새 스토리로 쌓으면 이력 3칸이 같은 이야기로 다 찬다.
//   그래서 근사 중복(dedupe.ts)으로 판정해 **사건이 바뀔 때만** 새 항목을 만든다.
//
//  저장은 디스크(.data/story-log.json). 못 쓰면 메모리로만 굴러간다 —
//  방송을 멈출 이유가 아니다.
// ============================================================

export type StoryEntry = {
  text: string;
  source: string;
  url: string;
  sentiment: string;
  /** "ai" | "rule" — 규칙기반 폴백이었는지 구분해서 보여준다 */
  origin: string;
  /** 기사/판단 시각 (초) */
  epoch: number;
  /** 이 스토리가 화면 최상단에 올라간 시각 (ms) */
  seenAt: number;
};

const DAY_MS = 864e5;
const MAX = 10;
const FILE = ".data/story-log.json";

let mem: StoryEntry[] | null = null;

function load(): StoryEntry[] {
  if (mem) return mem;
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    mem = Array.isArray(raw) ? raw.filter((x) => x && typeof x.text === "string") : [];
  } catch {
    mem = []; // 파일이 없으면 빈 이력으로 시작 (에러 아님)
  }
  return mem!;
}

function save(rows: StoryEntry[]) {
  mem = rows;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(rows), "utf8");
  } catch {
    /* 디스크에 못 써도 메모리 이력은 유지한다 */
  }
}

/**
 * 지금 최상단에 올린 스토리를 기록한다.
 * 이미 같은 사건이 최근 항목이면 아무것도 하지 않는다(문구만 바뀐 재생성).
 */
export function recordStory(d: {
  text?: string; source?: string; url?: string;
  sentiment?: string; origin?: string; epoch?: number;
}): void {
  const text = String(d?.text ?? "").trim();
  // "NO NEWS FEED" 같은 자리표시자는 이력이 아니다
  if (!text || text === "—" || text === "NO NEWS FEED") return;
  if (d.origin === "none") return;

  const rows = load();
  // 최근 3건 안에 같은 사건이 있으면 새로 쌓지 않는다.
  // (그보다 오래된 것과 겹치면 '다시 올라온 사건'이므로 새 항목이 맞다)
  if (rows.slice(0, 3).some((r) => isNearDuplicate(r.text, text))) return;

  const next: StoryEntry = {
    text,
    source: String(d.source ?? ""),
    url: String(d.url ?? ""),
    sentiment: String(d.sentiment ?? "neu"),
    origin: String(d.origin ?? "rule"),
    epoch: Number(d.epoch) || 0,
    seenAt: Date.now()
  };
  const cutoff = Date.now() - DAY_MS;
  save([next, ...rows].filter((r) => r.seenAt > cutoff).slice(0, MAX));
}

/** 지금 것을 뺀 **직전** 스토리들, 최신순. 24시간 넘은 건 제외된다. */
export function previousStories(currentText: string, limit = 3): StoryEntry[] {
  const cutoff = Date.now() - DAY_MS;
  return load()
    .filter((r) => r.seenAt > cutoff && !isNearDuplicate(r.text, currentText))
    .slice(0, limit);
}
