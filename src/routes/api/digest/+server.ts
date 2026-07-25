import type { RequestHandler } from "./$types";
import { getMarketNews, getEarnings, newsTopic, shortHeadline, WATCHLIST, TAPE_TICKERS, INDEX_TICKERS, MAJORS } from "$lib/server/finnhub";
import { getFeed, fresh } from "$lib/server/marketfeed";
import { checkSuperseded } from "$lib/server/supersede";
import { earnPendingFrom } from "$lib/server/et-time";

// 이 종목들의 실적은 "시장 전체가 보는 사건"이다 — 발표되면 기존 판단이 낡는다 (INTC 등 대형주 포함)
const MAJOR = new Set([...WATCHLIST, ...INDEX_TICKERS, ...TAPE_TICKERS, ...MAJORS]);

export const GET: RequestHandler = async () => {
  const [news, feed, earn] = await Promise.all([getMarketNews(24), getFeed(), getEarnings(3)]);
  const nowSec = Date.now() / 1000;

  // 예전에는 level 내림차순으로만 정렬해서 "LIVE HEADLINES" 상단에
  // 20시간 전 level 5 기사가 영구히 박제됐다.
  // 반대로 순수 시간순으로 바꾸면 상단 두 줄이 칼럼·잡기사로 채워진다(실측).
  // → 시간 감쇠 점수: 6시간마다 레벨 1씩 깎는다.
  const decay = (n: { level: number; epoch: number }) =>
    n.level - (nowSec - n.epoch) / 3600 / 6;
  const ranked = [...news].sort((a, b) => decay(b) - decay(a));
  const top = ranked[0];

  // ── TOP STORY ────────────────────────────────────────
  // 1순위: Claude Code 가 만든 판단 (신선할 때만)
  // 2순위: 키워드 규칙 기반 (기존 동작)
  // 어느 쪽인지 화면이 표시할 수 있도록 source 를 반드시 실어 보낸다.
  // ★ 시간 신선도만으로는 부족하다.
  //   Claude 가 7분 전에 "실적 발표를 앞두고" 라고 썼는데 그 사이 실적이 나왔다면,
  //   그 판단은 7분밖에 안 됐어도 이미 낡았다. 생성 이후 지나간 사건을 확인한다.
  const rawAi = feed?.items?.top_story;
  const sup = rawAi
    ? checkSuperseded({
        generatedAt: rawAi.generatedAt,
        events: earn.map((e) => ({
          ticker: e.ticker,
          ts: earnPendingFrom(e.date, e.hour),
          important: MAJOR.has(e.ticker)
        }))
      })
    : { superseded: false, by: [] as string[] };

  // ★ confidence 게이트
  //   Claude 가 "신뢰할 출처를 찾지 못했다"고 스스로 밝힌(low) 판단은 헤드라인 자격이 없다.
  //   실제로 이런 문장이 방송 최상단에 올라갔다:
  //     "…다만 발표 직후 반응을 확인해 줄 신뢰할 출처를 아직 찾지 못했다(최신 속보 없음)"
  //   정직한 자백이지만 시청자에게는 쓸모가 없고, 그 자리엔 진짜 헤드라인이 있어야 한다.
  //   대형 이벤트 직후엔 색인된 기사가 없어 low 가 자주 나온다 → 그 구간은 규칙기반이 맡는다.
  const candidate = fresh(feed, "top_story");
  const lowConfidence = candidate?.payload.confidence === "low";
  const ai = sup.superseded || lowConfidence ? undefined : candidate;

  let driver;
  if (ai) {
    driver = {
      text: ai.payload.text,
      sentiment: ai.payload.sentiment,
      source: ai.payload.sources[0]?.title ?? "",
      url: ai.payload.sources[0]?.url ?? "",
      why: ai.payload.why,
      confidence: ai.payload.confidence,
      epoch: Math.floor(ai.generatedAt / 1000),
      origin: "ai" as const,
      supersededBy: null,
      aiHeld: false,
      noData: false
    };
  } else if (top) {
    driver = {
      // 규칙기반 폴백은 원문 헤드라인이라 길다 → 핵심 구절로 압축 (AI 판단은 이미 짧으니 그대로)
      text: shortHeadline(top.title),
      sentiment: top.sentiment,
      source: top.source,
      url: top.url,
      // 왜 규칙기반으로 내려왔는지를 화면이 말한다 (조용히 바꾸지 않는다)
      why: sup.superseded
        ? `${sup.by.join("·")} 실적 발표로 이전 AI 판단은 만료됨`
        : lowConfidence
          ? "AI 판단이 근거 부족(low)으로 보류됨 — 최신 헤드라인으로 대체"
          : "",
      confidence: "",
      epoch: top.epoch,
      origin: "rule" as const, // 인과를 계산하지 않은 키워드 규칙 결과
      supersededBy: sup.superseded ? sup.by : null,
      aiHeld: lowConfidence,
      noData: false
    };
  } else {
    driver = {
      text: "NO NEWS FEED", sentiment: "neu", source: "", url: "", why: "",
      confidence: "", epoch: 0, origin: "none" as const, supersededBy: null, aiHeld: false, noData: true
    };
  }

  // driver 로 쓴 기사는 리스트에서 제외 (같은 문장이 화면에 두 번 나오던 문제).
  // ★ 트레이더 관점: 양보다 신호. level≥3(시장 관련) 또는 분류된 것만 남기고, 그게 너무 적으면
  //   전체로 백필한다. 각 항목엔 대표 주체(topic) 칩을 붙여 "무엇에 관한 것"을 먼저 스캔하게 한다.
  // ★ YouTube 송출 → 다수 시청자가 1920 프레임을 폰에서 4~5배 축소해 본다.
  //   그래서 '적게·크게·짧게'. 4건만, 각 행을 크게 뽑아 축소해도 읽히게 한다.
  const pool = ranked.filter((n) => !top || n.id !== top.id);
  const signal = pool.filter((n) => n.matched || n.level >= 3);

  // ── TODAY 브리핑 (오늘의 핵심 이벤트+영향, Claude 생성) ──
  // 있으면 좌측 컬럼 공간을 나눠 쓰므로 헤드라인을 3건으로 줄인다. LIVE 판정은 클라이언트가 시각으로.
  const briefItem = fresh(feed, "market_brief");
  const brief = briefItem?.payload.items ?? null;

  const list = (signal.length >= 4 ? signal : pool)
    .slice(0, brief && brief.length ? 3 : 4)
    .map((n) => ({ ...n, topic: newsTopic(n.title, n.ticker), short: shortHeadline(n.title) }));

  return new Response(JSON.stringify({ driver, news: list, brief, serverNow: Math.floor(nowSec) }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
