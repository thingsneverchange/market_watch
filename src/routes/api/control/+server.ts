import type { RequestHandler } from "./$types";
import { getState, setCharts, pushBreaking, clearBreaking, setVideo, clearVideo, setMusic, setVideoAuto, setVideoPlaying, autoAllowed, CHART_PRESETS, MAX_SLOTS, type ControlState } from "$lib/server/control";
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
 * 이 상품이 **어느 시계로 도는가**.
 *
 * 실측 사고: 라이브 램프의 세션 문구를 선물 모드 전부에 미국 **현물** 세션으로 붙였다.
 *   BITCOIN ● PRE-MKT   ← 비트코인엔 프리마켓이 없다 (게다가 24시간 자산이다)
 *   GOLD ● PRE-MKT / DAX ● PRE-MKT  도 같은 이유로 말이 안 됐다.
 * "지금이 미국 프리장인가"는 **미국 지수 선물에만** 의미가 있다.
 *
 *  us-equity — NQ·ES·YM·ER2·VX. 미국 현물 세션 구간을 말해 주는 게 정보다.
 *  globex    — 원자재·FX·금리·해외지수 선물. Globex 로 돌지만 미국 현물 세션과 무관하다.
 *  24-7      — 암호화폐 현물(BINANCE 등). 쉬지 않는다.
 *  us-cash   — 미국 상장 ETF. 정규장에만 움직인다.
 *  local     — 해외 거래소 지수. 우리가 그 시계를 모르므로 아무 주장도 하지 않는다.
 *
 * ※ 비트코인은 모드에 따라 다르다. Finviz "BTC" 는 **CME 선물**이라 주말에 멈추고
 *   (프리셋 note 가 이미 그렇게 밝히고 있다), TradingView 쪽은 BINANCE 현물이라 24시간이다.
 *   그리는 소스 기준으로 판정한다.
 */
const US_INDEX_FUT = new Set(["NQ", "ES", "YM", "ER2", "VX"]);
function clockOf(mode: "tv" | "fut" | "nv", futKey: string, tvSymbol: string): string {
  if (mode === "nv") return "local";
  if (mode === "tv") return /^(?:BINANCE|COINBASE|BITSTAMP):/i.test(tvSymbol) ? "24-7" : "us-cash";
  return US_INDEX_FUT.has(futKey) ? "us-equity" : "globex";
}

/**
 * 지금 화면에 그려지는 게 **무슨 상품인가**.
 *
 * 같은 "NASDAQ" 이라도 시간대에 따라 완전히 다른 것을 보고 있다:
 *   장 밖  → NQ **선물** (28,704)
 *   정규장 → QQQ **ETF** (나스닥100 추종)
 *   네이버 → 나스닥 종합 **지수 원본**
 * 값의 자릿수부터 다른데 라벨이 전부 "NASDAQ" 이면 시청자는 같은 걸로 읽는다.
 * 헤더 스트립은 이미 "NASDAQ FUT" 으로 구분하고 있었는데 정작 메인 차트가 안 했다.
 */
function instrumentOf(mode: "tv" | "fut" | "nv", tvSymbol: string): string {
  if (mode === "fut") return "FUT";
  if (mode === "nv") return "INDEX";
  // TradingView 경로 — 지수 원본은 무료 임베드가 못 그려서 전부 ETF 대체물이다.
  // 암호화폐만 예외로 현물 거래소 심볼이다.
  return /^(?:BINANCE|COINBASE|BITSTAMP):/i.test(tvSymbol) ? "SPOT" : "ETF";
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
      return { key, label: sym, note: "", mode: "fut" as const, instrument: "FUT", clock: "globex",
        tvSymbol: "", futKey: sym, nvCode: "", sniper: false, why: "" };
    }
    const p = CHART_PRESETS.find((x) => x.key === key) ?? CHART_PRESETS[0];
    const wantTv = st.chartAuto ? regular : false;
    // 우선순위: (정규장 & TradingView 있음) → tv / 선물 있음 → fut / 그 외 → 네이버 지수
    //  네이버 지수는 지수 **원본**이라 선물이 없는 코스피·상해·항셍의 유일한 길이다.
    // 암호화폐는 정규장 여부와 무관하게 현물 소스를 쓴다 (alwaysTv 주석 참고)
    const useTv = !!p.tv && (wantTv || !!p.alwaysTv);
    const mode: "tv" | "fut" | "nv" =
      useTv ? "tv" : p.fut ? "fut" : p.nv ? "nv" : p.tv ? "tv" : "fut";
    return {
      key: p.key,
      label: p.label,
      note: p.note ?? "",
      mode,
      instrument: instrumentOf(mode, p.tv ?? ""),
      clock: clockOf(mode, p.fut ?? "", p.tv ?? ""),
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
    instrument: "FUT",
    clock: US_INDEX_FUT.has(target.key) ? "us-equity" : "globex",
    tvSymbol: "",
    futKey: target.key,
    nvCode: "",
    sniper: true,
    // 왜 잡혔는지 화면에 밝힌다 — 근거 없이 차트가 바뀌면 시청자가 못 따라온다
    // ★ "in 30m" 을 하드코딩하지 않는다. Finviz 봉 간격이 종목마다 달라서
    //   실제 구간은 30~35분으로 갈린다(속보 문구에서 이미 고친 것과 같은 문제).
    //   모르면 구간을 말하지 않는다.
    why: `${target.recentPct > 0 ? "+" : ""}${target.recentPct}%${target.windowMin ? ` in ${target.windowMin}m` : ""} · ${target.z}x normal`
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
    case "videoPlay":
      setVideoPlaying(body.on === true);
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
