// ============================================================
//  방송 컨트롤 상태 (인메모리)
//  컨트롤러(/control, 다른 기기)가 바꾸고, 오버레이(/)가 폴링해서 반영
// ============================================================

export type ChartPreset = {
  key: string;
  label: string;
  /** Finviz 선물 키 → 자체 SVG 렌더. 24시간 돌아가고 iframe 이 없다. */
  fut?: string;
  /** TradingView 심볼 → 정규장에서 캔들·지표를 보고 싶을 때. */
  tv?: string;
  /** 정직성 표기 — 지수 원본이 아니라 대체물일 때 화면과 컨트롤에 같이 띄운다. */
  note?: string;
};

// 차트 프리셋 — 여기만 고치면 컨트롤러 버튼도 자동으로 바뀐다.
//
// ※ TradingView 무료 임베드의 실측 제약 (이전 세션 전수 검사):
//   지수 **원본**(IXIC/SPX/DJI/NDX/NYA, TVC: 미러 포함)과 CME 선물(NQ1!/ES1!)은
//   차트 대신 "This symbol is only available on TradingView" 모달이 뜬다.
//   렌더되는 것: ETF, 암호화폐, FX/금속.
//   → 그래서 아시아 지수도 **ETF 대체물**로 넣는다. KOSPI 원본은 무료로는 길이 없다.
//
// ※ 두 소스의 역할 분담:
//   fut = Finviz 선물. 야간·주말에도 살아 있고 자체 렌더라 절대 빈 화면이 안 된다.
//   tv  = TradingView. 정규장에 캔들·지표가 필요할 때. (AUTO 모드가 자동 전환)
export const CHART_PRESETS: ChartPreset[] = [
  // ── 미국 ──
  { key: "nq",   label: "NASDAQ",       fut: "NQ",  tv: "NASDAQ:QQQ" },
  { key: "es",   label: "S&P 500",      fut: "ES",  tv: "AMEX:SPY" },
  { key: "ym",   label: "DOW",          fut: "YM",  tv: "AMEX:DIA" },
  { key: "rty",  label: "RUSSELL",      fut: "ER2", tv: "AMEX:IWM" },
  { key: "soxx", label: "SEMIS",                    tv: "NASDAQ:SOXX" },
  { key: "vx",   label: "VIX",          fut: "VX" },
  // ── 아시아 ──
  //  닛케이만 진짜 지수 선물(NKD)이 있어서 24시간 나온다.
  //  코스피·중국은 무료로 지수 원본을 주는 곳이 없어 **미국상장 ETF 대체물**을 쓴다.
  //  → 미국 정규장에만 움직이고 환율이 섞인다. 화면에 그대로 밝힌다.
  { key: "nkd",  label: "NIKKEI 225",   fut: "NKD", tv: "AMEX:EWJ" },
  { key: "kospi",label: "KOSPI",                    tv: "AMEX:EWY",
    note: "EWY ETF proxy · US hours" },
  { key: "chn",  label: "CHINA",                    tv: "AMEX:FXI",
    note: "FXI ETF proxy · US hours" },
  { key: "chna", label: "CHINA A-SHARE",            tv: "AMEX:ASHR",
    note: "ASHR ETF proxy · US hours" },
  { key: "koru", label: "KORU 3X",                  tv: "AMEX:KORU",
    note: "3x leveraged Korea ETF" },
  // ── 유럽 ──
  { key: "dax",  label: "DAX",          fut: "DY" },
  { key: "estx", label: "EURO STOXX",   fut: "EX" },
  // ── 원자재 · 크립토 · 금리 ──
  { key: "cl",   label: "CRUDE OIL",    fut: "CL" },
  { key: "gc",   label: "GOLD",         fut: "GC" },
  { key: "si",   label: "SILVER",       fut: "SI" },
  { key: "ng",   label: "NAT GAS",      fut: "NG" },
  { key: "btc",  label: "BITCOIN",      fut: "BTC", tv: "BINANCE:BTCUSDT" },
  { key: "dx",   label: "DOLLAR",       fut: "DX" },
  { key: "zn",   label: "10Y NOTE",     fut: "ZN" }
];

/** 화면에 동시에 띄울 수 있는 차트 수 */
export const MAX_SLOTS = 4;

/** 컨트롤러가 보낼 수 있는 봉 간격 화이트리스트 */
export const INTERVALS = ["1", "5", "15", "60", "D"];

/** 라이브 영상 (연준 회견 등). 시스템은 '추천'만 하고, 실제 송출은 사람이 /control 에서 결정한다. */
export type VideoState = { id: string; label: string; at: number } | null;

export type ControlState = {
  version: number;              // 바뀔 때마다 +1 (오버레이가 변화 감지)
  // 최대 4개까지 동시에 띄운다. 길이가 곧 레이아웃(1=전체, 2=좌우, 3=1+2, 4=2x2).
  chartKeys: string[];
  chartInterval: string;        // 봉 간격 ("1" = 1분)
  // AUTO = 정규장이면 TradingView(캔들·지표), 그 외엔 선물 자체 렌더.
  // 끄면 항상 선물 자체 렌더 — TradingView 가 안 뜨는 환경에서도 화면이 안 빈다.
  chartAuto: boolean;
  breaking: { id: number; headline: string; level: number; at: number } | null; // 수동 속보
  video: VideoState;            // 송출 중인 영상 (null = 차트 표시)
  // 배경음악 — 오디오는 방송 화면(오버레이)에서 나야 OBS 가 잡는다.
  // 그래서 플레이어는 오버레이에 **숨겨서** 두고, 조작만 여기서 한다.
  music: { playing: boolean; volume: number; cmdSeq: number; cmd: "none" | "next" | "prev" };
  // 자동 송출: 켜면 "지금 라이브인 공적 소스"(연준·정부)를 스스로 띄운다.
  // 사람이 내리면 일정 시간 자동 재송출을 억제한다 — 안 그러면 내려도 바로 다시 올라온다.
  videoAuto: boolean;
  autoSuppressUntil: number;
  updatedAt: number;
};

