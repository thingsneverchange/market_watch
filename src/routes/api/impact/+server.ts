import type { RequestHandler } from "./$types";
import { getIndexMovers } from "$lib/server/impact";

// 지수를 실제로 움직인 종목 (시총 × 등락률). 판정 기준은 impact.ts 주석 참고.
// ★ 별도 엔드포인트로 둔 이유: 종목이 40개라 캐시가 만료되는 순간 요청이 몰린다.
//   헤더 시세(/api/boards)와 같은 경로에 두면 그 지연이 헤더까지 끌고 간다.
//   화면은 이쪽만 느린 주기로 폴링한다.
export const GET: RequestHandler = async () => {
  const board = await getIndexMovers(5);
  return new Response(JSON.stringify(board), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
