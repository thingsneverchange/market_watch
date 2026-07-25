import type { RequestHandler } from "./$types";
import { getEarnings, WATCHLIST, TAPE_TICKERS, INDEX_TICKERS, MAJORS } from "$lib/server/finnhub";
import { getFeed, fresh, type EarningsRecap } from "$lib/server/marketfeed";
import { earnEpoch, earnPendingFrom } from "$lib/server/et-time";
import { getLiveReactions } from "$lib/server/livequote";

// Finnhub 실적 캘린더는 전 시장(하루 수백 종목)을 알파벳순으로 준다.
// 필터가 없으면 우측 패널이 아무도 모르는 마이크로캡(ALEX·AMBZ·BCOW…)으로 채워진다.
// ★ 단, 유니버스가 좁으면 INTEL(INTC) 같은 대형 실적이 통째로 사라진다 → MAJORS 로 넓게 잡는다.
const UNIVERSE = new Set([...WATCHLIST, ...TAPE_TICKERS, ...INDEX_TICKERS, ...MAJORS]);


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

  const hourLabel = (h: string) => h === "bmo" ? "장전" : h === "amc" ? "장마감후" : "장중";
  // 한국어 방송 표기: "7/24" (미 동부 날짜 기준)
  const dateLabel = (ts: number) =>
    new Intl.DateTimeFormat("ko-KR", { timeZone: "America/New_York", month: "numeric", day: "numeric" })
      .format(new Date(ts)).replace(/\.\s*$/, "").replace(/\.\s*/g, "/");
  const timeLabel = (ts: number) =>
    new Intl.DateTimeFormat("ko-KR", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts));

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

  // 라이브 확장시간 반응(Yahoo, 20초 캐시)을 가져올 대상 =
  //   Claude 리캡 종목 + **최근 발표된(발표시각 지난) 모든 대형주**.
  //   ★ 예전엔 리캡 목록만 대상이라, INTEL 처럼 방금 실적 낸 종목이 반응 %도 없이 묻혔다.
  // ★ 반응 윈도우: 발표 후 24시간(발표 직후 시간외 + 다음 정규장)만 "실적 반응"이다.
  //   그 이후의 등락은 그냥 그날 시세지 실적 반응이 아니다 — 이틀 지난 GOOGL 에
  //   당일 시간외 %가 '실적 반응'인 척 계속 붙어 있던 문제(데이터 정직성)를 여기서 끊는다.
  const REACTION_WINDOW_MS = 24 * 3600e3;
  const inReactionWindow = (e: { pendingFrom: number }) =>
    e.pendingFrom <= now && now - e.pendingFrom < REACTION_WINDOW_MS;

  const reportedTickers = future
    .filter((e) => inReactionWindow(e))
    .sort((a, b) => b.ts - a.ts)
    .map((e) => e.ticker);

  // ★ "오늘 발표 예정"인 종목도 라이브 시세를 붙인다 — 발표 **전** 주가가 어떻게 움직이는지
  //   (기대감/경계감)가 시청자에게 의미 있다. 단, 이건 '실적 반응'이 아니라 '당일 등락'이므로
  //   아래에서 phase 를 구분해 라벨을 다르게 준다 (INTO PRINT vs 반응).
  const todayTickers = future
    .filter((e) => ddays(e.date) === 0 && e.pendingFrom > now)
    .map((e) => e.ticker);

  // ★ 요청 총량 관리: Yahoo 는 비공식 무료 엔드포인트라 IP 단위 429 가 실재한다(실측).
  //   화면에 실제로 보이는 만큼만 조회한다 — 6개면 상단 실적 행을 모두 덮는다.
  //   (12개 × 짧은 TTL 이 시간당 요청을 2천 회대로 밀어올려 429 를 유발했다)
  const reactionTargets = [...new Set([...recapMap.keys(), ...reportedTickers, ...todayTickers])].slice(0, 6);
  const liveReactions = reactionTargets.length ? await getLiveReactions(reactionTargets) : new Map();

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
    // 두 국면을 구분한다:
    //  · reaction  = 발표 후 24시간 → 이건 '실적 반응'
    //  · pre       = 오늘 발표 예정(아직 전) → 이건 '발표를 앞둔 당일 등락'이지 반응이 아니다
    //  그 외(이틀 지난 발표 등)엔 %를 아예 붙이지 않는다 → REPORTED + EPS 로 통일.
    const isPrePrint = e.pendingFrom > now && ddays(e.date) === 0;
    const movePhase: "reaction" | "pre" | null =
      inReactionWindow(e) ? "reaction" : isPrePrint ? "pre" : null;
    const live = movePhase ? liveReactions.get(e.ticker) : undefined;
    // 라이브지만 마지막 체결이 오래됐으면(주말·야간·거래정지) "라이브"가 아니다 → pip 을 끈다.
    const liveFresh = !!live && !live.stale;
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
      // ★ %는 라이브 시세 우선(계속 갱신). Claude 스냅샷 폴백은 '발표 후'에만 유효하다
      //   (발표 전 종목에 리캡 값을 붙이면 나오지도 않은 반응을 지어내는 셈이다).
      //   stale 이어도 마지막 체결값 자체는 유효하므로 %는 보여 주되, reactionLive 로 pip 만 끈다.
      reactionPct: live ? live.changePct : (movePhase === "reaction" ? (r?.reactionPct ?? null) : null),
      reactionWhen: liveFresh
        ? live!.session === "pre" ? "PRE" : live!.session === "post" ? "AH" : "LIVE"
        : (movePhase === "reaction"
            ? (r?.reactionWhen ?? (live ? (live.session === "pre" ? "PRE" : live.session === "post" ? "AH" : null) : null))
            : null),
      reactionLive: liveFresh, // 진짜 라이브(최근 체결)일 때만 맥동 pip
      movePhase,              // "reaction"(발표 후) | "pre"(오늘 발표 예정) | null → UI 라벨 분기
      tag: r?.tag ?? null,
      time: new Date(e.ts).toISOString()
    };
  });

  // ★ "최근에 나온 것들 순으로" — 이미 발표된 것(reported+pending)을 **하나로 묶어** 최근 순으로,
  //   예정(upcoming)만 뒤로 보낸다.
  //   예전엔 reported(0) < pending(1) 로 나눠서, 어젯밤 막 발표한 pending(INTEL)이
  //   숫자가 집계된 어제 아침 reported 들보다 아래로 밀려 8행에서 잘려나갔다.
  const rank = (s: string) => (s === "upcoming" ? 1 : 0); // 발표 완료(reported/pending) 먼저
  const upcoming = rows
    .sort((a, b) => {
      const ra = rank(a.status), rb = rank(b.status);
      if (ra !== rb) return ra - rb;
      // 발표된 것끼리는 최근 발표가 위, 예정끼리는 가까운 것이 위
      return ra === 1 ? a.ts - b.ts : b.ts - a.ts;
    })
    .slice(0, 8);

  // ── UPCOMING (다가오는 주요 이벤트 2개) ─────────────────
  // Claude 가 고른 거시 일정(FOMC/CPI 등 — Finnhub 무료는 경제 캘린더 403 이라 API 대체 불가)과
  // 다가오는 실적을 **시간순으로 병합**해 가장 가까운 2개를 보여 준다.
  const upcomingOnly = future.filter((e) => e.pendingFrom > now).sort((a, b) => a.ts - b.ts);
  const aiEvent = fresh(feed, "key_event");
  const aiTs = aiEvent ? Date.parse(aiEvent.payload.whenET) : NaN;

  // ★ 성격이 다른 두 종류를 섞지 않는다 — 화면에서 따로 그룹으로 보여 준다.
  //   · MACRO  = 거시/정책 일정 (FOMC·CPI 등). Finnhub 무료는 경제 캘린더 403 이라 Claude 가 채운다.
  //   · EARNINGS = 개별 종목 실적 (Finnhub 캘린더)
  const macroEvents = [];
  if (aiEvent && Number.isFinite(aiTs) && aiTs > now - 2 * 3600e3) {
    macroEvents.push({
      title: aiEvent.payload.title,
      time: new Date(aiTs).toISOString(),
      estimated: aiEvent.payload.estimated,
      note: aiEvent.payload.note,
      imp: aiEvent.payload.importance,
      origin: "ai" as const
    });
  }

  const earningsEvents = upcomingOnly.slice(0, 3).map((e) => ({
    ticker: e.ticker,
    title: `${e.ticker} EARNINGS`,
    time: new Date(e.ts).toISOString(),
    session: hourLabel(e.hour),          // PRE-MKT | AFTER-MKT | INTRADAY
    // 시각이 추정치면 정밀 카운트다운을 주장하지 않는다 (IN ~3d 로 낮춘다)
    estimated: e.hour !== "bmo" && e.hour !== "amc",
    dday: ddays(e.date),
    watch: watchSet.has(e.ticker),
    imp: watchSet.has(e.ticker) ? 5 : 4,
    origin: "rule" as const
  }));

  // 하위호환: 두 종류를 시간순으로 합친 예전 형태도 계속 내보낸다
  const nextEvents = [...macroEvents, ...earningsEvents]
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .slice(0, 2);
  const next = nextEvents[0] ?? null;

  return new Response(JSON.stringify({ next, nextEvents, macroEvents, earningsEvents, upcoming }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
