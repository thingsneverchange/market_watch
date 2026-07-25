// ============================================================
//  미 증시 시장시계 (공용 — 서버/클라이언트 양쪽에서 import)
//  ※ src/lib/server/ 에 두면 +page.svelte 에서 import 할 때 SvelteKit 이 빌드 에러를 낸다.
//
//  기존에는 이 로직이 finnhub.ts 와 +page.svelte 에 복붙되어 있었고,
//  휴장일/조기폐장 처리가 아예 없어서 추수감사절·크리스마스에도 "MARKET OPEN" 이 켜졌다.
// ============================================================

// NYSE 휴장일 (관측일 기준). 하드코딩 테이블은 조용히 썩으므로 COVERED_THROUGH 로 만료를 감지한다.
const HOLIDAYS = new Set<string>([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"
]);

// 조기폐장 (13:00 ET).
// ※ 2026-07-02 를 넣으면 안 된다 — 2026-07-04 가 토요일이라 7/3 금요일이 휴장 관측일이고,
//   이 경우 NYSE 는 직전 목요일 조기폐장을 하지 않는다.
const EARLY_CLOSE = new Set<string>([
  "2026-11-27", "2026-12-24",
  "2027-11-26"
]);

const COVERED_THROUGH = 2027;

const REG_OPEN = 9 * 60 + 30;   // 09:30 ET
const REG_CLOSE = 16 * 60;      // 16:00 ET
const EARLY_CLOSE_MIN = 13 * 60; // 13:00 ET
const PRE_OPEN = 4 * 60;        // 04:00 ET — 이 전에는 어떤 거래도 없다
const AFTER_CLOSE = 20 * 60;    // 20:00 ET

export type Session = "PRE" | "OPEN" | "AFTER" | "CLOSED" | "WEEKEND" | "HOLIDAY" | "UNKNOWN";

export type MarketState = {
  open: boolean;       // 정규장 여부
  session: Session;
  msg: string;         // 화면 배지 문구
  etDate: string;      // YYYY-MM-DD (ET)
  etMinutes: number;   // ET 자정 기준 분
  closeMin: number;    // 그날의 정규장 마감 (조기폐장 반영)
  earlyClose: boolean;
};

/**
 * ET 기준 날짜/시각을 안전하게 뽑는다.
 * - new Date(d.toLocaleString(...)) 파싱 왕복 해킹을 쓰지 않는다 (로케일/엔진 의존).
 * - hour12:false 대신 hourCycle:"h23" — 그래야 자정이 "24" 로 나오는 ICU 동작을 패치할 필요가 없다.
 * - 이 함수는 setInterval 안에서 매초 호출되므로 절대 throw 하면 안 된다 (throw = 시계 전체 정지).
 */
export function etParts(d: Date = new Date()): { date: string; hour: number; minute: number; weekday: number } {
  try {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      weekday: "short"
    }).formatToParts(d);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    const date = `${get("year")}-${get("month")}-${get("day")}`;
    const hour = Number(get("hour"));
    const minute = Number(get("minute"));
    const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = WD[get("weekday")] ?? -1;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(hour) || !Number.isFinite(minute) || weekday < 0) {
      throw new Error("bad parts");
    }
    return { date, hour, minute, weekday };
  } catch {
    // Intl 실패 시에도 시계가 멎지 않도록 UTC 로 폴백 (부정확하지만 UNKNOWN 으로 표시된다)
    return { date: "", hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() };
  }
}

/** ET 기준 YYYY-MM-DD */
export function etDateStr(d: Date = new Date()): string {
  return etParts(d).date;
}

