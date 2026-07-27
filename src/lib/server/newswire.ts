import { scoreNews, type NewsItem } from "./finnhub";
import { isFragment, isColumnBrand, isBlockedPublisher, isPressRelease } from "./headline";
import { isNearDuplicate } from "./dedupe";
import { parseRss } from "./rss";

// ============================================================
//  실시간 뉴스 와이어 (무료 RSS)
//
//  ── 왜 필요했나 ───────────────────────────────────
//  화면의 뉴스는 Finnhub `/news?category=general` 하나가 전부였다. 실측:
//     화면에 떠 있던 6건 — 최신 598분(10시간), 중앙값 979분(16시간), 최고 2,352분(39시간)
//     45분 이내: **0건**.  전부 같은 주제(이란/유가) 한 덩어리.
//  즉 "오늘 뉴스"가 한 건도 안 들어오고 있었다. 속보 사이렌이 한 번도 안 울린 것도
//  로직 문제가 아니라 이것 때문이다 — 45분 이내 기사가 존재하지 않으니 조건이 도달 불가였다.
//
//  실제로 놓친 사건: 장중 10시 CXMT(창신메모리) 상장 관련 반도체 이슈.
//  그 시각 나스닥 선물은 30분간 −0.56%(z 2.1), SOXX 는 당일 −1.02% 로 밀리고 있었는데
//  화면은 12시간 전 금 기사를 MARKET DRIVER 로 띄우고 있었다.
//
//  ── 프로덕션 IP 에서 직접 잰 값 (DigitalOcean, 2026-07-27 10:0x ET) ──
//    GoogleNews:markets   n=100  최신  4분   45분 이내 12건
//    MarketWatch:top      n= 10  최신  5분   45분 이내  4건
//    CNBC:top             n= 30  최신  8분   45분 이내  4건
//    CNBC:tech            n= 30  최신 11분   ← CXMT 기사가 여기 있었다
//    GoogleNews:semi      n=100  최신 31분
//  전부 무료·무인증이고 데이터센터 IP 에서 막히지 않는다
//  (Yahoo 는 데이터센터 IP 를 차단하므로 넣지 않았다 — 개발용 맥에선 되고 프로덕션에선 안 된다).
//
//  ── 설계 원칙 ─────────────────────────────────────
//  · 피드 하나가 죽어도 나머지로 방송한다. 실패는 격리하고 **캐시하지 않는다**
//    (실패를 사실처럼 캐시해서 데이터가 통째로 사라진 사고가 이 저장소에 세 번 있었다).
//  · 나이는 숨기지 않는다. epoch 를 그대로 실어 화면이 "몇 분 전"을 직접 말하게 한다.
//  · 같은 사건이 여러 매체에 뜨므로 제목 유사도로 합친다. 원 발행이 이른 쪽을 남긴다.
// ============================================================

type Feed = { name: string; url: string };

