import type { RequestHandler } from "./$types";
import { getFutures, type Timeframe } from "$lib/server/finviz";
import { getIndexQuote, getIndexSeries, NAVER_INDEXES } from "$lib/server/naver";

// ============================================================
//  메인 차트용 선물 시계열
//
//  왜 자체 렌더인가 (TradingView 무료 임베드를 메인에서 뺀 이유):
//   1) 주말에 **완전히 빈 화면**이 된다. 실측으로 O∅ H∅ L∅ C∅ 를 반환하고
//      캔들이 하나도 안 그려졌다. 24시간 방송에서 화면 한가운데가 매주 이틀씩
//      검은 사각형이 된다는 뜻이다.
//   2) 무료 임베드는 애초에 NQ 같은 **선물을 못 그린다**. 정규장 QQQ 밖에 못 띄운다.
//   3) iframe 이 사라져 메모리·CPU 가 준다 (24시간 송출에서 중요).
//
//  Finviz 5분봉은 우리가 캐시로 들고 있으므로 주말·휴장에도 마지막 세션이 그대로 남는다.
//  → 화면이 비지 않는다.
// ============================================================

const TF: Record<string, Timeframe> = { m5: "m5", h1: "h1", d1: "d1" };

// 방송 화면에서 300 포인트는 과하다(선이 뭉갠다). 균등 샘플링하되 마지막 점은 보존한다.
function sample(arr: number[], n: number) {
  if (arr.length <= n) return { pts: arr, idx: arr.map((_, i) => i) };
  const step = (arr.length - 1) / (n - 1);
  const idx = Array.from({ length: n }, (_, i) => Math.round(i * step));
  return { pts: idx.map((i) => arr[i]), idx };
}

/**
 * 종가 시계열을 봉으로 묶는다.
 *
 * ※ 정직하게 밝혀둘 것: Finviz 무료 엔드포인트는 **봉별 OHLC 를 주지 않는다**.
 *   응답의 high/low 는 그날 전체의 고가·저가 하나뿐이고 시계열은 종가 배열이다.
 *   (finviz.com/api/quote.ashx 등 후보 엔드포인트 전부 404 로 확인)
 *   그래서 여기서 만드는 봉은 **5분 종가를 묶은 것**이다 —
 *   시가·종가는 정확하고, 꼬리(고가·저가)는 5분 종가 기준이라 실제보다 짧을 수 있다.
 *   화면에도 "5m closes" 라고 표기해서 진짜 틱 캔들인 척하지 않는다.
 *   진짜 틱 캔들은 정규장 TradingView 모드에서 나온다.
 */
function toCandles(closes: number[], per: number) {
  const out: { o: number; h: number; l: number; c: number }[] = [];
  for (let i = 0; i < closes.length; i += per) {
    const g = closes.slice(i, i + per);
    if (!g.length) continue;
    out.push({ o: g[0], h: Math.max(...g), l: Math.min(...g), c: g[g.length - 1] });
  }
  return out;
}

const J = (o: any) => new Response(JSON.stringify(o), {
  headers: { "content-type": "application/json", "cache-control": "no-store" }
});

/**
 * 네이버 지수 — 코스피·닛케이·상해·항셍 등 **지수 원본**.
 * Finviz 와 달리 **봉별 진짜 OHLC** 를 주므로 캔들을 지어내지 않는다.
 * 국내 지수는 분봉이 있고, 해외 지수는 일봉만 온다(실측) → 없으면 일봉으로 내린다.
 */