export function marketState(now: Date = new Date()): MarketState {
  const { date, hour, minute, weekday } = etParts(now);
  const min = hour * 60 + minute;
  const base = { etDate: date, etMinutes: min, earlyClose: false, closeMin: REG_CLOSE };

  // 휴장일 테이블이 만료됐으면 열려있다고 단정하지 않는다.
  const year = Number(date.slice(0, 4));
  if (!date || !Number.isFinite(year)) {
    return { ...base, open: false, session: "UNKNOWN", msg: "STATUS UNVERIFIED" };
  }
  if (year > COVERED_THROUGH) {
    return { ...base, open: false, session: "UNKNOWN", msg: "STATUS UNVERIFIED" };
  }

  if (weekday === 0 || weekday === 6) {
    return { ...base, open: false, session: "WEEKEND", msg: "WEEKEND" };
  }
  if (HOLIDAYS.has(date)) {
    return { ...base, open: false, session: "HOLIDAY", msg: "HOLIDAY" };
  }

  const early = EARLY_CLOSE.has(date);
  const closeMin = early ? EARLY_CLOSE_MIN : REG_CLOSE;
  const b = { ...base, earlyClose: early, closeMin };

  if (min >= REG_OPEN && min < closeMin) {
    return { ...b, open: true, session: "OPEN", msg: early ? "MARKET OPEN · EARLY CLOSE 1PM" : "MARKET OPEN" };
  }
  // ET 00:00~04:00 에는 어떤 거래도 없다. 기존 코드는 이 구간을 PRE-MARKET 이라고 표시했다.
  if (min >= PRE_OPEN && min < REG_OPEN) return { ...b, open: false, session: "PRE", msg: "PRE-MARKET" };
  if (min >= closeMin && min < AFTER_CLOSE) return { ...b, open: false, session: "AFTER", msg: "AFTER HOURS" };
  return { ...b, open: false, session: "CLOSED", msg: "CLOSED" };
}

/** 정규장 여부 (구 finnhub.ts:isRegularHours 대체) */
export function isRegularHours(now: Date = new Date()): boolean {
  return marketState(now).open;
}

/**
 * (ET 날짜, 자정 기준 분) → 정확한 UTC epoch(ms). 서머타임 자동 반영.
 * ※ et-time.ts:etToEpoch 와 같은 정오-프로브 기법이지만, 저건 $lib/server 라 클라이언트에서
 *   import 할 수 없어 여기 클라이언트-세이프하게 다시 둔다 (순수 Intl/Date, 서버 API 없음).
 */
function etMinuteToEpoch(dateStr: string, minutesFromMidnight: number): number {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const etH = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(probe)
  );
  let offset = etH - 12; // EDT=-4, EST=-5
  if (offset > 12) offset -= 24;
  if (offset < -12) offset += 24;
  const base = Date.parse(`${dateStr}T00:00:00Z`);
  return base - offset * 3600e3 + minutesFromMidnight * 60e3;
}

/**
 * 다음 정규장 개장까지 남은 ms. 주말·휴장일을 건너뛰며 최대 10일 앞까지 찾는다.
 * "왜 닫혔는지"와 "언제 열리는지"를 같이 보여주기 위한 값 (하드코딩 없음 — 휴장 테이블 파생).
 */
export function msToNextOpen(now: Date = new Date()): number | null {
  const s = marketState(now);
  const nowMs = now.getTime();
  if (s.session === "UNKNOWN" || !s.etDate) return null;

  // 오늘 개장 전이면 오늘 09:30
  if (s.session === "PRE") {
    const t = etMinuteToEpoch(s.etDate, REG_OPEN);
    if (t > nowMs) return t - nowMs;
  }
  // 그 외에는 다음 거래일을 찾는다
  const [y, m, d] = s.etDate.split("-").map(Number);
  for (let i = 1; i <= 10; i++) {
    const probe = new Date(Date.UTC(y, m - 1, d + i, 12));
    const ds = probe.toISOString().slice(0, 10);
    const wd = probe.getUTCDay();
    if (wd === 0 || wd === 6 || HOLIDAYS.has(ds)) continue;
    return etMinuteToEpoch(ds, REG_OPEN) - nowMs;
  }
  return null;
}

/** 화면용 시장 상태 — 상태 + 닫힌 이유 + 다시 열리는 시각을 한 번에 */
export type MarketStatus = {
  open: boolean;
  session: Session;
  label: string;        // "MARKET OPEN" / "CLOSED"
  reason: string;       // "WEEKEND" / "HOLIDAY" / "AFTER HOURS" / "" (열려 있으면 빈 문자열)
  msToOpen: number | null;
};

