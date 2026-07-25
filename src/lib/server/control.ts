// ============================================================
//  방송 컨트롤 상태 (인메모리)
//  컨트롤러(/control, 다른 기기)가 바꾸고, 오버레이(/)가 폴링해서 반영
// ============================================================

export type ChartPreset = {
  key: string;
  label: string;
  tvSymbol: string; // TradingView 심볼
};

// 차트 프리셋 — 여기만 고치면 컨트롤러 버튼도 자동으로 바뀜
// ※ 실브라우저 전수 검사 결과, 기존 프리셋 8개 중 **5개가 렌더되지 않았다**.
//   지수(IXIC/SPX/DJI/NDX/NYA)와 CME 선물(NQ1!/ES1!)은 TradingView 무료 임베드에서
//   차트 대신 "This symbol is only available on TradingView" 모달이 뜬다.
//   TVC: 미러(TVC:IXIC / TVC:SPX / TVC:DJI)도 똑같이 막힌다 — 지수는 우회로가 없다.
//
//   확인된 렌더 가능 목록: ETF(QQQ/SPY/DIA/IWM/SOXX/KORU), 암호화폐, FX/금속.
//   그래서 지수는 전부 **추종 ETF**로 대체했다. 헤더의 등락률(SPY/QQQ/DIA 기준)과
//   차트가 마침내 같은 상품을 가리킨다.
export const CHART_PRESETS: ChartPreset[] = [
  { key: "ndx",  label: "NASDAQ 100", tvSymbol: "NASDAQ:QQQ" },
  { key: "spx",  label: "S&P 500",    tvSymbol: "AMEX:SPY" },
  { key: "dow",  label: "DOW",        tvSymbol: "AMEX:DIA" },
  { key: "soxx", label: "반도체",      tvSymbol: "NASDAQ:SOXX" },
  { key: "iwm",  label: "러셀2000",    tvSymbol: "AMEX:IWM" },
  { key: "koru", label: "KORU",       tvSymbol: "AMEX:KORU" },
  { key: "btc",  label: "BTC",        tvSymbol: "BINANCE:BTCUSDT" },
  { key: "gold", label: "GOLD",       tvSymbol: "OANDA:XAUUSD" }
];

/** 컨트롤러가 보낼 수 있는 봉 간격 화이트리스트 */
export const INTERVALS = ["1", "5", "15", "60", "D"];

/** 라이브 영상 (연준 회견 등). 시스템은 '추천'만 하고, 실제 송출은 사람이 /control 에서 결정한다. */
export type VideoState = { id: string; label: string; at: number } | null;

export type ControlState = {
  version: number;              // 바뀔 때마다 +1 (오버레이가 변화 감지)
  chartKey: string;             // 현재 차트 프리셋 key
  chartInterval: string;        // 봉 간격 ("1" = 1분)
  breaking: { id: number; headline: string; level: number; at: number } | null; // 수동 속보
  video: VideoState;            // 송출 중인 영상 (null = 차트 표시)
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
  chartKey: "ndx",
  chartInterval: "1",
  breaking: null,
  video: null,
  updatedAt: Date.now()
};

// 0 이 아니라 현재 시각으로 시드한다. 모듈이 재적재돼도 id 가 재사용되지 않아
// 오버레이의 "이미 본 id" 판정이 어긋나지 않는다.
let breakingSeq = Date.now();

export function getState(): ControlState {
  return state;
}

export function setChart(key: string, interval?: string) {
  if (CHART_PRESETS.some((p) => p.key === key)) {
    state.chartKey = key;
    // 화이트리스트 검증 — 임의 문자열이 들어오면 차트 헤더 라벨이 깨진다
    if (interval && INTERVALS.includes(interval)) state.chartInterval = interval;
    state.version++;
    state.updatedAt = Date.now();
  }
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

/** 영상 내리기 → 오버레이는 차트로 복귀 */
export function clearVideo() {
  state.video = null;
  state.version++;
  state.updatedAt = Date.now();
  return state;
}
