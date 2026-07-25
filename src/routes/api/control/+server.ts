import type { RequestHandler } from "./$types";
import { getState, setChart, pushBreaking, clearBreaking, setVideo, clearVideo, setMusic, CHART_PRESETS } from "$lib/server/control";

// 오버레이가 1.5초마다 폴링 — 현재 상태 + 프리셋 목록
export const GET: RequestHandler = async () => {
  const st = getState();
  const preset = CHART_PRESETS.find((p) => p.key === st.chartKey) ?? CHART_PRESETS[0];
  return new Response(JSON.stringify({
    ...st,
    tvSymbol: preset.tvSymbol,
    chartLabel: preset.label,
    presets: CHART_PRESETS
  }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
};

// 컨트롤러(/control)가 명령 전송
export const POST: RequestHandler = async ({ request }) => {
  let body: any = {};
  try { body = await request.json(); } catch {}

  switch (body.action) {
    case "chart":
      setChart(String(body.key ?? ""), body.interval ? String(body.interval) : undefined);
      break;
    case "breaking":
      pushBreaking(String(body.headline ?? ""), Number(body.level ?? 5));
      break;
    case "clearBreaking":
      clearBreaking();
      break;
    // 영상 송출은 사람이 판단해서 누른다 (시스템은 추천만)
    case "video":
      setVideo(String(body.url ?? ""), String(body.label ?? ""));
      break;
    case "clearVideo":
      clearVideo();
      break;
    case "music":
      setMusic({
        playing: typeof body.playing === "boolean" ? body.playing : undefined,
        volume: body.volume != null ? Number(body.volume) : undefined,
        cmd: body.cmd === "next" || body.cmd === "prev" ? body.cmd : undefined
      });
      break;
  }

  const st = getState();
  const preset = CHART_PRESETS.find((p) => p.key === st.chartKey) ?? CHART_PRESETS[0];
  return new Response(JSON.stringify({ ok: true, ...st, tvSymbol: preset.tvSymbol, chartLabel: preset.label }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