// 넓이(마켓 전반) + 깊이(반도체·메모리)를 같이 본다.
// 반도체를 따로 두는 이유: 이 방송에서 지수를 실제로 흔드는 건 반도체와 빅테크인데,
// 종합 피드에선 반도체 기사가 다른 기사에 묻혀 상위에 안 올라온다.
const FEEDS: Feed[] = [
  { name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  { name: "CNBC Tech", url: "https://www.cnbc.com/id/19854910/device/rss/rss.html" },
  { name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
  { name: "Google News", url: "https://news.google.com/rss/search?q=stock+market+nasdaq+when:1d&hl=en-US&gl=US&ceid=US:en" },
  { name: "Google News", url: "https://news.google.com/rss/search?q=semiconductor+OR+chip+OR+DRAM+OR+HBM+when:1d&hl=en-US&gl=US&ceid=US:en" }
];

const TTL_MS = 75_000;          // 폴링 주기. 5개 피드 × 75초 ≈ 분당 4요청 (예의상 상한)
const FETCH_TIMEOUT_MS = 12_000;
const MAX_AGE_MS = 12 * 3600_000; // 와이어의 존재 이유는 최신성이다. 12시간 넘은 건 안 싣는다.
const UA = "Mozilla/5.0 (compatible; market-watch/1.0; +broadcast overlay)";

let cache: { at: number; items: NewsItem[] } | null = null;
let inflight: Promise<NewsItem[]> | null = null;
/** 마지막 성공분 — 전 피드가 동시에 죽어도 화면이 비지 않게 붙잡는다 */
let lastGood: NewsItem[] = [];

function toNews(xml: string, feedName: string): NewsItem[] {
  return parseRss(xml, feedName).map((r) => {
    const s = scoreNews(r.title);
    return {
      id: r.url,
      title: r.title,
      source: r.source,
      url: r.url,
      epoch: r.epoch,
      timeET: "",            // digest 라우트가 자기 포맷으로 다시 찍는다
      level: s.level,
      sentiment: s.sentiment,
      matched: s.matched
    };
  });
}

async function fetchFeed(f: Feed): Promise<NewsItem[]> {
  try {
    const r = await fetch(f.url, {
      headers: { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store"
    });
    if (!r.ok) {
      console.warn(`[newswire] ${f.name} HTTP ${r.status}`);
      return [];
    }
    return toNews(await r.text(), f.name);
  } catch (e) {
    console.warn(`[newswire] ${f.name} 실패: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
    return [];
  }
}

/**
 * 실시간 와이어. 실패해도 예외를 던지지 않는다 — 방송이 멈추면 안 된다.
 * 반환은 최신순. 나이는 각 항목의 epoch 로 그대로 드러난다.
 */
export async function getWireNews(limit = 40): Promise<NewsItem[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.items.slice(0, limit);
  if (inflight) return (await inflight).slice(0, limit);

  inflight = (async () => {
    const batches = await Promise.all(FEEDS.map(fetchFeed));
    const all = batches.flat();

    const fresh = all
      .filter((n) => now - n.epoch * 1000 <= MAX_AGE_MS)
      // 방송 게이트: 잘린 문장과 칼럼 브랜드("Morning Bid", "Market Wrap")는 사건이 아니다.
      // ※ 지금 화면을 채우고 있던 6건 중 하나가 바로 "Morning Bid: …" 였다.
      .filter((n) => !isFragment(n.title) && !isColumnBrand(n.title))
      .filter((n) => !isBlockedPublisher(n.source) && !isPressRelease(n.title))
      .sort((a, b) => b.epoch - a.epoch);

    // 같은 사건이 여러 매체에 뜬다. 최신순으로 훑으며 이미 담은 것과 비슷하면 버린다.
    const merged: NewsItem[] = [];
    for (const n of fresh) {
      if (merged.some((m) => isNearDuplicate(m.title, n.title))) continue;
      merged.push(n);
    }

    // 전 피드가 동시에 죽은 경우에만 마지막 성공분으로 간다.
    // 일부만 죽었으면 남은 것으로 방송한다 — 실패를 캐시해 데이터를 지우지 않는다.
    if (!merged.length) {
      console.warn("[newswire] 모든 피드 실패 — 마지막 성공분 사용");
      return lastGood;
    }
    lastGood = merged.slice(0, 60);
    cache = { at: Date.now(), items: merged };
    return merged;
  })();

  try {
    return (await inflight).slice(0, limit);
  } finally {
    inflight = null;
  }
}

/** 진단용 — /api/settings 등에서 와이어 상태를 드러낼 때 쓴다 */
export function wireStatus(): { at: number | null; count: number; newestMin: number | null } {
  const items = cache?.items ?? lastGood;
  const newest = items.length ? items[0].epoch * 1000 : null;
  return {
    at: cache?.at ?? null,
    count: items.length,
    newestMin: newest ? Math.round((Date.now() - newest) / 60_000) : null
  };
}
