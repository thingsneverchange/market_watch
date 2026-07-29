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

const TTL_MS = 60_000;
let cache: { at: number; data: SectorBoard } | null = null;
let inflight: Promise<SectorBoard> | null = null;

export async function getSectorBoard(): Promise<SectorBoard> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;

  inflight = (async () => {
    const live = marketState().open;
    // SPY 를 같이 받아 상대 수익을 낸다. 저우선 — 헤더 시세 예산을 먹지 않게.
    const quotes = await getQuotes([...SECTORS.map((s) => s.key), "SPY"], 60_000, true);
    const by = new Map(quotes.map((q) => [q.ticker, q]));
    const bench = by.get("SPY")?.changePct ?? null;

    const rows: SectorRow[] = [];
    for (const s of SECTORS) {
      const q = by.get(s.key);
      if (!q) continue;                       // 못 받은 섹터는 **빈칸으로 둔다** (0 으로 채우지 않는다)
      rows.push({
        key: s.key,
        label: s.label,
        pct: q.changePct,
        rel: bench == null ? null : Math.round((q.changePct - bench) * 100) / 100,
        live
      });
    }
    rows.sort((a, b) => b.pct - a.pct);

    const spread = rows.length >= 2
      ? Math.round((rows[0].pct - rows[rows.length - 1].pct) * 100) / 100
      : null;

    const data: SectorBoard = { rows, benchPct: bench, live, spread };
    // 빈 결과는 캐시하지 않는다 — 실패를 사실처럼 굳히는 실수가 이 저장소에 여러 번 있었다
    if (rows.length) cache = { at: Date.now(), data };
    return data;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
