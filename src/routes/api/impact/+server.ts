import type { RequestHandler } from "./$types";
import { getMarketFocus } from "$lib/server/focus";

// "지금 시장이 보고 있는 종목". 판정 기준은 focus.ts 상단 주석 참고.
// ★ 오늘 지수를 얼마나 움직였나(사후 측정)가 아니다 —
//   실적을 앞둔 GOOGL 은 아직 안 움직였는데도 그 주 시장의 중심이다.
//
// themeKey = 현재 MARKET DRIVER 주제. 화면이 넘겨 준다(테마 대표주에 가점).
export const GET: RequestHandler = async ({ url }) => {
  const themeKey = String(url.searchParams.get("theme") ?? "").toUpperCase().slice(0, 12);
  const board = await getMarketFocus(themeKey, 5);
  return new Response(JSON.stringify(board), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
