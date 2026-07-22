import type { RequestHandler } from "./$types";
import { getEarnings, WATCHLIST, TAPE_TICKERS, INDEX_TICKERS } from "$lib/server/finnhub";
import { getFeed, fresh } from "$lib/server/marketfeed";
import { earnEpoch, earnPendingFrom } from "$lib/server/et-time";

// Finnhub 실적 캘린더는 전 시장(하루 수백 종목)을 알파벳순으로 준다.
// 필터가 없으면 우측 패널이 아무도 모르는 마이크로캡(ALEX·AMBZ·BCOW…)으로 채워진다.
// 화면에 의미 있는 종목만 남긴다.
const UNIVERSE = new Set([...WATCHLIST, ...TAPE_TICKERS, ...INDEX_TICKERS]);


// 다음 KEY EVENT = 워치리스트 종목의 가장 가까운 실적 (없으면 시장 전체 최근접)
export const GET: RequestHandler = async () => {
  const [earn, feed] = await Promise.all([getEarnings(21), getFeed()]);
  const now = Date.now();

  const future = earn
    .filter((e) => UNIVERSE.has(e.ticker)) // 알파벳순 마이크로캡 노이즈 제거
    .map((e) => ({ ...e, ts: earnEpoch(e.date, e.hour), pendingFrom: earnPendingFrom(e.date, e.hour) }))
    .filter((e) => e.ts > now - 2 * 3600e3) // 시작 2시간 전까지 유효 유지
    .sort((a, b) => a.ts - b.ts);

  const watchSet = new Set(WATCHLIST);

  // 워치리스트 종목 먼저, 그다음 시장 전체 순으로 정렬 (시간순 유지하되 워치 우선 가중)
  const sorted = [...future].sort((a, b) => {
    const aw = watchSet.has(a.ticker) ? 0 : 1;
    const bw = watchSet.has(b.ticker) ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return a.ts - b.ts;
  });

  const hourLabel = (h: string) => h === "bmo" ? "장전" : h === "amc" ? "장마감후" : "장중";
  const dateLabel = (ts: number) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(new Date(ts));
  const timeLabel = (ts: number) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(ts));

  // ※ 예전 코드는 `new Date(ts).toDateString()` 을 썼는데, 이건 **서버 로컬 타임존**으로 날짜를 자른다.
  //   한국(KST = ET+13/14)에서 돌리면 amc(16:30 ET) 실적이 KST 로는 다음날 새벽이라
  //   화면에 "Jul 22 · 장마감후 · D-1" 같은 자기모순이 떴다.
  //   ts 의 ET 날짜는 정의상 e.date 문자열 그 자체이므로 Intl 왕복이 아예 불필요하다.
  const todayET = Date.parse(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()) + "T00:00:00Z"
  );
  const ddays = (dateStr: string) => Math.round((Date.parse(dateStr + "T00:00:00Z") - todayET) / 864e5);

  // Claude Code 가 붙인 종목별 해설 (날짜·시각·EPS 는 여전히 Finnhub 값을 쓴다)
  const aiNotes = fresh(feed, "earnings_note");
  const noteMap = new Map<string, string>();
  for (const n of aiNotes?.payload.notes ?? []) noteMap.set(n.ticker, n.note);

  /**
   * 발표 시각이 지났는데 실제값이 아직 없는 구간을 명시한다.
   *
   * 실측: GOOGL amc 발표 후 10분 시점에 Finnhub·FMP·AlphaVantage **전부 epsActual=null**.
   * 무료 소스는 여기서 구조적으로 느리다. 속도를 못 올리면 못 올린다고 화면이 말해야 한다.
   * 이 공백에 "발표 전에 쓴 관측 기사"를 현재 상황처럼 띄우는 게 제일 나쁘다.
   */
  function earnStatus(e: (typeof future)[number]) {
    if (e.epsActual != null) return "reported" as const;   // 숫자 확보
    if (e.pendingFrom <= now) return "pending" as const;    // 발표됨 · 결과 집계중
    return "upcoming" as const;                            // 아직 발표 전
  }

  // 상세 리스트 (워치 우선, 최대 8개)
  const upcoming = sorted.slice(0, 8).map((e) => {
    const status = earnStatus(e);
    const surprisePct =
      e.epsActual != null && e.epsEst != null && e.epsEst !== 0
        ? ((e.epsActual - e.epsEst) / Math.abs(e.epsEst)) * 100
        : null;
    return {
      ticker: e.ticker,
      watch: watchSet.has(e.ticker),
      dateET: dateLabel(e.ts),
      timeET: timeLabel(e.ts),
      session: hourLabel(e.hour),
      // hour 가 빈 문자열이면 12:00 ET 는 코드가 찍은 임의값이다. 화면이 정밀 시각을 주장하면 안 된다.
      estimated: e.hour !== "bmo" && e.hour !== "amc",
      dday: ddays(e.date),
      epsEst: e.epsEst,
      epsActual: e.epsActual,
      surprisePct,
      status,
      // 결과 대기 중에는 AI 해설을 붙이지 않는다 — 발표 전에 쓴 해설이 결과처럼 읽힌다
      note: status === "pending" ? null : (noteMap.get(e.ticker) ?? null),
      time: new Date(e.ts).toISOString()
    };
  });

  // 헤더 카운트다운용 next = 시간순 가장 가까운 것 (워치 우선)
  const pick = sorted.find((e) => watchSet.has(e.ticker)) ??
    [...future].sort((a, b) => a.ts - b.ts)[0];

  // ── NEXT KEY EVENT ───────────────────────────────────
  // 1순위: Claude Code 가 고른 거시 일정(FOMC/CPI 등). Finnhub 무료는 경제 캘린더가 403 이라
  //        이건 API 로 대체할 수 없는 정보다. 단, 실적보다 늦은 이벤트면 실적이 먼저다.
  // 2순위: Finnhub 실적 캘린더
  const aiEvent = fresh(feed, "key_event");
  const aiTs = aiEvent ? Date.parse(aiEvent.payload.whenET) : NaN;
  const earnTs = pick ? pick.ts : Infinity;
  const useAi = aiEvent && Number.isFinite(aiTs) && aiTs > now - 2 * 3600e3 && aiTs <= earnTs;

  const next = useAi
    ? {
        title: aiEvent!.payload.title,
        time: new Date(aiTs).toISOString(),
        estimated: aiEvent!.payload.estimated,
        note: aiEvent!.payload.note,
        imp: aiEvent!.payload.importance,
        origin: "ai" as const
      }
    : pick
      ? {
          title: `${pick.ticker} EARNINGS${pick.hour === "bmo" ? " · PRE-MKT" : pick.hour === "amc" ? " · AFTER-MKT" : ""}`,
          time: new Date(pick.ts).toISOString(),
          // 시각이 추정치면 헤더가 "IN 3h 12m" 같은 정밀 카운트다운을 주장하면 안 된다
          estimated: pick.hour !== "bmo" && pick.hour !== "amc",
          note: noteMap.get(pick.ticker) ?? "",
          imp: watchSet.has(pick.ticker) ? 5 : 4,
          origin: "rule" as const
        }
      : null;

  return new Response(JSON.stringify({ next, upcoming }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