export function marketStatus(now: Date = new Date()): MarketStatus {
  const s = marketState(now);
  if (s.open) {
    return { open: true, session: s.session, label: s.msg, reason: "", msToOpen: null };
  }
  const REASON: Partial<Record<Session, string>> = {
    WEEKEND: "WEEKEND",
    HOLIDAY: "HOLIDAY",
    PRE: "PRE-MARKET",
    AFTER: "AFTER HOURS",
    CLOSED: "OVERNIGHT",
    UNKNOWN: "UNVERIFIED"
  };
  return {
    open: false,
    session: s.session,
    label: s.session === "UNKNOWN" ? "STATUS UNVERIFIED" : "CLOSED",
    reason: REASON[s.session] ?? "",
    msToOpen: msToNextOpen(now)
  };
}

export type MarketBell = { kind: "open" | "close" | null; ms: number };

/**
 * 개장/마감 임박 카운트다운. **오직 실측 시장시계에서 파생** — 하드코딩 없음.
 *  · 개장 1시간 전(정규 전 세션): "OPENS IN mm:ss"
 *  · 마감 1시간 전(정규장 중):     "CLOSES IN mm:ss"  ← 조기폐장이면 그날 마감(13:00)에 자동 맞춤
 *  · 주말·휴장·비거래 구간엔 아무것도 반환하지 않는다 (session 이 PRE/OPEN 일 때만 계산).
 *  · 서머타임은 etMinuteToEpoch 가 날짜별 오프셋을 실측해 처리한다.
 */
export function marketBell(now: Date = new Date()): MarketBell {
  const s = marketState(now);
  const nowMs = now.getTime();
  const WINDOW = 3600_000; // 1시간

  // 개장 임박 — PRE 세션(거래일에만 존재)에서 정규장 개장까지 1시간 이내
  if (s.session === "PRE") {
    const toOpen = etMinuteToEpoch(s.etDate, REG_OPEN) - nowMs;
    if (toOpen > 0 && toOpen <= WINDOW) return { kind: "open", ms: toOpen };
  }
  // 마감 임박 — 정규장 중 그날 마감(조기폐장 반영)까지 1시간 이내
  if (s.session === "OPEN") {
    const toClose = etMinuteToEpoch(s.etDate, s.closeMin) - nowMs;
    if (toClose > 0 && toClose <= WINDOW) return { kind: "close", ms: toClose };
  }
  return { kind: null, ms: 0 };
}

// ── 선물 세션 (CME Globex 주가지수 선물: ES/NQ/YM) ─────────────
//  일 18:00 ET 개장 → 금 17:00 ET 마감, 매일 17:00–18:00 ET 정비 중단.
//  현물 정규장(9:30–16:00)과 완전히 다르므로 절대 재사용하면 안 된다.
//  24시간 스트림에서 "지금 이 차트가 살아 있나"를 정직하게 말하려면 이게 필요하다.
export type FuturesSession = { open: boolean; label: string };

export function futuresSession(now: Date = new Date()): FuturesSession {
  const { hour, minute, weekday } = etParts(now);
  const mins = hour * 60 + minute;
  const OPEN = 18 * 60;   // 일요일 재개장
  const CLOSE = 17 * 60;  // 일일 정비 시작 / 금요일 주간 마감

  if (weekday === 6) return { open: false, label: "WEEKEND" };            // 토요일 종일 휴장
  if (weekday === 0) return mins >= OPEN                                  // 일요일
    ? { open: true, label: "GLOBEX" }
    : { open: false, label: "WEEKEND" };
  if (weekday === 5 && mins >= CLOSE) return { open: false, label: "WEEKEND" }; // 금 17:00 이후
  // 월~금 일일 정비 시간
  if (mins >= CLOSE && mins < OPEN) return { open: false, label: "DAILY BREAK" };
  return { open: true, label: "GLOBEX" };
}
