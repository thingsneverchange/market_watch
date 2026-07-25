import type { RequestHandler } from "./$types";
import { getMovers } from "$lib/server/movers";

// "지금 시장이 보고 있는 것" — /control 의 추천 목록용.
// 평소 변동성 대비 이례성(z) 순. 알고리즘 설명은 $lib/server/movers.ts 참고.
export const GET: RequestHandler = async ({ url }) => {
  const n = Math.max(1, Math.min(20, Number(url.searchParams.get("n")) || 8));
  const movers = await getMovers();
  return new Response(JSON.stringify({ movers: movers.slice(0, n) }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
