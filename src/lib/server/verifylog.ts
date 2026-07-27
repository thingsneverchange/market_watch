import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ============================================================
//  실적 반응률 검증 기록
//
//  왜 필요한가 — 검증에 **영속성이 없었다.**
//   Finnhub 무료 /quote 는 **마지막 세션의 등락만** 준다(과거 특정일 조회 불가).
//   그래서 "마지막 세션 == 그 종목의 반응 세션"인 짧은 창에서만 검증이 성립한다.
//   그 창을 벗어나면 검증값이 사라졌고, 코드는 리캡(LLM)이 주장한 값으로 되돌아갔다.
//
//   실측 (프로덕션, 8초 간격 폴링):
//     11:10:15  INTC  +10%      verified=false   ← 리캡 주장
//     11:11:09  INTC  −7.8918%  verified=true    ← 실제 시세
//   같은 방송에서 17.9%p 부호 반전이 왕복했다.
//   그리고 정규장이 열려 quote 의 세션이 오늘로 넘어가면 조건이 **영원히 거짓**이 되어
//   하루 종일 +10% 로 고착된다.
//
//  한 번 실측으로 확인한 값은 사실이고, 그 사실은 조회가 흔들린다고 없어지지 않는다.
//  → 종목+반응세션 단위로 기억한다. 재시작을 넘어 살아남아야 하므로 디스크에 쓴다.
//
//  기억하는 건 **실측된 숫자뿐**이다. 리캡이 주장한 값은 절대 여기 들어오지 않는다.
// ============================================================

type Entry = { ticker: string; day: string; pct: number; at: number };

const FILE = ".data/verify-log.json";
const KEEP_MS = 10 * 864e5;   // 반응 패널이 7일치를 보므로 여유 있게 10일
const MAX = 200;

let mem: Entry[] | null = null;

function load(): Entry[] {
  if (mem) return mem;
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    mem = Array.isArray(raw) ? raw.filter((x) => x && typeof x.ticker === "string") : [];
  } catch {
    mem = [];   // 파일이 없으면 빈 기록으로 시작 (에러 아님)
  }
  return mem!;
}

function save(rows: Entry[]) {
  mem = rows;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(rows), "utf8");
  } catch {
    /* 디스크에 못 써도 메모리 기록은 유지한다 — 방송을 멈출 이유가 없다 */
  }
}

/**
 * 실측으로 확인된 반응률을 기록한다.
 * @param day 그 종목의 **반응 세션 날짜** (ET, YYYY-MM-DD). 세션이 다르면 다른 사실이다.
 */
export function rememberVerified(ticker: string, day: string, pct: number): void {
  if (!ticker || !day || !Number.isFinite(pct)) return;
  const rows = load();
  const i = rows.findIndex((r) => r.ticker === ticker && r.day === day);
  const now = Date.now();
  if (i >= 0) {
    // 같은 세션의 값이 갱신된 경우(장중 재조회) 최신으로 덮는다
    if (rows[i].pct === pct) return;   // 같으면 디스크를 건드리지 않는다
    rows[i] = { ticker, day, pct, at: now };
  } else {
    rows.push({ ticker, day, pct, at: now });
  }
  const cutoff = now - KEEP_MS;
  save(rows.filter((r) => r.at > cutoff).slice(-MAX));
}

/**
 * 기억해 둔 검증값. 없으면 null — **호출부는 리캡 주장값으로 대체하면 안 된다.**
 * @param day 지금 그 종목의 반응 세션. 기록된 세션과 다르면 다른 사실이므로 쓰지 않는다.
 */
export function recallVerified(ticker: string, day: string | undefined): number | null {
  if (!ticker || !day) return null;
  const hit = load().find((r) => r.ticker === ticker && r.day === day);
  return hit ? hit.pct : null;
}
