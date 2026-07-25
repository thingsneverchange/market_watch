import type { RequestHandler } from "./$types";
import { getFutures, type Timeframe } from "$lib/server/finviz";

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

export const GET: RequestHandler = async ({ url }) => {
  const key = (url.searchParams.get("key") || "NQ").toUpperCase();
  const tf = TF[url.searchParams.get("tf") || "m5"] ?? "m5";

  const map = await getFutures(tf);
  const q = map.get(key);

  if (!q || q.spark.length < 2) {
    return new Response(
      JSON.stringify({ ok: false, key, tf, reason: q ? "no series" : "unknown symbol" }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } }
    );
  }

  const { pts, idx } = sample(q.spark, 220);

  // 시간축 눈금은 원본 인덱스 기준이라 샘플링 후 위치로 옮겨야 한다.
  // (안 옮기면 "10AM" 라벨이 엉뚱한 x 좌표에 찍힌다)
  const marks: { at: number; label: string }[] = [];
  for (const [rawIdx, label] of Object.entries(q.marks)) {
    const target = Number(rawIdx);
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
      base: q.prevClose,   // 보합선 = 전일 정산가
      points: pts,
      marks,
      asOf: q.asOf
    }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );
};
