import type { RequestHandler } from "./$types";
import { getEarnings, WATCHLIST, TAPE_TICKERS, INDEX_TICKERS } from "$lib/server/finnhub";
import { getFeed, fresh, type EarningsRecap } from "$lib/server/marketfeed";
import { earnEpoch, earnPendingFrom } from "$lib/server/et-time";
import { getLiveReactions } from "$lib/server/livequote";

// Finnhub 실적 캘린더는 전 시장(하루 수백 종목)을 알파벳순으로 준다.
// 필터가 없으면 우측 패널이 아무도 모르는 마이크로캡(ALEX·AMBZ·BCOW…)으로 채워진다.
// 화면에 의미 있는 종목만 남긴다.
const UNIVERSE = new Set([...WATCHLIST, ...TAPE_TICKERS, ...INDEX_TICKERS]);


// 다음 KEY EVENT = 워치리스트 종목의 가장 가까운 실적 (없으면 시장 전체 최근접)
export const GET: RequestHandler = async () => {
  const [earn, feed] = await Promise.all([getEarnings(21, 3), getFeed()]);
  const now = Date.now();

  const future = earn
    .filter((e) => UNIVERSE.has(e.ticker)) // 알파벳순 마이크로캡 노이즈 제거
    .map((e) => ({ ...e, ts: earnEpoch(e.date, e.hour), pendingFrom: earnPendingFrom(e.date, e.hour) }))
    // 최근 발표(리캡 대상)를 계속 보여주려면 과거 창을 넓혀야 한다. 48시간 = 전 거래일 발표 포함.
    // (getEarnings 는 미래만 주므로 lookbackDays=3 으로 과거 실적도 받아온다)
    // 리캡 자체의 유효기간(8h)이 "최근"의 실질 상한을 잡는다.
    .filter((e) => e.ts > now - 48 * 3600e3)
    .sort((a, b) => a.ts - b.ts);

  const watchSet = new Set(WATCHLIST);

  // 워치리스트 종목 먼저, 그다음 시장 전체 순으로 정렬 (시간순 유지하되 워치 우선 가중)
  const sorted = [...future].sort((a, b) => {
    const aw = watchSet.has(a.ticker) ? 0 : 1;
    const bw = watchSet.has(b.ticker) ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return a.ts - b.ts;
  });

  const hourLabel = (h: string) => h === "bmo" ? "PRE-MKT" : h === "amc" ? "AFTER-MKT" : "INTRADAY";
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

  // Claude Code 가 만든 최근 실적 리캡: result(예상 상회/하회) + tag(짧은 이유)는 정성 판단.
  // 반응 %(정량)는 아래에서 라이브 시세로 덮어쓴다 → Claude 값은 폴백일 뿐.
  const recap = fresh(feed, "earnings_recap");
  const recapMap = new Map<string, EarningsRecap["companies"][number]>();
  for (const c of recap?.payload.companies ?? []) recapMap.set(c.ticker, c);

  // 리캡 대상 종목의 **라이브 확장시간 반응**을 Yahoo 에서 가져온다 (20초 캐시).
  // 발표 후 주가는 계속 움직이므로 이 숫자는 매 폴링마다 갱신된다.
  const liveReactions = recapMap.size ? await getLiveReactions([...recapMap.keys()]) : new Map();

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

  // 각 종목 행 구성. 설명(note)은 넣지 않는다 — 결과/시장반응 데이터만.
  const rows = sorted.map((e) => {
    const status = earnStatus(e);
    const surprisePct =
      e.epsActual != null && e.epsEst != null && e.epsEst !== 0
        ? ((e.epsActual - e.epsEst) / Math.abs(e.epsEst)) * 100
        : null;
    const r = recapMap.get(e.ticker);
    const live = liveReactions.get(e.ticker);
    // 리캡의 result 를 Finnhub epsActual 보다 우선한다 (무료 소스는 발표 직후 null 이라 늦다)
    const result =
      r?.result ??
      (surprisePct == null ? null : surprisePct > 0.5 ? "beat" : surprisePct < -0.5 ? "miss" : "inline");
    return {
      ticker: e.ticker,
      watch: watchSet.has(e.ticker),
      dateET: dateLabel(e.ts),
      timeET: timeLabel(e.ts),
      session: hourLabel(e.hour),
      estimated: e.hour !== "bmo" && e.hour !== "amc",
      dday: ddays(e.date),
      epsEst: e.epsEst,
      epsActual: e.epsActual,
      surprisePct,
      status,
      ts: e.ts,
      // 최근 실적 결과 + 시장반응 (Claude 리캡 우선, 없으면 Finnhub 실제값에서 유도)
      result, // beat | miss | inline | null
      // ★ 반응 %는 라이브 시세 우선(계속 갱신), Yahoo 실패 시 Claude 스냅샷으로 폴백
      reactionPct: live ? live.changePct : (r?.reactionPct ?? null),
      reactionWhen: live
        ? live.session === "pre" ? "PRE" : live.session === "post" ? "AH" : "LIVE"
        : (r?.reactionWhen ?? null),
      reactionLive: !!live, // 라이브 값인지 (UI 가 표시/애니메이션 판단)
      tag: r?.tag ?? null,
      time: new Date(e.ts).toISOString()
    };
  });

  // ★ "최근에 나온 것들 순으로" — 발표된 것(reported/pending)을 위로, 최근 발표 먼저.
  //   그다음 예정(upcoming)을 가까운 순으로.
  const rank = (s: string) => (s === "reported" ? 0 : s === "pending" ? 1 : 2);
  const upcoming = rows
    .sort((a, b) => {
      const ra = rank(a.status), rb = rank(b.status);
      if (ra !== rb) return ra - rb;
      // 발표된 것끼리는 최근 발표가 위, 예정끼리는 가까운 것이 위
      return ra === 2 ? a.ts - b.ts : b.ts - a.ts;
    })
    .slice(0, 8);

  // 헤더 카운트다운용 next = **아직 발표 전인** 것 중 가장 가까운 것 (워치 우선)
  //   과거 실적(리캡 대상)이 섞여 있으므로 미래만 골라야 카운트다운이 성립한다.
  const upcomingOnly = future.filter((e) => e.pendingFrom > now).sort((a, b) => a.ts - b.ts);
  const pick = upcomingOnly.find((e) => watchSet.has(e.ticker)) ?? upcomingOnly[0];

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
          note: "",
          imp: watchSet.has(pick.ticker) ? 5 : 4,
          origin: "rule" as const
        }
      : null;

  return new Response(JSON.stringify({ next, upcoming }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
