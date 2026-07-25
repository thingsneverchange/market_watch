// ============================================================
//  라이브 확장시간(프리/애프터마켓) 시세
//
//  Finnhub·FMP 무료는 확장시간에 quote 를 갱신하지 않는다(전일 종가에 고정).
//  하지만 Yahoo v8 chart 에 includePrePost=true 를 붙이고 **실제 데이터포인트**를
//  읽으면 프리/애프터마켓 체결가가 나온다 (meta 필드는 null 이라 안 됨 — 포인트를 봐야 함).
//
//  실적 리캡의 result/tag(정성 판단)는 Claude 가 주고, 반응 %(정량)는 여기서 라이브로 얻는다.
//  Yahoo 비공식 엔드포인트라 실패는 흔하다 → 실패 시 null 을 돌려주고 호출자가 Claude 값으로 폴백.
// ============================================================

type Live = {
  changePct: number;
  session: "pre" | "post" | "regular";
  asOf: number;    // 체결 시각(ms)
  stale: boolean;  // 마지막 체결이 오래됨 → "라이브"가 아니다 (맥동 pip 억제용)
  // ★ 세션별 분해 — 실적은 "정규장에서 어떻게 끝났고, 시간외에서 얼마나 더 움직였나"가 핵심이다.
  //   한 개의 % 로는 그 두 가지를 구분할 수 없어 따로 싣는다. 값이 없으면 null.
  regularPct: number | null;  // 정규장 종가 vs 전일 종가 ("오늘 어떻게 끝났나")
  postPct: number | null;     // 시간외 마지막가 vs 정규장 종가 ("발표 후 얼마나")
  prePct: number | null;      // 장전 마지막가 vs 전일 종가
  price: number | null;       // 마지막 체결가
};

// ★ 실측(2026-07): Yahoo 가 429 를 반환하기 시작했다. 원인은 요청 총량 —
//   리액션 대상 12티커 × TTL 20s = 시간당 ~2160회 + 크로스에셋. 무료 비공식 엔드포인트엔 과했다.
//   반응 %는 40초 granularity 로 충분하다(발표 후 몇 시간짜리 지표). TTL 을 올려 총량을 절반으로.
const TTL_MS = 40_000;
const FAIL_MS = 60_000;
// 429 는 "잠깐 쉬라"는 신호다. 일반 실패(60초)와 같이 취급하면 재시도가 스로틀을 자가증폭한다.
const RATE_LIMIT_MS = 10 * 60_000;

// Yahoo 비공식 엔드포인트용 헤더. 맨 UA 만 보내면 CDN 휴리스틱에 더 쉽게 걸린다 → 현실적인 세트.
const YF_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  accept: "application/json,text/plain,*/*",
  "accept-language": "en-US,en;q=0.9",
  referer: "https://finance.yahoo.com/"
};
// ★ 라이브 판정 임계. etMinutes 는 '시:분'만 봐서 며칠 묵은 바(주말/야간)도 pre/post/regular 로
//   분류해버린다. 그러면 UI 가 옛 체결에 빨간 맥동 LIVE pip 을 붙이는 "가짜 라이브"가 된다.
//   → 마지막 체결이 이보다 오래됐으면 stale 로 표시해 pip 을 끈다. (프리/애프터는 분당 갱신되므로
//     12분 공백이면 사실상 거래가 멎은 것.)
const LIVE_STALE_MS = 12 * 60_000;

const cache = new Map<string, { at: number; data: Live | null }>();
const failUntil = new Map<string, number>();
const inflight = new Map<string, Promise<Live | null>>();

