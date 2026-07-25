import type { RequestHandler } from "./$types";
import { getMacroReadings, getMacroReleases } from "$lib/server/fred";

// 거시 지표 실제치 + 다음 발표일 (출처: FRED = 세인트루이스 연준).
// LLM 이 개입하지 않는 경로다 — 여기 숫자는 정부·연준이 발표한 값 그대로다.
export const GET: RequestHandler = async () => {
  const [readings, releases] = await Promise.all([getMacroReadings(), getMacroReleases()]);
  return new Response(
    JSON.stringify({ readings, releases, source: "FRED" }),
    { headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );
};
