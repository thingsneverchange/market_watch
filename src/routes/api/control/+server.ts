import type { RequestHandler } from "./$types";
import { getState, setChart, pushBreaking, clearBreaking, setVideo, clearVideo, setMusic, setVideoAuto, autoAllowed, CHART_PRESETS } from "$lib/server/control";
import { getVerifiedVideos, pickAutoVideo } from "$lib/server/livevideos";

/** 자동 송출이 켜져 있고 조건이 맞으면 영상을 대신 채워 넣는다 (수동이 항상 우선). */
async function withAuto(st: ReturnType<typeof getState>) {
  if (!autoAllowed()) return { video: st.video, videoAutoActive: false };
  try {
    const pick = pickAutoVideo(await getVerifiedVideos());
    if (pick) {
      return {
        video: { id: pick.videoId, label: pick.title, at: Date.now() },
        videoAutoActive: true
      };
    }
  } catch { /* 실패하면 그냥 차트를 유지한다 */ }
  return { video: st.video, videoAutoActive: false };
}

// 오버레이가 1.5초마다 폴링 — 현재 상태 + 프리셋 목록
export const GET: RequestHandler = async () => {
  const st = getState();
  const preset = CHART_PRESETS.find((p) => p.key === st.chartKey) ?? CHART_PRESETS[0];
  const auto = await withAuto(st);
  return new Response(JSON.stringify({
    ...st,
    ...auto,
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
    case "videoAuto":
      setVideoAuto(body.on === true);
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
