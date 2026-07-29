import { getQuotes } from "./finnhub";
import { marketState } from "../market-hours";

// ============================================================
//  섹터 히트맵 — "오늘 돈이 어디서 어디로 갔나"
//
//  ── 왜 필요한가 ───────────────────────────────────
//  화면은 지수와 개별 대형주만 보여 준다. 그런데 실제로 하루를 설명하는 건 로테이션이다.
//  실측(2026-07-29 01:14 ET): XLK −1.84% 인데 XLF +1.27% 였다. 지수는 밋밋해도
//  그 안에서 테크에서 금융으로 크게 돌고 있었고, 화면엔 그 말을 할 자리가 없었다.
//
//  ── 왜 ETF 인가 (정직하게) ────────────────────────
//  섹터 지수 원본은 무료로 못 얻는다. Finviz 의 groups 엔드포인트는 **죽었다**
//  (실측: /api/groups.ashx → 301 → /api/groups → 404).
//  그래서 SPDR 섹터 ETF 로 대신한다. ETF 는 섹터 지수를 **근사**할 뿐이다 —
//  운용보수·현금 비중·리밸런싱 시차가 있어 소수점 아래가 지수와 다르다.
//  그래서 라벨에 티커를 그대로 남긴다. "TECH 171.09" 라고만 쓰면 무슨 값인지 모른다.
//
//  ── 세션 정직성 ───────────────────────────────────
//  전부 미국 상장 ETF 라 **정규장에만 움직인다.** 무료 티어는 확장시간 시세를
//  갱신하지 않으므로, 장 밖에는 전일 종가가 그대로 온다 → live=false 로 실어 보내
//  화면이 흐리게 처리하게 한다. 이 저장소가 헤더에서 이미 하는 규칙과 같다.
// ============================================================

/** SPDR 섹터 ETF + 반도체. 순서는 화면 표시 순서다(시총 비중이 큰 것부터). */
const SECTORS: { key: string; label: string }[] = [
  { key: "XLK",  label: "TECH" },
  { key: "SOXX", label: "SEMIS" },        // 이 방송에서 지수를 실제로 흔드는 축
  { key: "XLC",  label: "COMM" },
  { key: "XLY",  label: "CONS DISC" },
  { key: "XLF",  label: "FINANCIALS" },
  { key: "XLV",  label: "HEALTH" },
  { key: "XLI",  label: "INDUSTRIAL" },
  { key: "XLP",  label: "STAPLES" },
  { key: "XLE",  label: "ENERGY" },
  { key: "XLU",  label: "UTILITIES" },
  { key: "XLB",  label: "MATERIALS" },
  { key: "XLRE", label: "REAL ESTATE" }
];

export type SectorRow = {
  key: string;
  label: string;
  pct: number;
  /** S&P(SPY) 대비 초과 수익, %p. 로테이션은 절대 등락이 아니라 이걸로 읽는다 */
  rel: number | null;
  live: boolean;
};

export type SectorBoard = {
  rows: SectorRow[];
  benchPct: number | null;
  live: boolean;
  /** 1등과 꼴찌의 격차(%p) — 로테이션의 세기. 작으면 "다 같이 움직인 날"이다 */
  spread: number | null;
};

// 섹터는 **당일 등락**이라 60초 단위로 볼 값이 아니다. TTL 을 늘리면 요청 빈도가
// 5분의 1로 떨어져 쿼터 경합에서 살아남는다 (실측: 60초 TTL 일 때 12칸 중 6칸만 찼다).
const TTL_MS = 5 * 60_000;
/** 섹터별 마지막 성공값. 쿼터 경합으로 응답이 매번 일부만 오기 때문에 필요하다. */
const lastGood = new Map<string, { pct: number; at: number }>();
/** 이보다 오래된 값은 버린다 — 한 세션을 넘기면 그건 다른 날 얘기다 */
const LAST_GOOD_MS = 6 * 3600_000;
/** 덜 찼을 때의 재시도 간격 — 쿼터가 풀리면 바로 이어서 채운다 */
const RETRY_MS = 20_000;

let cache: { at: number; data: SectorBoard } | null = null;
let inflight: Promise<SectorBoard> | null = null;

export async function getSectorBoard(): Promise<SectorBoard> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;

  inflight = (async () => {
    const live = marketState().open;
    // SPY 를 같이 받아 상대 수익을 낸다. 저우선 — 헤더 시세 예산을 먹지 않게.
    // ★ 아직 못 받은 것부터 요청한다. 저우선 쿼터(분당 16)를 시총 스윕·기업뉴스와
    //   나눠 쓰므로 13개를 한 번에 달라고 하면 매번 앞의 6개만 온다 —
    //   그러면 목록 뒤쪽(에너지·유틸리티·소재·리츠)은 **영원히 안 찬다.**
    //   빈 것부터 채우면 몇 번의 폴로 전부 돈다.
    const missing = SECTORS.filter((x) => !lastGood.has(x.key)).map((x) => x.key);
    const ask = [...new Set([...missing, ...SECTORS.map((x) => x.key)])].slice(0, 8);
    const quotes = await getQuotes([...ask, "SPY"], 60_000, true);
    const by = new Map(quotes.map((q) => [q.ticker, q]));
    const bench = by.get("SPY")?.changePct ?? null;

    // ★ 섹터별 마지막 성공값을 들고 간다.
    //   Finnhub 쿼터 경합으로 매번 일부만 온다(실측: 12칸 중 6칸). 없는 걸 0 으로
    //   채우지는 않지만, 그렇다고 폴마다 칸 수가 6↔9↔12 로 널뛰면 방송 화면에서
    //   그 자체가 사고처럼 보인다. 값을 지어내는 게 아니라 **마지막에 실제로 받은 값**을
    //   유지하는 것이고, 나이는 live 플래그와 세션 라벨이 이미 드러낸다.
    const rows: SectorRow[] = [];
    for (const s of SECTORS) {
      const q = by.get(s.key);
      if (q) lastGood.set(s.key, { pct: q.changePct, at: now });
      const g = lastGood.get(s.key);
      if (!g || now - g.at > LAST_GOOD_MS) continue;   // 너무 오래된 건 버린다
      rows.push({
        key: s.key,
        label: s.label,
        pct: g.pct,
        rel: bench == null ? null : Math.round((g.pct - bench) * 100) / 100,
        live
      });
    }
    rows.sort((a, b) => b.pct - a.pct);

    const spread = rows.length >= 2
      ? Math.round((rows[0].pct - rows[rows.length - 1].pct) * 100) / 100
      : null;

    const data: SectorBoard = { rows, benchPct: bench, live, spread };
    // ★ **불완전한 결과를 오래 캐시하지 않는다.**
    //   실측: 재시작 직후 6칸만 받은 상태로 5분 캐시가 걸려, 그 5분 동안 나머지를
    //   채울 기회를 스스로 막았다. 몇 번을 호출해도 계속 6칸이었다.
    //   다 채웠으면 길게, 덜 채웠으면 짧게 — 다음 호출이 이어서 채운다(lastGood 누적).
    //   빈 결과는 아예 캐시하지 않는다.
    if (rows.length) {
      const full = rows.length === SECTORS.length;
      cache = { at: Date.now() - (full ? 0 : TTL_MS - RETRY_MS), data };
    }
    return data;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