/**
 * 유튜브 URL/ID 에서 **영상 ID만** 뽑는다.
 * 임의 문자열을 그대로 iframe src 에 넣으면 안 된다 — 형식을 강제해 주입을 차단한다.
 * 지원: youtu.be/ID, /watch?v=ID, /live/ID, /embed/ID, 그리고 ID 자체(11자)
 */
export function parseYouTubeId(input: string): string | null {
  const s = String(input || "").trim();
  if (!s) return null;
  const ID = /^[A-Za-z0-9_-]{11}$/;
  if (ID.test(s)) return s;
  const m =
    s.match(/(?:youtu\.be\/)([A-Za-z0-9_-]{11})/) ||
    s.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    s.match(/\/(?:live|embed|shorts)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// 모듈 레벨 = dev/프로덕션에서 단일 프로세스 동안 유지됨
const state: ControlState = {
  version: 1,
  chartKeys: ["nq"],   // 24시간 방송의 기본 = 나스닥 선물 1개
  chartInterval: "1",
  chartAuto: true,
  breaking: null,
  video: null,
  music: { playing: false, volume: 30, cmdSeq: 0, cmd: "none" },
  videoAuto: false,
  autoSuppressUntil: 0,
  updatedAt: Date.now()
};

// 0 이 아니라 현재 시각으로 시드한다. 모듈이 재적재돼도 id 가 재사용되지 않아
// 오버레이의 "이미 본 id" 판정이 어긋나지 않는다.
let breakingSeq = Date.now();

export function getState(): ControlState {
  return state;
}

/**
 * 차트 슬롯 설정. 최대 4개, 화이트리스트에 있는 key 만 통과시킨다.
 * 빈 배열이 오면 무시한다 — 차트 없는 방송 화면은 사고다.
 */
export function setCharts(keys: string[], interval?: string, auto?: boolean) {
  const valid = (Array.isArray(keys) ? keys : [])
    .map((k) => String(k))
    .filter((k) => CHART_PRESETS.some((p) => p.key === k))
    .slice(0, MAX_SLOTS);
  if (valid.length) state.chartKeys = valid;
  // 화이트리스트 검증 — 임의 문자열이 들어오면 차트 헤더 라벨이 깨진다
  if (interval && INTERVALS.includes(interval)) state.chartInterval = interval;
  if (typeof auto === "boolean") state.chartAuto = auto;
  state.version++;
  state.updatedAt = Date.now();
  return state;
}

export function pushBreaking(headline: string, level = 5) {
  const h = (headline || "").trim();
  if (!h) return state;
  breakingSeq++;
  // at = 송출 시각. 오버레이가 이걸 보고 "몇 시간 전 속보가 새로고침 때 재방송되는" 것을 막는다.
  state.breaking = { id: breakingSeq, headline: h, level, at: Date.now() };
  state.version++;
  state.updatedAt = Date.now();
  return state;
}

export function clearBreaking() {
  state.breaking = null;
  state.version++;
  state.updatedAt = Date.now();
  return state;
}

/** 영상 송출 시작. 형식이 유효한 유튜브 ID 만 통과한다. */
export function setVideo(input: string, label = "") {
  const id = parseYouTubeId(input);
  if (!id) return state; // 잘못된 입력은 무시 (방송 중 깨진 iframe 방지)
  state.video = { id, label: String(label || "").slice(0, 60), at: Date.now() };
  state.version++;
  state.updatedAt = Date.now();
  return state;
}

/** 배경음악 조작 — 오버레이의 숨은 플레이어가 이 상태를 폴링해 반영한다 */
export function setMusic(patch: { playing?: boolean; volume?: number; cmd?: "next" | "prev" }) {
  if (typeof patch.playing === "boolean") state.music.playing = patch.playing;
  if (typeof patch.volume === "number" && Number.isFinite(patch.volume)) {
    state.music.volume = Math.max(0, Math.min(100, Math.round(patch.volume)));
  }
  if (patch.cmd === "next" || patch.cmd === "prev") {
    state.music.cmd = patch.cmd;
    state.music.cmdSeq++;      // seq 가 바뀌면 오버레이가 1회만 실행한다
    state.music.playing = true;
  }
  state.version++;
  state.updatedAt = Date.now();
  return state;
}

/** 영상 내리기 → 오버레이는 차트로 복귀. 자동 모드면 30분간 자동 재송출을 억제한다. */
export function clearVideo() {
  state.video = null;
  if (state.videoAuto) state.autoSuppressUntil = Date.now() + 30 * 60_000;
  state.version++;
  state.updatedAt = Date.now();
  return state;
}

/** 자동 송출 on/off */
export function setVideoAuto(on: boolean) {
  state.videoAuto = !!on;
  if (on) state.autoSuppressUntil = 0; // 다시 켜면 억제 해제
  state.version++;
  state.updatedAt = Date.now();
  return state;
}

/** 자동 송출이 지금 허용되는가 (수동 영상 없음 + 억제 시간 지남) */
export function autoAllowed(): boolean {
  return state.videoAuto && !state.video && Date.now() >= state.autoSuppressUntil;
}