/** ET 기준 분(자정 이후). 확장시간 판정용. */
function etMinutes(ms: number): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(ms));
  const h = Number(p.find((x) => x.type === "hour")?.value ?? 0);
  const m = Number(p.find((x) => x.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** 429 를 만나면 이 시각까지 **모든 티커**의 요청을 멈춘다 (스로틀은 티커별이 아니라 IP 단위다) */
let globalRateLimitUntil = 0;

async function fetchOne(ticker: string): Promise<Live | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?interval=1m&range=1d&includePrePost=true`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3500);
  try {
    const r = await fetch(url, { headers: YF_HEADERS, signal: ctl.signal, cache: "no-store" });
    if (r.status === 429) {
      // 지터를 섞어 백오프 해제 시각이 몰리지 않게 한다
      globalRateLimitUntil = Date.now() + RATE_LIMIT_MS + Math.floor(Math.random() * 60_000);
      console.warn("[livequote] Yahoo 429 — 10분간 요청 중단");
      return null;
    }
    if (!r.ok) return null;
    const j: any = await r.json();
    const res = j?.chart?.result?.[0];
    if (!res) return null;

    const meta = res.meta ?? {};
    const regClose = Number(meta.regularMarketPrice);      // 가장 최근 정규장 종가
    const prevClose = Number(meta.chartPreviousClose ?? meta.previousClose); // 그 전 종가
    const ts: number[] = res.timestamp ?? [];
    const closes: (number | null)[] = res.indicators?.quote?.[0]?.close ?? [];

    // 마지막 유효 체결 포인트
    let lastPrice: number | null = null;
    let lastTs = 0;
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null && Number.isFinite(closes[i]!)) {
        lastPrice = Number(closes[i]);
        lastTs = Number(ts[i]) * 1000;
        break;
      }
    }
    if (lastPrice == null || !Number.isFinite(regClose) || regClose <= 0) return null;

    // ── 세션별 분해 ──────────────────────────────
    // ET 분 기준: 프리 04:00~09:30(240~570), 정규 09:30~16:00(570~960), 애프터 16:00~20:00(960~1200)
    let lastPre: number | null = null, lastReg: number | null = null, lastPost: number | null = null;
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i];
      if (c == null || !Number.isFinite(c)) continue;
      const m = etMinutes(Number(ts[i]) * 1000);
      if (m >= 240 && m < 570) lastPre = Number(c);
      else if (m >= 570 && m < 960) lastReg = Number(c);
      else if (m >= 960 && m < 1200) lastPost = Number(c);
    }
    const pct = (a: number | null, base: number) =>
      a != null && Number.isFinite(base) && base > 0 ? Math.round(((a - base) / base) * 10000) / 100 : null;
    const regClosePrice = lastReg ?? (Number.isFinite(regClose) ? regClose : null);
    const regularPct = regClosePrice != null && Number.isFinite(prevClose) && prevClose > 0
      ? Math.round(((regClosePrice - prevClose) / prevClose) * 10000) / 100 : null;
    const postPct = regClosePrice != null ? pct(lastPost, regClosePrice) : null;
    const prePct = Number.isFinite(prevClose) ? pct(lastPre, prevClose) : null;

    const min = etMinutes(lastTs);
    const inRegular = min >= 570 && min < 960; // 09:30~16:00 ET

    // 확장시간: 정규장 종가 대비 (= 실적 발표 후 반응)
    // 정규장 중: 전일 종가 대비 (= 그날의 등락)
    let changePct: number;
    let session: Live["session"];
    if (inRegular) {
      const base = Number.isFinite(prevClose) && prevClose > 0 ? prevClose : regClose;
      changePct = ((lastPrice - base) / base) * 100;
      session = "regular";
    } else {
      changePct = ((lastPrice - regClose) / regClose) * 100;
      session = min < 570 ? "pre" : "post";
    }

    const stale = Date.now() - lastTs > LIVE_STALE_MS;
    return {
      changePct: Math.round(changePct * 100) / 100, session, asOf: lastTs, stale,
      regularPct, postPct, prePct, price: lastPrice
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 티커의 라이브 확장시간 반응. 실패/미가용이면 null. */
export async function getLiveReaction(ticker: string): Promise<Live | null> {
  const now = Date.now();
  const hit = cache.get(ticker);
  if (hit && now - hit.at < TTL_MS) return hit.data;
  // 429 백오프 중엔 네트워크를 아예 건드리지 않는다 (마지막 값이 있으면 그것만 돌려준다)
  if (globalRateLimitUntil > now) return hit?.data ?? null;
  if ((failUntil.get(ticker) ?? 0) > now) return hit?.data ?? null;

  const running = inflight.get(ticker);
  if (running) return running;

  const p = (async () => {
    const data = await fetchOne(ticker);
    if (data) {
      cache.set(ticker, { at: Date.now(), data });
    } else {
      failUntil.set(ticker, Date.now() + FAIL_MS);
    }
    inflight.delete(ticker);
    return data;
  })();
  inflight.set(ticker, p);
  return p;
}

/** 여러 티커 병렬 (실패는 개별 null) */
export async function getLiveReactions(tickers: string[]): Promise<Map<string, Live>> {
  const out = new Map<string, Live>();
  await Promise.all(
    tickers.map(async (t) => {
      const r = await getLiveReaction(t);
      if (r) out.set(t, r);
    })
  );
  return out;
}
