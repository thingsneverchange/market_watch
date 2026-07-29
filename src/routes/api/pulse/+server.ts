import type { RequestHandler } from "./$types";
import { getSectorBoard } from "$lib/server/sectors";
import { getVolumes } from "$lib/server/volume";
import { getMarketFocus } from "$lib/server/focus";

// ============================================================
//  PULSE — 섹터 로테이션 + 거래량
//
//  둘을 한 라우트에 묶은 이유: 화면에서 같은 질문에 답하기 때문이다 —
//  "지수 숫자 말고, 오늘 실제로 무슨 일이 벌어지고 있나."
//   · 섹터: 돈이 어디서 어디로 갔나 (실측 XLK −1.84% vs XLF +1.27%)
//   · 거래량: 그게 실제 자금 이동인가, 얇은 장의 노이즈인가
//
//  거래량 대상은 **지금 화면이 주목하는 종목**을 따라간다. 고정 목록을 두면
//  FMP 무료 예산(종목당 1요청)을 관심 없는 종목에 쓰게 된다.
// ============================================================
export const GET: RequestHandler = async () => {
  const [sectors, board] = await Promise.all([getSectorBoard(), getMarketFocus("", 5)]);
  // MARKET FOCUS 상위 종목 = 지금 화면이 이야기하고 있는 이름들
  const tickers = board.names.map((n) => n.ticker).filter((t) => /^[A-Z.]{1,6}$/.test(t)).slice(0, 6);
  const volumes = tickers.length ? await getVolumes(tickers) : [];

  return new Response(JSON.stringify({ sectors, volumes }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
