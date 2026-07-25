import type { RequestHandler } from "./$types";
import { getState, setCharts, pushBreaking, clearBreaking, setVideo, clearVideo, setMusic, setVideoAuto, autoAllowed, CHART_PRESETS, MAX_SLOTS, type ControlState } from "$lib/server/control";
import { isRegularHours } from "$lib/market-hours";
import { getSniperTarget } from "$lib/server/movers";
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

/**
 * 각 슬롯을 **실제로 그릴 소스**로 확정해서 내려준다.
 * 오버레이가 이 판단을 하면 클라이언트마다 시각이 달라 화면이 엇갈릴 수 있으므로
 * 서버가 한 번만 정한다.
 *
 * AUTO: 정규장이면 TradingView(캔들·지표), 그 외엔 선물 자체 렌더(24시간).
 *       프리셋에 한쪽만 있으면 있는 쪽을 쓴다.
 */
function resolveSlots(st: ControlState) {
  const regular = isRegularHours();
  return st.chartKeys.slice(0, MAX_SLOTS).map((key) => {
    // "fv:LB" = 프리셋에 없는 Finviz 심볼 (추천 목록에서 바로 띄운 것)
    if (key.startsWith("fv:")) {
      const sym = key.slice(3);
      return { key, label: sym, note: "", mode: "fut" as const,
        tvSymbol: "", futKey: sym, nvCode: "", sniper: false, why: "" };
    }
    const p = CHART_PRESETS.find((x) => x.key === key) ?? CHART_PRESETS[0];
    const wantTv = st.chartAuto ? regular : false;
    // 우선순위: (정규장 & TradingView 있음) → tv / 선물 있음 → fut / 그 외 → 네이버 지수
    //  네이버 지수는 지수 **원본**이라 선물이 없는 코스피·상해·항셍의 유일한 길이다.
    const useTv = wantTv && !!p.tv;
    const mode: "tv" | "fut" | "nv" =
      useTv ? "tv" : p.fut ? "fut" : p.nv ? "nv" : p.tv ? "tv" : "fut";
    return {
      key: p.key,
      label: p.label,
      note: p.note ?? "",
      mode,
      tvSymbol: p.tv ?? "",
      futKey: p.fut ?? "",
      nvCode: p.nv ?? "",
      sniper: false,
      why: ""
    };
  });
}

/**
 * Auto-Sniper: 이례적으로 급등·급락 중인 종목을 **마지막 슬롯**에 물린다.
 * 사용자가 고른 첫 슬롯은 절대 건드리지 않는다 — 보고 있던 차트가 사라지면 안 된다.
 * 사건이 없으면(휴장 포함) 아무것도 하지 않는다.
 */
async function withSniper(st: ControlState, slots: ReturnType<typeof resolveSlots>) {
  if (!st.chartSniper) return slots;
  let target = null;
  try { target = await getSniperTarget(); } catch { /* 실패하면 그냥 원래 배치 */ }
  if (!target) return slots;

  const shot = {
    key: `fv:${target.key}`,
    label: target.label,
    note: "",
    mode: "fut" as const,
    tvSymbol: "",
    futKey: target.key,
    nvCode: "",
    sniper: true,
    // 왜 잡혔는지 화면에 밝힌다 — 근거 없이 차트가 바뀌면 시청자가 못 따라온다
    why: `${target.recentPct > 0 ? "+" : ""}${target.recentPct}% in 30m · ${target.z}x normal`
  };
  // 이미 그 종목을 보고 있으면 중복으로 넣지 않는다
  if (slots.some((s) => s.futKey === target!.key)) return slots;
  // 자리가 있으면 덧붙이고, 꽉 찼으면 **마지막 슬롯만** 교체한다
  return slots.length < MAX_SLOTS ? [...slots, shot] : [...slots.slice(0, -1), shot];
}

// 오버레이가 1.5초마다 폴링 — 현재 상태 + 프리셋 목록
export const GET: RequestHandler = async () => {
  const st = getState();
  const auto = await withAuto(st);
  return new Response(JSON.stringify({
    ...st,
    ...auto,
    slots: await withSniper(st, resolveSlots(st)),
    presets: CHART_PRESETS,
    maxSlots: MAX_SLOTS
  }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
};

// 컨트롤러(/control)가 명령 전송
export const POST: RequestHandler = async ({ request }) => {
  let body: any = {};
  try { body = await request.json(); } catch {}

  switch (body.action) {
    case "chart":
      setCharts(
        Array.isArray(body.keys) ? body.keys : [body.key],
        body.interval ? String(body.interval) : undefined,
        typeof body.auto === "boolean" ? body.auto : undefined,
        typeof body.sniper === "boolean" ? body.sniper : undefined,
        body.style ? String(body.style) : undefined
      );
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
  return new Response(JSON.stringify({ ok: true, ...st, slots: await withSniper(st, resolveSlots(st)) }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
