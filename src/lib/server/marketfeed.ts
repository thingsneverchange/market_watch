// ============================================================
//  market-feed 클라이언트 (Claude Code 가 생성한 판단을 가져온다)
//
//  원칙은 Finnhub 쪽과 동일하다:
//   · 실패하면 조용히 옛 값을 새 값인 척 내보내지 않는다
//   · 낡은 데이터는 숨기지 않고 낡았다고 표시한다 → 화면이 규칙기반으로 폴백
//   · 읽기 키는 **서버에서만** 쓴다. 브라우저로 절대 내보내지 않는다.
// ============================================================
import { env } from "$env/dynamic/private";

type FeedItem<T> = {
  payload: T;
  model: string | null;
  generatedAt: number;
  ageSec: number;
  stale: boolean;
};

export type TopStory = {
  text: string;
  sentiment: "pos" | "neg" | "neu";
  why: string;
  confidence: "high" | "medium" | "low";
  sources: { title: string; url: string }[];
};

export type KeyEvent = {
  title: string;
  whenET: string;
  importance: number;
  note: string;
  estimated: boolean;
};

export type EarningsNote = { notes: { ticker: string; note: string }[] };

export type EarningsRecap = {
  companies: {
    ticker: string;
    result: "beat" | "miss" | "inline";
    reactionPct: number | null;
    reactionWhen: string | null;
    tag: string | null;
  }[];
};

export type Feed = {
  serverNow: number;
  items: {
    top_story?: FeedItem<TopStory>;
    key_event?: FeedItem<KeyEvent>;
    earnings_note?: FeedItem<EarningsNote>;
    earnings_recap?: FeedItem<EarningsRecap>;
  };
};

const TTL_MS = 30_000; // 오버레이가 15초마다 폴링해도 피드 서버는 30초에 한 번만 친다
const FAIL_BACKOFF_MS = 60_000;
const MAX_STALE_MS = 10 * 60_000;

let cache: { at: number; data: Feed } | null = null;
let failUntil = 0;
let inflight: Promise<Feed | null> | null = null;

/**
 * 피드를 가져온다. 실패하거나 설정이 없으면 null — 호출부가 규칙기반으로 폴백한다.
 * null 은 "AI 판단 없음"을 뜻하고, 화면은 그 사실을 표시해야 한다.
 */
export async function getFeed(): Promise<Feed | null> {
  const base = String(env.MARKET_FEED_URL || "").replace(/\/+$/, "");
  const key = String(env.MARKET_READ_KEY || "").trim();
  if (!base || !key) return null; // 미설정 = 기능 꺼짐 (에러 아님)

  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  if (failUntil > now) {
    return cache && now - cache.at < MAX_STALE_MS ? cache.data : null;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000); // 방송 화면을 4초 넘게 붙잡지 않는다
      const r = await fetch(`${base}/api/feed`, {
        headers: { authorization: `Bearer ${key}` },
        signal: ctl.signal,
        cache: "no-store"
      }).finally(() => clearTimeout(timer));

      if (!r.ok) {
        failUntil = Date.now() + FAIL_BACKOFF_MS;
        console.warn(`[market-feed] ${r.status} — 규칙기반으로 폴백합니다`);
        return cache && Date.now() - cache.at < MAX_STALE_MS ? cache.data : null;
      }
      const j = (await r.json()) as Feed;
      cache = { at: Date.now(), data: j };
      failUntil = 0;
      return j;
    } catch (e: any) {
      failUntil = Date.now() + FAIL_BACKOFF_MS;
      console.warn(`[market-feed] 연결 실패 (${e?.name ?? e}) — 규칙기반으로 폴백합니다`);
      return cache && Date.now() - cache.at < MAX_STALE_MS ? cache.data : null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** 신선한 항목만 돌려준다. stale 이면 undefined → 호출부가 폴백. */
export function fresh<K extends keyof Feed["items"]>(
  feed: Feed | null,
  kind: K
): NonNullable<Feed["items"][K]> | undefined {
  const it = feed?.items?.[kind];
  if (!it || it.stale) return undefined;
  return it as NonNullable<Feed["items"][K]>;
}