async function naverChart(code: string, wantDay: boolean) {
  const [q, minute] = await Promise.all([
    getIndexQuote(code),
    wantDay ? Promise.resolve([]) : getIndexSeries(code, "minute")
  ]);
  let bars = minute;
  let daily = wantDay;
  if (!bars.length) { bars = await getIndexSeries(code, "day"); daily = true; }
  if (!q || bars.length < 2) {
    return J({ ok: false, key: code, reason: q ? "no series" : "quote unavailable" });
  }

  // 방송 화면에서 260봉은 몸통이 1px 이 되어 캔들이 안 보인다 → 70개 안팎으로 묶는다.
  //  (거래소 OHLC 를 묶는 것이므로 고가·저가가 그대로 보존된다 — Finviz 종가 묶기와 다르다)
  const raw = bars.slice(-320);
  const per = Math.max(1, Math.ceil(raw.length / 70));
  const trimmed: typeof raw = [];
  for (let i = 0; i < raw.length; i += per) {
    const g = raw.slice(i, i + per);
    if (!g.length) continue;
    trimmed.push({
      o: g[0].o,
      h: Math.max(...g.map((x) => x.h)),
      l: Math.min(...g.map((x) => x.l)),
      c: g[g.length - 1].c,
      t: g[g.length - 1].t
    });
  }
  const closes = trimmed.map((b) => b.c);

  // 시간축 눈금 — 라벨이 바뀌는 지점에만 찍는다 (분봉은 시:분, 일봉은 월)
  const marks: { at: number; label: string }[] = [];
  let prev = "";
  trimmed.forEach((b, i) => {
    const t = b.t;
    // 분봉 t = YYYYMMDDHHmmss / 일봉 t = YYYYMMDD
    const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const lab = t.length >= 12
      ? `${t.slice(8, 10)}:${t.slice(10, 12)}`
      : (MON[Number(t.slice(4, 6)) - 1] ?? t.slice(4, 6));
    const grp = t.length >= 12 ? t.slice(8, 10) : t.slice(4, 6);
    if (grp !== prev && i > 0) { marks.push({ at: i, label: lab }); prev = grp; }
    else if (!prev) prev = grp;
  });
  return J({
    ok: true,
    key: code,
    src: "naver",
    tf: daily ? "d1" : "m1",
    label: NAVER_INDEXES[code] ?? code,
    price: q.price,
    changePct: q.changePct,
    changeAbs: q.change,
    // 전일 종가 = 현재값 - 변동폭 (보합선)
    base: Number.isFinite(q.price - q.change) ? q.price - q.change : null,
    points: closes,
    candles: trimmed.map((b) => ({ o: b.o, h: b.h, l: b.l, c: b.c })),
    // ★ 지어낸 봉이 아니라 거래소 OHLC 다 → 화면에서 "from 5m closes" 를 붙이지 않는다
    realOhlc: true,
    candleMin: null,
    marks,
    // 정직성: 지연 시간과 마지막 체결 시각을 그대로 넘긴다
    delayMin: q.delayMin,
    tradedAt: q.tradedAt,
    status: q.status,
    asOf: q.asOf
  });
}

export const GET: RequestHandler = async ({ url }) => {
  const src = url.searchParams.get("src") || "finviz";
  if (src === "naver") {
    const code = url.searchParams.get("key") || "KOSPI";
    if (!(code in NAVER_INDEXES)) return J({ ok: false, key: code, reason: "unknown index" });
    // 네이버 분봉은 **당일 장중**만 있다. 12D/14M 처럼 긴 구간을 고르면 일봉으로 가야 한다.
    //  (안 그러면 "12D" 라고 해놓고 당일 분봉을 보여주게 된다)
    const tfParam = url.searchParams.get("tf");
    return naverChart(code, tfParam === "d1" || tfParam === "h1");
  }

  const key = (url.searchParams.get("key") || "NQ").toUpperCase();
  const tf = TF[url.searchParams.get("tf") || "m5"] ?? "m5";
  const style = url.searchParams.get("style") === "candle" ? "candle" : "line";

  const map = await getFutures(tf);
  const q = map.get(key);

  if (!q || q.spark.length < 2) {
    return new Response(
      JSON.stringify({ ok: false, key, tf, reason: q ? "no series" : "unknown symbol" }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } }
    );
  }

  // 캔들은 60개 안팎이 방송 화면에서 가장 읽기 좋다 (220개면 몸통이 1px 이 된다)
  const PER = Math.max(1, Math.ceil(q.spark.length / 60));
  const candles = style === "candle" ? toCandles(q.spark, PER) : [];

  const { pts, idx } = sample(q.spark, 220);

  // 시간축 눈금은 원본 인덱스 기준이라 샘플링 후 위치로 옮겨야 한다.
  // (안 옮기면 "10AM" 라벨이 엉뚱한 x 좌표에 찍힌다)
  const marks: { at: number; label: string }[] = [];
  for (const [rawIdx, label] of Object.entries(q.marks)) {
    const target = Number(rawIdx);
    if (style === "candle") {
      // 캔들 모드에선 x축 단위가 봉이다
      marks.push({ at: Math.round(target / PER), label });
      continue;
    }
    let best = 0;
    for (let i = 1; i < idx.length; i++) {
      if (Math.abs(idx[i] - target) < Math.abs(idx[best] - target)) best = i;
    }
    marks.push({ at: best, label });
  }
  marks.sort((a, b) => a.at - b.at);

  return new Response(
    JSON.stringify({
      ok: true,
      key,
      tf,
      label: q.label,
      price: q.price,
      changePct: q.changePct,
      changeAbs: q.changeAbs,   // 포인트 등락 — "몇 포인트 빠졌나"가 %보다 직관적이다
      base: q.prevClose,   // 보합선 = 전일 정산가
      points: pts,
      candles,
      style,
      // 봉이 몇 분짜리인지 + 꼬리가 종가 기반이라는 사실을 화면이 표기할 수 있게 넘긴다
      candleMin: style === "candle" && tf === "m5" ? PER * 5 : null,
      marks,
      asOf: q.asOf
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );
};
