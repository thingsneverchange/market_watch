<script lang="ts">
  import "$lib/css/global.css";
  import BreakingToast from "$lib/components/BreakingToast.svelte";
  import TVChart from "$lib/components/TVChart.svelte";
  import MusicPlayer from "$lib/components/MusicPlayer.svelte";
  import LiveVideo from "$lib/components/LiveVideo.svelte";
  import Sparkline from "$lib/components/Sparkline.svelte";
  import { marketState, marketBell, marketStatus, futuresSession,
    type MarketBell, type MarketStatus, type FuturesSession } from "$lib/market-hours";
  import FuturesChart from "$lib/components/FuturesChart.svelte";
  import { onMount } from "svelte";

  // ---- 상태 ----
  let etNow = "";
  let marketMsg = "LOADING";
  let isMarketOpen = false;
  let marketSession = "CLOSED";
  let bell: MarketBell = { kind: null, ms: 0 }; // 개장/마감 임박 카운트다운
  // 선물(Globex) 세션 — 메인 차트가 선물일 때 LIVE 판정에 쓴다
  let futSess: FuturesSession = { open: false, label: "…" };
  // 시장 상태 — 열림/닫힘 + **왜 닫혔는지** + 언제 열리는지 (직관적으로 한 번에)
  let mkt: MarketStatus = { open: false, session: "CLOSED", label: "LOADING", reason: "", msToOpen: null };

  // 헤더 상단 스트립은 응답 배열이 아니라 **고정 라벨 목록** 기준으로 그린다.
  // 예전에는 티커가 죽으면 배열에서 조용히 빠져 자리째 사라지고 나머지가 왼쪽으로 밀렸다.
  // ★ 개별 대형주(NVDA/AAPL/MSFT) 대신 크로스에셋으로 다양화 — 지수(주식) + 반도체 + 크립토 + 원자재.
  //   지수 3종은 Finnhub(장 밖엔 전일 종가), SOXX/BTC/GOLD/OIL 은 Yahoo(밤·주말에도 라이브).
  // 지수 3슬롯은 서버가 정한다: 장중 → 현물(S&P 500…), 장 밖 → 선물(S&P FUT…).
  // 크로스에셋 4종은 항상 고정.
  // 라벨은 서버가 정한다 (소스 가용성에 따라 지수/선물, SOXX/VIX 유무가 달라진다)
  let indexLabels: string[] = ["NASDAQ FUT", "S&P FUT", "DOW FUT"];
  let crossLabels: string[] = ["SOXX", "GOLD", "OIL", "BTC", "VIX"];
  let showingFutures = false;
  $: headerLabels = [...indexLabels, ...crossLabels];

  let boards = { top: [] as any[], tape: [] as any[], dataAsOf: null as number | null, missing: [] as string[] };
  // 최근 구간 테이프 읽기 (/api/boards tape30). 전부 서버에서 계산해 평평한 객체로 온다 —
  // 템플릿에서 {@const} 나 함수 호출이 필요 없어 Svelte 4 의 추적 한계에 걸릴 여지가 없다.
  /** 섹터 로테이션 + 거래량 (/api/pulse). 전부 서버에서 계산해 평평하게 온다 */
  let sectors: { rows: any[]; benchPct: number | null; live: boolean; spread: number | null } | null = null;
  let volumes: any[] = [];

  let tape30: {
    tier: "moving" | "quiet" | "closed" | "warming" | "nodata";
    reason: string; windowMin: number | null;
    rows: { name: string; pct: number }[];
    subject: string | null; subjectPct: number | null;
    shape: string | null; giveback: string | null;
  } | null = null;
  let digest = {
    driver: { text: "—", sentiment: "neu", source: "", sources: [] as any[], url: "", why: "", confidence: "", epoch: 0, origin: "none", noData: true },
    news: [] as any[]
  };
  // 직전 TOP STORY 3건. 스토리가 갈리면 이전 것은 흔적 없이 사라져서,
  // 중간에 들어온 시청자에겐 "지금까지 무슨 일이 있었나"가 통째로 없었다.
  let prevStories: any[] = [];
  // 지금 시장을 지배하는 주제 (WAR / FED / TARIFFS …). 헤드라인 토픽을 중요도×신선도로 집계.
  let theme: { key: string; label: string; note: string; count: number; total: number; share: number; level: number } | null = null;
  // 지금 시장이 보고 있는 종목. 판정 기준은 lib/server/focus.ts 상단 주석 참고.
  //  가격이 아니라 **관심의 소재**를 잰다 — 실적을 앞둔 종목은 아직 안 움직였어도 중심이다.
  let impact: { names: any[]; benchPct: number | null; live: boolean } =
    { names: [], benchPct: null, live: false };
  // TODAY 브리핑 — 오늘의 핵심 이벤트·뉴스와 영향 (Claude 피드, 없으면 패널 자체가 안 뜬다)
  let brief: any[] = [];
  // UPCOMING = 성격별로 분리. 거시/정책(MACRO)과 개별 실적(EARNINGS)은 보는 이유가 다르다.
  type UpEvent = { title: string; time: Date; estimated: boolean; imp: number; origin: string };
  type UpEarn = UpEvent & { ticker: string; session: string; dday: number; watch: boolean };
  let macroEvents: UpEvent[] = [];
  let earningsEvents: UpEarn[] = [];

  // 패널별 신선도 — 헤더의 시세 배지는 /api/boards 만 본다. 감사 지적: /api/digest·/api/calendar 가
  // 네트워크 레벨로 실패하면 뉴스/실적 패널이 옛 값을 그대로 물고 얼어붙는데(=현재로 위장) 배지는 초록이었다.
  // → 각 패널의 마지막 성공 여부를 추적해 STALE 을 표시한다. (성공하면 자동 해제)
  let digestStale = false;
  let calendarStale = false;
  let nowMs = Date.now(); // 1초 틱 — 뉴스 나이(ago)·이벤트 카운트다운을 매초 갱신
  let upcoming: any[] = []; // 다가오는 실적 상세 리스트
  // MARKET DRIVERS — 시장을 실제로 움직인 종목 + 거시 이벤트.
  //  실적 목록(EARNINGS)은 Finnhub 캘린더 시간창 안의 종목만 담아서, 며칠 전에 발표한
  //  TSLA(-14.5%)·GOOGL(-4.2%) 같은 종목은 반응 데이터가 있어도 화면 어디에도 안 나왔다.
  let reactions: any[] = [];
  /** 규칙 기반 실적 결과 (Finnhub 실제 EPS). LLM 리캡보다 우선한다 */
  let reportedNow: any[] = [];
  // 이미 지난 거시 이벤트 (최근 5개, 1주일 이내). 무료 경제 캘린더가 없어 직접 쌓는다.
  let pastMacro: any[] = [];
  // 거시 지표 실제치 — **FRED(연준 원본)**. LLM 이 개입하지 않는 경로다.
  let macroReadings: any[] = [];
  let macroReleases: any[] = [];

  // ---- 속보 토스트 (단일 소유자) ----
  // 예전에는 전역 변수 1개 + writer 2개(자동/수동) + 추적되지 않는 setTimeout N개 구조라
  // 두 번째 속보가 무음·조기소멸했고, 새로고침하면 유령 속보가 사이렌과 함께 재방송됐다.
  // ★ 속보는 **끌 때까지 남는다.**
  //   예전엔 12초 뒤 자동으로 사라졌다. 24시간 무인 방송에서 진행자가 화면을 안 볼 때
  //   속보가 12초만 스치고 지나가면 시청자 절반은 못 본다.
  //   새 속보가 오면 이전 것을 밀어내고(둘이 겹치면 읽을 수 없다), 내리는 건 /control 에서 한다.
  const AUTO_DISMISS_MS = 0;   // 0 = 자동 소멸 없음
  type Toast = { seq: number; headline: string; level: number; manual: boolean; silent: boolean; ageSec: number };
  let breakingData: Toast | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let toastSeq = 0;

  let seenBreaking = new Map<string, number>(); // id → 처음 본 시각(ms). 나이 기준으로 정리한다.
  let breakingBooted = false;                   // 첫 로드 땐 밀린 뉴스 폭탄 억제
  let manualBooted = false;
  let lastManualBreakingId = 0;
  // /control 의 "속보 내리기". 자동 속보는 서버가 내용을 모르므로 **시퀀스**로 받는다.
  let lastClearSeq: number | null = null;

  // 하단 미니차트 = **지수 선물 3종(NQ·ES·YM)**, 자체 SVG 렌더.
  //  TradingView 무료 임베드는 선물을 아예 못 그린다(실측) → 24시간 스트림에서 정작 중요한
  //  나스닥 선물 움직임을 못 보여준다. Finviz 추이로 직접 그려 그 제약을 없앴다.
  //  덤: iframe 3개가 사라져 24시간 방송의 메모리·CPU 부담도 크게 줄었다.
  let minis: {
    key: string; label: string; pct: number | null; price: string; abs: string | null;
    spark: number[]; base: number | null;
    /** 지금 이 선물이 거래 중인가 (Globex 는 매일 17–18시 ET 쉬고 주말엔 멈춘다) */
    live?: boolean;
  }[] = [];

  // 데이터 신선도 — "내가 fetch 한 시각"이 아니라 "소스가 준 마지막 체결 시각"
  let dataAsOf: number | null = null;
  let firstLoadDone = false;
  let freshness: { cls: string; text: string } = { cls: "", text: "…" };

  // 현물 세션 → 화면 표기. 장 밖에 선물을 띄울 때 "이 숫자가 어느 구간인지" 알려준다.
  const SESSION_LABEL: Record<string, string> = {
    PRE: "PRE-MARKET", OPEN: "REGULAR", AFTER: "AFTER-HOURS",
    CLOSED: "OVERNIGHT", WEEKEND: "WEEKEND", HOLIDAY: "HOLIDAY", UNKNOWN: "—"
  };
  const IV_LABEL: Record<string, string> = { "1": "1m", "5": "5m", "15": "15m", "60": "1H", "D": "1D" };
  // 화면 표기용 한국어 매핑 (템플릿의 {@const} 는 타입 주석을 못 쓰므로 여기 둔다)
  const CONF_LABEL: Record<string, string> = { high: "HIGH", medium: "MED", low: "LOW" };
  const WHEN_LABEL: Record<string, string> = { PRE: "PRE", AH: "AH", LIVE: "LIVE", REG: "REGULAR" };

  // 차트 배지 세션 문구 — marketState() 는 순수 NYSE 시계라서 크로스에셋엔 거짓말을 한다.
  //   BTC 차트(BINANCE:BTCUSDT)는 주말에도 실시간인데 "WEEKEND" 라고 찍혔다.
  //   · 크립토 → 24/7 (항상 라이브)
  //   · 현물 금속/FX/원자재(OANDA:XAU / TVC:GOLD·USOIL 등) → NYSE 세션을 주장하지 않는다(중립 "SPOT")
  //   · 그 외(지수 추종 ETF: QQQ/SPY/DIA/SOXX/IWM/KORU) → 기존 NYSE 세션 그대로
  function chartSession(sym: string): { label: string; live: boolean } | null {
    const s = (sym || "").toUpperCase();
    if (/BTC|ETH|CRYPTO|BINANCE|COINBASE|BITSTAMP|USDT|DOGE|:SOL|:XRP/.test(s)) return { label: "24/7", live: true };
    if (/OANDA:|TVC:|FX_IDC|FOREXCOM|XAU|XAG|USOIL|UKOIL|WTI|BRENT|CRUDE/.test(s)) return { label: "SPOT", live: false };
    return null; // 지수 ETF → 기존 NYSE 세션 사용
  }
  // ── 차트 슬롯 (최대 4개) ───────────────────
  //  어떤 소스로 그릴지는 **서버가 정해서** 내려준다(mode: "tv" | "fut").
  //  클라이언트마다 시각이 달라 화면이 엇갈리는 것을 막기 위해서다.
  type Slot = { key: string; label: string; note: string; mode: "tv" | "fut" | "nv";
    /** 지금 그리는 게 무슨 상품인가 — "FUT" / "ETF" / "INDEX" / "SPOT" (서버가 정한다) */
    instrument?: string;
    /** 어느 시계로 도는가 — "us-equity" / "globex" / "24-7" / "us-cash" / "local" */
    clock?: string;
    tvSymbol: string; futKey: string; nvCode?: string; sniper?: boolean; why?: string };
  let slots: Slot[] = [{ key: "nq", label: "NASDAQ", note: "", mode: "fut", instrument: "FUT", clock: "us-equity",
    tvSymbol: "NASDAQ:QQQ", futKey: "NQ", nvCode: "" }];
  let chartStyle: "line" | "candle" = "line";
  // TradingView 렌더에 실패한 슬롯 — 자체 렌더로 갈아탄다.
  // 정규장은 하루 중 가장 중요한 시간인데 거기서 화면 한가운데가 비면 안 된다.
  let tvFailed = new Set<string>();
  let chartInterval = "1";
  let ctlVersion = 0;

  //  컨트롤의 봉 설정을 Finviz 타임프레임으로 매핑 (1/5분 → 5분봉, 60 → 1시간봉, D → 일봉)
  $: futTf = (chartInterval === "D" ? "d1" : chartInterval === "60" ? "h1" : "m5") as
    "m5" | "h1" | "d1";
  const FUT_TF_LABEL = { m5: "24H · 5m", h1: "12D · 1h", d1: "14M · 1D" } as const;
  // 차트가 하나라도 TradingView 면 어트리뷰션을 표기한다
  $: anyTv = slots.some((x) => x.mode === "tv");
  // 라이브 영상 (연준 회견 등). null 이면 차트를 그대로 보여준다.
  let video: { id: string; label: string } | null = null;
  let videoPlaying = false;   // 재생은 /control 이 결정한다 (자동재생 없음)
  // 배경음악 — 조작은 /control 에서, 소리는 여기(오버레이)서 난다. UI 는 그리지 않는다.
  let music = { playing: false, volume: 30, cmdSeq: 0, cmd: "none" as "none" | "next" | "prev" };

  let scale = 1;

  function updateTimers() {
    const now = new Date();
    nowMs = now.getTime(); // 뉴스 나이 재계산용 (정지된 헤드라인도 매초 늙는다)
    etNow = new Intl.DateTimeFormat("en-US", {
      // 초까지 넣으면 폭이 매초 흔들리고(숫자 폭 변화) 헤더가 접힌다. 분까지면 충분하다.
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: true
    }).format(now);

    // 휴장일·조기폐장까지 아는 공용 시장시계. 예전에는 이 로직이 서버/클라에 복붙돼 있었고
    // 휴장일 처리가 없어 추수감사절·크리스마스에도 "MARKET OPEN" 이 켜졌다.
    const s = marketState(now);
    isMarketOpen = s.open;
    marketMsg = s.msg;
    marketSession = s.session;
    bell = marketBell(now); // 개장/마감 임박 (실측 시장시계 파생 — 하드코딩·DST·조기폐장 모두 반영)
    mkt = marketStatus(now);
    // 선물 세션은 현물과 완전히 다르다 (일 18:00 → 금 17:00 ET, 매일 17–18시 중단).
    // 현물 세션을 재사용하면 밤새 열려 있는 차트에 "CLOSED" 를 박게 된다.
    futSess = futuresSession(now);

    freshness = computeFreshness(s.open);
    // 이벤트 카운트다운은 템플릿에서 countdown(ev.time, …, nowMs) 로 매초 재계산된다.
  }

  /** ET 시:분 표기 ("10:00 ET") — TODAY 브리핑의 예정 이벤트용 */
  function etClock(ms: number): string {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false
    }).format(new Date(ms)) + " ET";
  }

  /** 중요도 1~5 → 별. 태그(텍스트)보다 한눈에 들어온다. */
  function stars(n: number): string {
    // 별 5개를 다 그리면 자리만 먹고 개수는 오히려 안 세어진다 → "5★" 로 압축.
    const k = Math.max(1, Math.min(5, Math.round(n || 3)));
    return `${k}\u2605`;
  }

  /**
   * ※ 예전 이 자리엔 "WHY IT MATTERS" 한 줄이 있었다.
   *   AI 판단일 땐 Claude 의 why 를, 아닐 땐 관측값을 조합한 문장을 넣었는데
   *   후자는 "Headline reads risk-off · NASDAQ FUT −0.31% right now" 처럼
   *   화면 다른 곳에 이미 다 있는 숫자를 문장으로 다시 읽어 주는 것에 불과했다.
   *   같은 공간에 **직전 TOP STORY 3건**을 넣는 편이 정보가 훨씬 많다 —
   *   24시간 방송에서 중간에 들어온 시청자가 흐름을 잡을 수 있는 유일한 단서다.
   */

  /**
   * 주제별로 **먼저 봐야 할 자산**.
   *  "WAR" 라는 단어만 띄우면 "그래서 시장은?" 이 안 나온다. 전쟁이면 원유·금·VIX 고,
   *  반도체 이슈면 SOXX 다.
   *
   *  ★ 자리가 남아도 **다른 것으로 채우지 않는다.** 예전엔 변동폭이 큰 순으로 백필했는데,
   *    이 줄들은 주제 이름 바로 아래 붙기 때문에 **그 자체가 인과 주장이 된다.**
   *    실측 위험: 주제가 FED 인데 야간이라 VIX·GOLD 슬롯이 없고 비트코인이 코인 자체
   *    이슈로 +4% 면, 화면은 "연준 때문에 비트코인이 올랐다"고 말하는 셈이 된다.
   *    이 시스템 전체가 "측정하지 않은 원인은 말하지 않는다"로 서 있는데 여기만 예외였다.
   *    짧은 줄은 정직하고, 무관한 줄은 오보다.
   */
  const THEME_ASSETS: Record<string, string[]> = {
    GEO: ["OIL", "GOLD", "VIX"],
    OIL: ["OIL", "GOLD", "VIX"],
    GOLD: ["GOLD", "VIX", "OIL"],
    FED: ["VIX", "GOLD", "NASDAQ"],
    CPI: ["GOLD", "VIX", "NASDAQ"],
    JOBS: ["VIX", "NASDAQ", "GOLD"],
    GDP: ["NASDAQ", "VIX", "OIL"],
    BONDS: ["GOLD", "VIX", "NASDAQ"],
    FX: ["GOLD", "OIL", "BTC"],
    CRYPTO: ["BTC", "NASDAQ", "VIX"],
    CHIPS: ["SOXX", "NASDAQ", "VIX"],
    TRADE: ["OIL", "GOLD", "NASDAQ"],
    EARNINGS: ["NASDAQ", "SOXX", "VIX"],
    "M&A": ["NASDAQ", "SOXX", "VIX"]
  };

  /** 지배 주제에 대한 **실제 시장 반응** 3종 */
  $: themeMoves = (() => {
    if (!theme || !boards.top?.length) return [] as any[];
    const rows = boards.top;
    const pick: any[] = [];
    for (const want of THEME_ASSETS[theme.key] ?? []) {
      const hit = rows.find((r: any) => String(r.k).toUpperCase().includes(want) && !pick.includes(r));
      if (hit) pick.push(hit);
    }
    // 주제에 맞는 자산이 화면에 없으면 그 줄은 **비운다** (위 주석 참고).
    return pick.slice(0, 3);
  })();

  /**
   * 발표가 끝난 종목의 결과 줄. **검증된 등락률만** 쓴다.
   *  reactions[].verified 가 false 면 그 숫자는 리캡(LLM) 주장이라 방송 자격이 없다 —
   *  등락률은 비우고(—) 결과 배지(BEAT/MISS)만 남긴다.
   *  화면 폭이 한정돼 있으므로 최대 3줄.
   */
  //  ★ **발표된 숫자(reportedNow)를 LLM 리캡보다 앞에 둔다.**
  //    BEAT/MISS 를 LLM 이 말하게 하면 검증 경로가 없다(감사 지적 #58).
  //    Finnhub 캘린더의 epsActual 로 판정하면 그건 판단이 아니라 사실이다.
  //    리캡은 데이터에 없는 종목을 메우는 보조로만 쓴다.
  $: reportedRows = (() => {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const r of reportedNow ?? []) {
      if (!r?.ticker || seen.has(r.ticker)) continue;
      seen.add(r.ticker);
      out.push({
        ticker: r.ticker, result: r.result ?? null,
        pct: typeof r.pct === "number" ? r.pct : null,
        surprisePct: typeof r.surprisePct === "number" ? r.surprisePct : null
      });
    }
    for (const r of reactions ?? []) {
      if (!r?.ticker || seen.has(r.ticker)) continue;
      seen.add(r.ticker);
      out.push({
        ticker: r.ticker, result: r.result ?? null,
        pct: r.verified && typeof r.pct === "number" ? r.pct : null,
        surprisePct: null
      });
    }
    return out.slice(0, 3);
  })();

  /** 거래량 배수를 티커로 찾기 쉽게 */
  $: volByTicker = new Map((volumes ?? []).map((v: any) => [v.ticker, v]));

  /** TOP STORY 근거 매체 목록 ("CNBC · Reuters"). 마크업에선 타입 주석을 못 쓴다 */
  $: srcNames = (digest.driver.sources ?? [])
    .map((s: any) => s?.name)
    .filter(Boolean)
    .join(" · ");

  /**
   * 차트의 라이브 램프.
   *  "지금 이 종목이 거래되고 있는가"는 소스마다 시계가 다르다:
   *    선물(Globex) — 일 18:00 ET ~ 금 17:00 ET, 매일 17–18시만 쉰다 → 프리·애프터에도 살아 있다
   *    미국 ETF/현물(NYSE) — 정규장에만. 무료 티어는 확장시간 시세를 갱신하지 않는다
   *    해외 지수(네이버) — 현지 거래소 시계라 우리가 판정할 근거가 없다 → 램프를 켜지 않는다
   *  ★ 세션 이름은 **미국 현물 기준**으로 붙인다. 시청자가 알고 싶은 건
   *    "지금이 프리장이냐 정규장이냐"이지 "Globex 가 열렸냐"가 아니다.
   */
  //  ★ 세션 값을 **인자로 받는다.** 함수 안에서 futSess 를 읽으면 Svelte 가 의존성을
  //    못 잡는다 — {@const} 는 표현식에 나타난 변수만 추적하므로, 초기값(닫힘)에서
  //    굳어 램프가 영원히 안 켜졌다(실측: ch-meta 는 live 인데 점은 안 떴다).
  function chartLive(
    clock: string, fs: FuturesSession, session: string, cashOpen: boolean
  ): { live: boolean; session: string } {
    // 암호화폐 현물 — 쉬지 않는다
    if (clock === "24-7") return { live: true, session: "24/7" };
    // 해외 거래소 지수 — 그 시계를 모르므로 아무 주장도 하지 않는다
    if (clock === "local") return { live: false, session: "" };
    // 미국 상장 ETF — 정규장에만 움직인다
    if (clock === "us-cash") return { live: cashOpen, session: cashOpen ? "LIVE" : "" };
    // 미국 지수 선물 — 현물이 닫혀 있어도 돌므로, 지금이 미국 시계의 어느 구간인지 말해 준다
    if (clock === "us-equity") {
      const word = session === "PRE" ? "PRE-MKT"
        : session === "OPEN" ? "LIVE"
        : session === "AFTER" ? "AFTER"
        : "OVERNIGHT";
      return { live: fs.open, session: fs.open ? word : "" };
    }
    // ★ globex — 원자재·FX·금리·해외지수 선물.
    //   여기에 미국 현물 세션 문구를 붙이면 말이 안 된다(실측: BITCOIN ● PRE-MKT,
    //   GOLD ● PRE-MKT). "지금이 미국 프리장인가"는 이 상품들과 아무 상관이 없다.
    return { live: fs.open, session: fs.open ? "GLOBEX" : "" };
  }

  /**
   * 정지된 값 옆에 붙일 **마지막 거래일** 표시 ("FRI" 등).
   *  헤더 폭이 빠듯해서 "PREV CLOSE" 같은 긴 문구는 못 넣는다. 요일 세 글자면
   *  "이건 지금 값이 아니다"가 전달되고, 얼마나 묵었는지도 같이 읽힌다.
   *  기준은 dataAsOf(소스가 준 마지막 체결 시각)다 — 내 시계가 아니다.
   */
  $: lastSessionTag = (() => {
    if (dataAsOf == null) return "PREV";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short"
    }).format(new Date(dataAsOf)).toUpperCase();
  })();

  /**
   * MARKET FOCUS + MOVERS 병합.
   *  둘 다 **개별 종목** 이야기인데 화면 양끝에 떨어져 있었다. 게다가 겹친다 —
   *  실적을 방금 낸 종목은 FOCUS 에 "REPORTED 3D AGO" 로도 뜨고 MOVERS 에도 뜬다.
   *  하나로 합치면 "왜 보고 있나(촉매)" 와 "그래서 어떻게 됐나(검증된 반응)" 가 한 줄에 붙는다.
   *
   *  반응이 있는 종목은 그 값을 쓴다 — 그쪽은 발표일 기준으로 **검증된** 수치이고,
   *  FOCUS 의 pct 는 단순 당일 등락이라 정보량이 다르다.
   */
  $: focusRows = (() => {
    const rx = new Map(reactions.map((r: any) => [r.ticker, r]));
    const rows = impact.names.map((n: any) => ({ ...n, rx: rx.get(n.ticker) ?? null }));
    // FOCUS 점수에는 못 들었지만 실적 반응이 잡힌 종목도 데려온다 (그게 MOVERS 의 값어치다).
    // ★ 뒤에 붙이기만 하면 잘라낼 때 **항상 밀려난다**(실측: INTC·GOOGL 이 한 번도 안 떴다).
    //   점수를 줘서 같이 줄 세운다. 값은 임의가 아니라 focus.ts 의 척도를 그대로 쓴다 —
    //   "방금 실적을 냈다"는 촉매 0.75 × 가중 0.35 ≈ 0.26. 즉 예정 실적보다는 아래,
    //   테마만으로 든 종목보다는 위. 실제로 그 정도의 관심이다.
    const have = new Set(rows.map((r) => r.ticker));
    for (const r of reactions) {
      if (have.has(r.ticker)) continue;
      rows.push({ ticker: r.ticker, score: 0.26, reason: "REPORTED", hits: 0, earnDays: -1,
        earnHour: "", themeFace: false, pct: r.pct, rel: null, rx: r });
    }
    const cap = brief.length ? 4 : 5;
    const ranked = rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    // ★ 실적 반응은 **자리를 보장**한다.
    //   점수만으로 줄 세우면 예정 실적(0.35+)이 항상 이겨서 반응 행이 한 칸도 못 든다
    //   (실측: INTC −7.9% VERIFIED 가 계속 잘렸다).
    //   앞을 보는 정보(예정)와 뒤를 확인한 정보(검증된 반응)는 성격이 달라 서로 대체가 안 된다.
    //   → 반응이 있으면 최소 1칸을 남긴다.
    const withRx = ranked.filter((r) => r.rx);
    if (!withRx.length) return ranked.slice(0, cap);
    const rest = ranked.filter((r) => !r.rx).slice(0, cap - 1);
    return [...rest, withRx[0]].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  })();

  /** 막대 길이 = 목록 안 1위 대비 관심도 비율. 절대 점수가 아니라 서열을 보여 준다 */
  function focusWidth(s: number): number {
    const max = Math.max(...focusRows.map((m: any) => m.score ?? 0), 0.001);
    return Math.max(8, Math.round(((s ?? 0) / max) * 100));
  }

  /** 직전 스토리의 경과 시간 — 이력은 "언제 최상단이었나"가 핵심이다 */
  function seenAgo(ms: number, now: number): string {
    const m = Math.max(0, Math.round((now - ms) / 60000));
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
  }

  /** 지난 거시 이벤트의 경과 ("2d ago") */
  function macroAgo(iso: string, now: number): string {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const m = Math.max(0, Math.round((now - t) / 60000));
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  /** 재개장까지 — 길면 일/시간, 짧으면 시간/분 */
  function reopenText(ms: number): string {
    const m = Math.max(0, Math.round(ms / 60000));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${mm}m`;
    return `${mm}m`;
  }

  /** 개장/마감 임박 카운트다운 mm:ss */
  function bellText(ms: number): string {
    const t = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  }

  /** 이벤트까지 남은 시간. 추정 시각이면 분 단위 정밀 카운트다운을 주장하지 않는다. */
  function countdown(t: Date, estimated: boolean, now: number): string {
    const diff = t.getTime() - now;
    if (diff <= -60000) return "PASSED";
    if (diff <= 0) return "NOW";
    const d = Math.floor(diff / 864e5);
    const h = Math.floor((diff % 864e5) / 36e5);
    const m = Math.floor((diff % 36e5) / 6e4);
    if (estimated) return d > 0 ? `~${d}d` : `~${h}h`;
    return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
  }

  /**
   * 신선도 판정은 세션 인지형이어야 한다.
   * "15분 넘으면 빨강" 같은 절대 임계값은 주말·장마감 내내 참이라 경보 피로만 만든다.
   */
  function computeFreshness(open: boolean): { cls: string; text: string } {
    if (!firstLoadDone) return { cls: "", text: "…" };
    if (dataAsOf == null) return { cls: "dead", text: "NO DATA" };

    const ageMin = (Date.now() - dataAsOf) / 60000;
    const t = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).format(new Date(dataAsOf)).replace(",", "");

    // 헤더 폭이 빠듯하다 — 라벨을 짧게 유지한다(두 줄로 접히면 송출 프레임이 흔들린다).
    if (open) {
      if (ageMin > 15) return { cls: "dead", text: `STALE ${t}` };
      if (ageMin > 2) return { cls: "stale", text: `LAG ${t}` };
      return { cls: "", text: t };
    }
    // 장 밖에서는 전일 종가인 게 정상이다 — 경보가 아니라 사실을 표기한다.
    return { cls: "prev", text: `PREV ${t}` };
  }

  async function jget(u: string) {
    try { const r = await fetch(u); if (r.ok) return await r.json(); } catch {}
    return null;
  }

  async function refresh() {
    const [b, d, c] = await Promise.all([
      jget("/api/boards"), jget("/api/digest"), jget("/api/calendar")
    ]);
    firstLoadDone = true;

    if (b && Array.isArray(b.top)) {
      boards = b;
      if (Array.isArray(b.indexLabels) && b.indexLabels.length) indexLabels = b.indexLabels;
      if (Array.isArray(b.crossLabels) && b.crossLabels.length) crossLabels = b.crossLabels;
      if (Array.isArray(b.minis)) minis = b.minis;
      tape30 = b.tape30 ?? null;
      showingFutures = !!b.futures;
      // ★ 신선도는 소스가 준 체결 시각(dataAsOf)이다.
      //   예전 코드는 "내가 fetch 한 시각"을 찍어서, Finnhub 가 429 여도 옛 캐시만 있으면
      //   초록 UPD 가 계속 갱신됐다 (16시간 묵은 전일 종가를 "방금 갱신"으로 위장).
      dataAsOf = b.dataAsOf ?? null;
    } else {
      dataAsOf = null;
    }
    // 성공(응답 파싱됨)하면 stale 해제 + 값 갱신. 실패(null)면 옛 값을 유지하되 STALE 로 표시.
    if (d) {
      if (d.driver) digest = d;
      brief = Array.isArray(d.brief) ? d.brief : [];
      prevStories = Array.isArray(d.prevStories) ? d.prevStories : [];
      theme = d.theme ?? null;
      digestStale = false;
    } else {
      digestStale = firstLoadDone; // 첫 로드 전 실패는 STALE 이 아니라 '아직 로딩'
    }
    if (c) {
      if (Array.isArray(c.macroEvents)) {
        macroEvents = c.macroEvents.map((e: any) => ({
          title: e.title, time: new Date(e.time), estimated: !!e.estimated,
          imp: e.imp, origin: e.origin ?? "ai"
        }));
      }
      if (Array.isArray(c.earningsEvents)) {
        earningsEvents = c.earningsEvents.map((e: any) => ({
          title: e.title, time: new Date(e.time), estimated: !!e.estimated,
          imp: e.imp, origin: e.origin ?? "rule",
          ticker: e.ticker, session: e.session, dday: e.dday, watch: !!e.watch
        }));
      }
      if (Array.isArray(c.upcoming)) upcoming = c.upcoming;
      if (Array.isArray(c.reactions)) reactions = c.reactions;
      if (Array.isArray(c.reportedNow)) reportedNow = c.reportedNow;
      if (Array.isArray(c.pastMacro)) pastMacro = c.pastMacro;
      calendarStale = false;
    } else {
      calendarStale = firstLoadDone;
    }

    freshness = computeFreshness(isMarketOpen);
  }

  /** 토스트 수명의 유일한 소유자 */
  function showToast(headline: string, level: number, manual: boolean, silent = false, ageSec = 0) {
    // 진행자가 띄운 수동 속보를 자동 속보가 덮지 않는다 (방송 사고 방지)
    if (breakingData?.manual && !manual) return;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    // 새 속보가 이전 것을 **대체**한다. 쌓지 않는다 — 둘이 겹치면 어느 쪽도 못 읽는다.
    breakingData = { seq: ++toastSeq, headline, level, manual, silent, ageSec };
    if (AUTO_DISMISS_MS > 0) toastTimer = setTimeout(dismissToast, AUTO_DISMISS_MS);
  }
  function dismissToast() {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    breakingData = null;
  }

  // ★ /api/pulse 는 따로, 느리게 친다. 섹터는 60초 캐시, 거래량은 15분 캐시라
  //   15초 폴링에 얹을 이유가 없다. FMP 무료가 종목당 1요청이라 예산이 곧 주기다.
  async function refreshPulse() {
    const j = await jget("/api/pulse");
    if (j && j.sectors) sectors = j.sectors;
    if (j && Array.isArray(j.volumes)) volumes = j.volumes;
  }

  async function refreshBreaking() {
    const j = await jget("/api/breaking");
    // ※ 예전의 `if (!j?.breaking?.length) return;` 는 응답이 빈 배열이면 breakingBooted 를
    //   영영 세우지 못해, 나중에 도착한 진짜 속보 배치를 통째로 토스트로 쏟아냈다.
    if (!j || !Array.isArray(j.breaking)) return;

    const now = Date.now();
    if (!breakingBooted) {
      for (const n of j.breaking) seenBreaking.set(n.id, now);
      breakingBooted = true;
      return;
    }

    // 미열람 항목 중 **최신 1건만** 토스트하고 나머지는 전부 seen 처리한다.
    // (예전에는 15초마다 하나씩 시간을 거슬러 재생됐다)
    const fresh = j.breaking.filter((n: any) => !seenBreaking.has(n.id));
    for (const n of fresh) seenBreaking.set(n.id, now);
    const pick = fresh[0];
    if (pick) {
      showToast(pick.title, pick.level, false, pick.kind !== "breaking", pick.ageSec ?? 0);
    }

    // 나이 기준 정리. 개수 기준으로 자르면 잘려나간 id 가 다시 등장했을 때
    // 이미 방송한 속보가 재토스트된다 (피드가 최대 50시간 머문다).
    for (const [id, at] of seenBreaking) if (now - at > 48 * 3600e3) seenBreaking.delete(id);
  }

  // 컨트롤러 상태 폴링 — 차트 심볼/봉 전환 + 수동 속보
  /** 거시 지표 (FRED). 6시간 캐시라 자주 부를 필요가 없다. */
  async function refreshMacro() {
    const j = await jget("/api/macro");
    if (!j) return;
    if (Array.isArray(j.readings)) macroReadings = j.readings;
    if (Array.isArray(j.releases)) macroReleases = j.releases;
  }

  /**
   * 지수를 움직인 종목. 44개 시세를 훑으므로 헤더(15초)와 같은 주기로 돌리지 않는다.
   * 서버 캐시(quote 20초)가 있어 실제 요청은 그보다 훨씬 적지만,
   * 분당 60 제한을 헤더 시세와 나눠 써야 하므로 여유를 둔다.
   */
  async function refreshImpact() {
    // 현재 주도 테마를 같이 넘긴다 — 그 테마의 대표주에 가점이 붙는다
    sentThemeKey = theme?.key ?? "";
    const j = await jget(`/api/impact?theme=${encodeURIComponent(sentThemeKey)}`);
    if (j && Array.isArray(j.names)) impact = j;
  }

  // ★ 마운트 시점엔 theme 이 아직 null 이다 (digest 응답이 오기 전).
  //   그대로 두면 첫 요청이 테마 없이 나가고, 다음 60초 틱까지 테마 대표주가
  //   목록에 못 든다. 실측: GEO 국면인데 XOM·CVX 가 빠지고 실적만 남았다.
  //   → 주제가 바뀌면 그 즉시 다시 받는다.
  let sentThemeKey: string | null = null;
  $: if (sentThemeKey !== null && (theme?.key ?? "") !== sentThemeKey) refreshImpact();

  async function refreshControl() {
    const j = await jget("/api/control");
    if (!j) return;

    // ★ 슬롯은 **version 게이트 밖**에서 갱신한다.
    //   version 은 운영자가 /control 에서 뭔가 눌렀을 때만 올라간다. 그런데 슬롯 구성은
    //   운영자와 무관하게 **시각만으로도 바뀐다** — resolveSlots 가 정규장이면
    //   TradingView(ETF), 장 밖이면 선물 자체 렌더로 갈라 주기 때문이다.
    //   그래서 09:30 에 서버는 mode=fut → tv 로 바꿨는데 화면은 계속 선물 차트를
    //   그리고 있었다(실측). 페이지를 새로 열면 맞게 나와서 더 헷갈렸다 —
    //   24시간 방송은 페이지를 새로 열지 않으므로 **개장을 넘길 때마다** 이 상태가 된다.
    //
    //   매 폴마다 그냥 대입하면 TradingView iframe 이 흔들릴 수 있으니
    //   렌더에 영향을 주는 필드만 뽑아 지문을 만들고, 바뀌었을 때만 대입한다.
    if (Array.isArray(j.slots) && j.slots.length) {
      const sig = (rows: any[]) => rows
        .map((x) => [x.key, x.mode, x.instrument, x.tvSymbol, x.futKey, x.nvCode, x.clock, x.label, x.sniper, x.why].join("\u0001"))
        .join("\u0002");
      if (sig(j.slots) !== sig(slots)) {
        // 슬롯 **구성**이 바뀌면 TradingView 실패 기록을 초기화한다
        // (한 번 실패했다고 그 슬롯이 영원히 자체 렌더로 고정되면 안 된다)
        if (j.slots.map((x: any) => x.key).join() !== slots.map((x) => x.key).join()) {
          tvFailed = new Set();
        }
        slots = j.slots;
      }
    }

    if (j.version !== ctlVersion) {
      ctlVersion = j.version;
      if (j.chartInterval && j.chartInterval !== chartInterval) chartInterval = j.chartInterval;
      if (j.chartStyle === "line" || j.chartStyle === "candle") chartStyle = j.chartStyle;
      // 영상 송출/내리기 (컨트롤러에서 사람이 결정)
      const v = j.video && j.video.id ? { id: j.video.id, label: j.video.label ?? "" } : null;
      if (v?.id !== video?.id) video = v;
      videoPlaying = !!j.videoPlaying;
      if (j.music) music = j.music; // 배경음악 상태 (재생/볼륨/곡이동)
    }

    // ★ 속보 내리기 — 종류(자동/수동)를 불문하고 지금 떠 있는 걸 내린다.
    //   첫 폴링에서는 현재 시퀀스를 기준선으로만 잡는다(과거 클릭이 재생되면 안 된다).
    if (typeof j.breakingClearSeq === "number") {
      if (lastClearSeq === null) lastClearSeq = j.breakingClearSeq;
      else if (j.breakingClearSeq !== lastClearSeq) {
        lastClearSeq = j.breakingClearSeq;
        dismissToast();
      }
    }

    if (!manualBooted) {
      // 첫 폴링에서 서버에 남아 있던 옛 수동 속보를 "이미 본 것"으로 처리한다.
      // 이게 없으면 방송 중 새로고침할 때마다 몇 시간 전 속보가 사이렌과 함께 재방송된다.
      manualBooted = true;
      lastManualBreakingId = j.breaking ? j.breaking.id : 0;
    } else if (j.breaking) {
      // 15초 넘은 수동 속보는 띄우지 않는다 (재연결/지연 시 유령 재생 방지)
      if (j.breaking.id !== lastManualBreakingId && Date.now() - (j.breaking.at ?? 0) < 15000) {
        lastManualBreakingId = j.breaking.id;
        showToast(j.breaking.headline, j.breaking.level, true);
      }
    } else if (lastManualBreakingId !== 0) {
      // 컨트롤러의 '내리기' → 최대 1.5초 내 화면에서 실제로 내려간다 (예전엔 아무 효과가 없었다)
      lastManualBreakingId = 0;
      if (breakingData?.manual) dismissToast();
    }
  }

  let mobile = false;
  function resize() {
    // OBS 브라우저 소스에서는 절대 모바일 재배치를 하면 안 된다 (송출 프레임이 깨진다).
    // window.obsstudio 는 OBS CEF 가 주입하는 객체라 URL 파라미터나 사용자 기억력이 필요 없다.
    const inOBS = typeof window !== "undefined" && !!(window as any).obsstudio;
    mobile = !inOBS && window.innerWidth <= 1200;
    scale = mobile ? 1 : Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  }

  function sent(s: string) {
    if (s === "bull" || s === "pos") return "pos";
    if (s === "bear" || s === "neg") return "neg";
    return "neu";
  }

  /** 기사 나이. 화면에 시:분만 찍히면 15시간 된 기사가 오늘 것처럼 보인다.
   *  now 를 인자로 받아 1초 틱(nowMs)에 반응 → 피드가 멎어도 나이가 정직하게 늘어난다. */
  function ago(epochSec: number, now = Date.now()): string {
    if (!epochSec) return "";
    const m = (now / 1000 - epochSec) / 60;
    if (m < 1) return "just now";
    if (m < 60) return `${Math.round(m)}m`;
    if (m < 60 * 48) return `${Math.round(m / 60)}h`;
    return `${Math.round(m / 1440)}d`;
  }

  onMount(() => {
    resize();
    window.addEventListener("resize", resize);
    refresh(); refreshBreaking(); refreshControl(); refreshMacro(); refreshImpact(); refreshPulse();

    // ※ 폴링 주기는 "호출 횟수"가 아니다. refresh 1회 = 유일 티커 17개 조회다.
    //   Finnhub 무료 한도 60 req/min 안에 들어오려면 주기 15s + 서버 TTL 20s 조합이 필요하다.
    //   (예전 설정은 실측 176 req/min 으로 한도의 3배였고, 상시 429 상태였다)
    const t1 = setInterval(updateTimers, 1000);
    const t2 = setInterval(refresh, 15000);
    const t3 = setInterval(refreshBreaking, 15000);
    const t5 = setInterval(refreshControl, 1500); // 컨트롤러 반응성
    // 거시 지표는 월 단위로 갱신되는 값이라 10분이면 충분하다 (서버는 6시간 캐시)
    const t6 = setInterval(refreshMacro, 600000);
    // 지수 영향 종목 — 44개 시세를 훑으므로 60초. 서버 캐시가 20초라 대부분 캐시 히트다.
    const t7 = setInterval(refreshImpact, 60000);
    const t8 = setInterval(refreshPulse, 120000);   // 섹터 60s·거래량 15m 캐시 — 2분이면 충분하다
    return () => {
      window.removeEventListener("resize", resize);
      [t1, t2, t3, t5, t6, t7, t8].forEach(clearInterval);
      if (toastTimer) clearTimeout(toastTimer);
    };
  });
</script>

<div class="wrap" class:m={mobile} style={mobile ? "" : `transform: scale(${scale});`}>
  <!-- {#key} 가 없으면 breakingData 가 truthy→truthy 로 바뀔 때 Svelte 가 컴포넌트를 재생성하지 않아
       두 번째 속보는 소리도 등장 애니메이션도 나지 않는다. 헤드라인이 아니라 단조증가 seq 를 키로 쓴다
       (같은 문구를 다시 송출하는 경우가 실제로 있다). -->
  {#if breakingData}
    {#key breakingData.seq}
      <BreakingToast
        headline={breakingData.headline}
        level={breakingData.level}
        silent={breakingData.silent}
        ageSec={breakingData.ageSec}
      />
    {/key}
  {/if}

  <!-- ===== HEADER ===== -->
  <header class="hd">
    <div class="hd-l">
      <div class="logo">MARKET<span>WATCH</span></div>
      <!-- 상태 + 닫힌 이유 + 다시 열리는 시각. "왜 꺼졌는지"를 화면이 직접 말한다. -->
      <div class="badge" class:active={mkt.open} class:closed={!mkt.open}>
        <span class="dot"></span>
        <span class="b-main">{mkt.label}</span>
        <!-- 사유·재개장 시각은 **개장이 가까울 때만** 붙인다.
             주말 내내 "WEEKEND · opens in 1d 18h" 를 달고 있으면 헤더가 두 줄로 접힌다.
             (세션 구분은 시세 스트립의 세션 배지가 이미 담당한다) -->
        {#if !mkt.open && mkt.msToOpen != null && mkt.msToOpen < 6 * 3600_000}
          <span class="b-next">{reopenText(mkt.msToOpen)}</span>
        {/if}
      </div>
      <!-- 개장/마감 임박 카운트다운 (마지막 1시간에만, 마지막 5분엔 맥동) -->
      {#if bell.kind}
        <div class="bell {bell.kind}" class:soon={bell.ms <= 300000}>
          <span class="bell-dot"></span>{bell.kind === "open" ? "OPENS IN" : "CLOSES IN"} {bellText(bell.ms)}
        </div>
      {/if}
    </div>
    <!-- 고정 슬롯 렌더: 티커가 죽어도 자리가 남고 "—" 로 결측을 드러낸다 -->
    <div class="top-strip">
      <!-- ★ 지금 이 숫자가 **어느 세션의 값인지** 명시한다.
           장 밖엔 선물(24시간)을 띄우므로 "프리마켓"이라고 부르면 거짓이 된다 →
           현물 세션과 지금 보고 있는 상품을 나눠서 말한다. -->
      <div class="sesh" class:live={isMarketOpen}>
        <span class="sesh-k">{SESSION_LABEL[marketSession] ?? marketSession}</span>
        <span class="sesh-s">{showingFutures ? "futures" : "cash"}</span>
      </div>
      <!-- ★ 이 한 줄에는 세션 시계가 다른 값들이 섞여 있다 (선물 / 미국 ETF / 암호화폐).
           실측 사고: 월요일 새벽에 "NASDAQ FUT +1.49%" 옆에 "SOXX −4.40%" 가 나란히 떴는데
           앞은 실시간, 뒤는 **금요일 종가(47시간 전)** 였다. 화면이 구분을 안 하니
           둘 다 지금 값으로 읽힌다. 자기 시장이 닫힌 값은 흐리게 + 마지막 거래일을 붙인다. -->
      {#each headerLabels as k}
        {@const t = boards.top.find((x) => x.k === k)}
        <div class="idx">
          <span class="k" class:closed={t && !t.live}>{k}</span>
          {#if t}
            <span class="v" class:u={t.pct >= 0} class:d={t.pct < 0} class:closed={!t.live}
                  title={t.live ? "" : "Market closed — last session's close"}>
              {t.pct > 0 ? "+" : ""}{Number(t.pct).toFixed(2)}%{#if !t.live}<span class="stale-mark">·{lastSessionTag}</span>{/if}
            </span>
          {:else}
            <span class="v miss" title="No quote">—</span>
          {/if}
        </div>
      {/each}
    </div>
    <div class="hd-r">
      <div class="clock">{etNow} <span class="tz">ET</span></div>
      <!-- 항상 렌더한다. 예전에는 첫 요청이 실패하면 배지가 DOM 에 아예 생기지 않아
           오프라인 콜드스타트가 "조용한 장"처럼 보였다. -->
      <div class="upd {freshness.cls}" title="Quote timestamp (last trade from source)">
        <span class="upd-dot"></span>{freshness.text}
      </div>
    </div>
  </header>

  <!-- ===== BODY ===== -->
  <main class="grid">
    <!-- LEFT: news -->
    <section class="col left">
      <!-- TOP STORY: 헤드라인 + confidence 뱃지(HIGH 등)만. 출처·시각·설명은 싣지 않는다. -->
      <div class="driver {sent(digest.driver.sentiment)}" class:nodata={digest.driver.noData}>
        <div class="lbl">
          TOP STORY
          {#if digest.driver.origin === "ai" && digest.driver.confidence}
            <span class="conf {digest.driver.confidence}">{CONF_LABEL[digest.driver.confidence] ?? digest.driver.confidence}</span>
          {/if}
          {#if digestStale}<span class="stale-chip" title="News feed not responding">STALE</span>{/if}
        </div>
        <div class="driver-txt">{digest.driver.text}</div>
        <!-- 언제 나온 뉴스인지 — 24시간 방송이라 "몇 시간 전 이야기인지"가 핵심 맥락이다 -->
        {#if digest.driver.epoch}
          <div class="driver-meta">
            <span class="dm-age">{ago(digest.driver.epoch, nowMs)} ago</span>
            <!-- ★ 근거 출처를 **전부** 적는다.
                 Claude 가 웹검색으로 여러 기사를 읽고 한 문장을 만들어도 예전엔 첫 매체
                 하나만 나와서, 종합 판단이 "CNBC 기사 한 건"처럼 보였다.
                 어디서 온 이야기인지가 이 화면 신뢰의 대부분이다. -->
            {#if srcNames}
              <!-- AI 판단은 기사 하나의 바이라인이 아니라 **여러 기사를 읽고 만든 문장**이다.
                   "· CNBC" 로만 쓰면 CNBC 기사를 옮긴 것처럼 보인다 → "via" 로 구분한다. -->
              <span class="dm-src">{digest.driver.origin === "ai" ? "via" : "·"} {srcNames}</span>
            {:else if digest.driver.source}
              <span class="dm-src">· {digest.driver.source}</span>
            {/if}
          </div>
        {/if}
      </div>

      <!-- TODAY: 오늘 시장의 핵심 이벤트·뉴스 + 각각의 영향 한 줄.
           예정 이벤트는 시작시각으로 카운트다운/LIVE NOW 를 여기(클라이언트)서 계산한다. -->
      {#if brief.length}
        <div class="panel today">
          <div class="lbl">TODAY<span class="src-hint">events · impact</span></div>
          <div class="td-list">
            <!-- ★ MARKET FOCUS 와 같이 뜨면 좌측이 넘친다(실측). 브리핑은 Claude 가
                 중요도 순으로 주므로 위 2건이 가장 중요한 것이다. -->
            {#each brief.slice(0, impact.names.length ? 2 : 3) as b}
              {@const st = b.startET ? Date.parse(b.startET) : NaN}
              {@const durMs = (b.durationMin ?? 90) * 60000}
              {@const liveNow = Number.isFinite(st) && nowMs >= st && nowMs < st + durMs}
              <div class="td-item {b.dir}">
                <div class="td-top">
                  <span class="td-arrow">{b.dir === "pos" ? "▲" : b.dir === "neg" ? "▾" : "•"}</span>
                  <span class="td-tit">{b.title}</span>
                  {#if liveNow}
                    <span class="td-live">● LIVE</span>
                  {:else if Number.isFinite(st) && st > nowMs}
                    <span class="td-when">{b.estimated ? "~" : ""}{etClock(st)}</span>
                  {/if}
                </div>
                <div class="td-impact">{b.impact}</div>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <div class="panel news">
        <!-- 이 피드의 최신 기사 나이 최솟값이 2.4시간이라 "LIVE" 는 어떤 조건으로도 참이 될 수 없다 -->
        <div class="lbl">
          MARKET HEADLINES
          <span class="src-hint">by impact</span>
        </div>
        <div class="news-list">
          {#each digest.news as n}
            {@const ageM = n.epoch ? (nowMs / 1000 - n.epoch) / 60 : 0}
            {@const s = sent(n.sentiment)}
            <!-- 트레이더 스캔: [임팩트레일] [주체칩 ▲/▾] 한 줄 헤드라인 … [출처·나이]. 90분↑은 흐리게. -->
            <!-- ★ 중요도 4~5 는 시간이 지나도 흐리게 만들지 않는다.
                 나이로만 흐리게 처리하니 5★ 지정학 기사가 20시간 지났다는 이유로
                 잡기사와 똑같이 회색이 됐다 — 정작 제일 중요한 게 안 보였다.
                 오래됐다는 사실은 우측 나이 표기가 이미 말해 준다. -->
            <a class="news-item {s}" class:hi={n.level >= 4} class:old={ageM > 90 && n.level < 4}
               href={n.url} target="_blank" rel="noreferrer" title={n.title}>
              <span class="n-stars {s}">{stars(n.level)}</span>
              <span class="n-tit">{n.short ?? n.title}</span>
              {#if n.epoch}<span class="n-age">{ago(n.epoch, nowMs)}</span>{/if}
            </a>
          {/each}
          {#if digest.news.length === 0}
            <div class="empty">No headlines</div>
          {/if}
        </div>
      </div>

      <!-- 헤드라인 아래 빈 공간:
           · 평소  → **직전 TOP STORY 3건** (오늘 흐름을 잡는 유일한 단서)
           · 영상 송출 중 → 영상이 그 자리를 대신한다 (둘이 겹치지 않는다) -->
      {#if video}
        {#key video.id}
          <LiveVideo videoId={video.id} label={video.label} playing={videoPlaying} />
        {/key}
      {:else}
        <!-- ★ 지금 시장이 보고 있는 종목.
             가격이 아니라 **관심의 소재**를 잰다:
               · 최근 48시간 헤드라인에 몇 번 나왔나 (지금 이야기되고 있나)
               · 실적이 임박했나 / 방금 냈나  ← 발표 전엔 아직 안 움직였어도 시장의 중심이다
               · 지금 주도 테마(MARKET DRIVER)의 대표주인가
             가격 변동은 네 번째로만 쓴다 — 순위를 정하는 값이 아니라 확인용이다.
             그래서 각 행에 **왜 여기 있는지**를 같이 적는다. 근거 없이 티커만 띄우지 않는다. -->
        {#if impact.names.length}
          <div class="panel mlink">
            <div class="lbl">
              MARKET FOCUS
              <!-- ★ 오른쪽 등락률이 **언제 값인지** 밝힌다.
                   순위 기준(뉴스·촉매·테마)은 24시간 유효하지만 등락률은 현물 시세라
                   장 밖엔 직전 세션 종가에서 멈춰 있다. 헤더 스트립은 이미 이걸
                   흐림+태그로 구분하는데 이 패널만 안 하고 있었다. -->
              <span class="src-hint">
                news · catalyst · theme{impact.live ? "" : ` · px ${lastSessionTag}`}
              </span>
            </div>
            <div class="im-list">
              {#each focusRows as m}
                {@const px = m.rx ? m.rx.pct : m.pct}
                {@const stale = m.rx ? !m.rx.live : !impact.live}
                <!-- ★ Claude 가 고른 항목은 **티커가 없을 수 있다** —
                     "MEMORY CYCLE" 처럼 논쟁 자체가 주제이거나, 스페이스엑스처럼 비상장이다.
                     그때는 티커 칸을 넓게 써서 주제 이름을 그대로 크게 보여준다. -->
                <div class="im-item" class:theme={m.isTheme}>
                  <span class="im-tk">
                    {m.ticker}
                    <!-- 실적 결과 배지 — MOVERS 에서 넘어온 정보 -->
                    {#if m.rx?.result === "beat"}<span class="e-res beat">BEAT</span>
                    {:else if m.rx?.result === "miss"}<span class="e-res miss">MISS</span>
                    {:else if m.rx?.result === "inline"}<span class="e-res inline">IN LINE</span>{/if}
                  </span>
                  <span class="im-why" class:cat={m.earnDays != null && m.earnDays >= -3 && m.earnDays <= 7}>
                    {m.rx?.tag || m.reason}
                  </span>
                  <span class="im-bar">
                    <!-- 막대 = 이 목록 안에서의 관심도 서열. 숫자보다 먼저 읽힌다 -->
                    <span class="im-fill" style="width:{focusWidth(m.score)}%"></span>
                  </span>
                  <!-- ★ 검증 여부를 숨기지 않는다. 리캡(LLM)이 준 숫자가 실제와 정반대였던
                       사고가 있었다 (INTC: 리캡 "+3.4%" vs 실제 −7.89%).
                       정지된 값은 헤더 스트립과 같은 방식으로 흐리게 처리한다. -->
                  <span class="im-px">
                    <span class="im-pct" class:u={(px ?? 0) >= 0} class:d={(px ?? 0) < 0}
                          class:closed={stale} class:unv={m.rx && !m.rx.verified}
                          title={stale ? "Market closed — last session's close" : ""}>
                      {#if m.rx?.live}<span class="live-pip"></span>{/if}{px == null ? "—" : `${px >= 0 ? "+" : "−"}${Math.abs(px).toFixed(2)}%`}
                    </span>
                    {#if m.rx}
                      <span class="im-ver" class:unv={!m.rx.verified}>
                        {m.rx.live ? "LIVE" : m.rx.verified ? "VERIFIED" : "UNVERIFIED"}
                      </span>
                    {/if}
                  </span>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- 직전 TOP STORY — 이력이 쌓였을 때만.
             TODAY 브리핑이 있으면 자리를 내준다. 좌측 우선순위는
             TOP STORY > TODAY > 헤드라인 > MARKET FOCUS > 지난 스토리 다.
             (예전엔 자리가 없어도 렌더돼서 높이 2px 짜리 빈 상자가 남았다) -->
        {#if prevStories.length && !brief.length}
          <div class="panel mlink stories">
            <div class="lbl">EARLIER TOP STORIES<span class="src-hint">last {prevStories.length}</span></div>
            <div class="ps-list">
              {#each prevStories as p}
                <div class="ps-item {sent(p.sentiment)}">
                  <span class="ps-when">{seenAgo(p.seenAt, nowMs)}</span>
                  <span class="ps-txt">{p.text}</span>
                  {#if p.source}<span class="ps-src">{p.source}</span>{/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
    </section>

    <!-- CENTER: 1분봉 차트 (컨트롤러 조종) -->
    <section class="col center">
      <!-- ★ TAPE READ — "지금 이 테이프가 무엇을 하고 있나".
           화면의 다른 모든 숫자는 **당일 누적**이라, 나스닥이 장중에 밀려도
           헤더는 초록색 +0.23% 를 띄운다(실측). 그 자리를 만든 것이다.

           조용해도 사라지지 않는다 — 사라지면 "지난 구간에 대해 화면이 침묵하는 상태"가
           다시 생긴다. 그게 원래 문제였다. 조용하면 숫자만 보여 주고 QUIET 이라고 쓴다.

           좌우 컬럼이 아니라 여기 두는 이유: 우측은 이미 넘침이 실측돼 두 번 손봤고(1014·1072행),
           중앙은 바로 아래에 같은 세 지수의 미니차트가 있어 눈이 "최근 30분 → 25시간 곡선"으로 이어진다. -->
      {#if tape30}
        <div class="tape30 t-{tape30.tier}">
          <div class="t30-lab">
            <span class="t30-k">LAST {tape30.windowMin ?? "—"}M</span>
            <span class="t30-s">FUT</span>
          </div>
          {#if tape30.tier === "moving"}
            <span class="t30-arrow" class:u={(tape30.subjectPct ?? 0) >= 0} class:d={(tape30.subjectPct ?? 0) < 0}>
              {(tape30.subjectPct ?? 0) >= 0 ? "▲" : "▼"}
            </span>
            <span class="t30-sub">{tape30.subject}</span>
            <span class="t30-pct" class:u={(tape30.subjectPct ?? 0) >= 0} class:d={(tape30.subjectPct ?? 0) < 0}>
              {(tape30.subjectPct ?? 0) >= 0 ? "+" : "−"}{Math.abs(tape30.subjectPct ?? 0).toFixed(2)}%
            </span>
            {#if tape30.shape}<span class="t30-shape">{tape30.shape}</span>{/if}
            {#if tape30.giveback}<span class="t30-give">{tape30.giveback}</span>{/if}
          {:else if tape30.tier === "quiet"}
            {#each tape30.rows as r}
              <span class="t30-row">
                <span class="t30-rn">{r.name}</span>
                <span class="t30-rp" class:u={r.pct >= 0} class:d={r.pct < 0}
                  >{r.pct >= 0 ? "+" : "−"}{Math.abs(r.pct).toFixed(2)}%</span>
              </span>
            {/each}
            <span class="t30-quiet">QUIET</span>
            {#if tape30.giveback}<span class="t30-give">{tape30.giveback}</span>{/if}
          {:else}
            <span class="t30-off">—</span>
            <span class="t30-reason">{tape30.reason}</span>
          {/if}
        </div>
      {/if}
      <!-- 1~4개 차트. 슬롯 수가 곧 배치 (1=전체, 2=좌우, 3=1+2, 4=2x2) -->
      <!-- (섹터 스트립은 미니차트 아래에 붙는다 — 아래쪽 참고) -->
      <div class="chart-grid" data-n={slots.length}>
        {#each slots as sl (sl.key)}
          <!-- 라이브 램프. {@const} 는 블록의 직계 자식이어야 해서 여기서 계산한다.
               fbLamp = TradingView 실패로 자체 렌더에 폴백했을 때의 시계 (그리는 소스 기준) -->
          {@const lamp = chartLive(sl.clock ?? "globex", futSess, marketSession, isMarketOpen)}
          {@const fbLamp = chartLive(sl.futKey ? "globex" : "local", futSess, marketSession, isMarketOpen)}
          <div class="chart-card" class:sniped={sl.sniper}>
            <div class="chart-head">
              <!-- 선물 모드는 차트 안의 큰 시세 표기가 이름을 담당한다 (중복 방지) -->
              <span class="ch-name">{sl.mode === "tv" ? sl.label : ""}</span>
              <!-- TradingView 경로는 큰 시세 표기가 없으므로 상품 배지를 여기에 붙인다.
                   무료 임베드는 지수 원본을 못 그려서 전부 ETF 대체물이다 — 숨기지 않는다. -->
              {#if sl.mode === "tv" && sl.instrument}
                <span class="ch-inst">{sl.instrument}</span>
              {/if}
              {#if sl.sniper}
                <!-- 자동으로 물어온 슬롯임을 명확히 -->
                <span class="ch-snipe">◎ SNIPER</span>
              {/if}
              {#if sl.note}
                <!-- 지수 원본이 아니라 대체물임을 숨기지 않는다 -->
                <span class="ch-note">{sl.note}</span>
              {/if}
              <!-- 예전 표기는 두 가지를 동시에 거짓말했다: 1분봉을 "1M"(=월봉)으로 찍었고,
                   주말·휴장·차트 실패를 불문하고 초록 "LIVE" 를 박았다. -->
              {#if sl.mode === "fut"}
                <!-- 선물은 현물 세션과 다르다: 밤새 열려 있고 매일 17–18시 ET 만 쉰다 -->
                <span class="ch-meta" class:live={futSess.open}>
                  {FUT_TF_LABEL[futTf]} · {futSess.label}
                </span>
              {:else if sl.mode === "nv"}
                <!-- 상품 표기("INDEX")는 이름 옆 배지가 맡는다 → 여기선 봉 간격만.
                     세션은 여전히 주장하지 않는다 — 현지 거래소 시계를 우리가 모른다. -->
                <span class="ch-meta">{FUT_TF_LABEL[futTf]}</span>
              {:else}
                <span class="ch-meta" class:live={isMarketOpen}>
                  {IV_LABEL[chartInterval] ?? chartInterval} · {marketMsg}
                </span>
              {/if}
            </div>
            <div class="chart-body">
              {#if sl.mode === "tv" && tvFailed.has(sl.key) && (sl.futKey || sl.nvCode)}
                <!-- TradingView 가 안 뜬 슬롯 → 자체 렌더로 대체.
                     빈 화면보다 5분봉이라도 나오는 편이 낫다.
                     ※ 램프는 **실제로 그리는 소스** 기준이다 — 선물로 대체됐으면 선물 시계다. -->
                <FuturesChart src={sl.futKey ? "finviz" : "naver"}
                              symbol={sl.futKey || sl.nvCode || ""} tf={futTf} name={sl.label}
                              compact={slots.length > 2} style={chartStyle}
                              live={fbLamp.live} session={fbLamp.session}
                              instrument={sl.futKey ? "FUT" : "INDEX"} />
              {:else if sl.mode === "nv"}
                <FuturesChart src="naver" symbol={sl.nvCode ?? ""} tf={futTf} name={sl.label}
                              compact={slots.length > 2} style={chartStyle}
                              live={lamp.live} session={lamp.session}
                              instrument={sl.instrument ?? "INDEX"} />
              {:else if sl.mode === "fut"}
                <!-- 임시 슬롯(fv:)은 라벨이 심볼코드("SB")뿐이라 이름을 넘기지 않는다.
                     그러면 차트가 소스가 준 진짜 이름("Sugar")을 쓴다. -->
                <FuturesChart symbol={sl.futKey} tf={futTf}
                              name={sl.key.startsWith("fv:") ? "" : sl.label}
                              compact={slots.length > 2} style={chartStyle}
                              why={sl.why ?? ""}
                              live={lamp.live} session={lamp.session}
                              instrument={sl.instrument ?? "FUT"} />
              {:else}
                <TVChart symbol={sl.tvSymbol} interval={chartInterval}
                         on:fail={() => { tvFailed = new Set([...tvFailed, sl.key]); }} />
              {/if}
            </div>
          </div>
        {/each}
      </div>

      <!-- ★ 섹터 로테이션 — "지수 숫자 말고, 돈이 어디서 어디로 갔나".
           지수는 밋밋해도 그 안에서 크게 도는 날이 있다. 실측(2026-07-29):
           SEMIS −4.80% vs HEALTH +2.36%, 스프레드 7.16%p — 그날의 이야기가 통째로 여기 있었는데
           화면엔 말할 자리가 없었다.
           ※ SPDR 섹터 ETF 다. 섹터 지수의 **근사**이지 지수 자체가 아니라서 티커를 남긴다.
           ※ 전부 미국 상장 ETF → 정규장에만 움직인다. 장 밖엔 흐리게(live=false). -->
      {#if sectors && sectors.rows.length}
        <div class="sect" class:closed={!sectors.live}>
          <div class="sect-h">
            <span class="sect-t">SECTORS</span>
            <span class="sect-s">
              {sectors.live ? "vs S&P · today" : "vs S&P · last session"}
              {#if sectors.spread != null}<span class="sect-sp">SPREAD {sectors.spread.toFixed(2)}%p</span>{/if}
            </span>
          </div>
          <div class="sect-row">
            {#each sectors.rows as r (r.key)}
              <div class="sect-c" class:u={r.pct >= 0} class:d={r.pct < 0} title={r.key}>
                <span class="sect-n">{r.label}</span>
                <span class="sect-p">{r.pct >= 0 ? "+" : "−"}{Math.abs(r.pct).toFixed(1)}%</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <div class="spark-strip">
        {#each minis as m (m.key)}
          <div class="ss-card">
            <div class="ss-top">
              <span class="ss-name">{m.label}</span>
              <!-- 어느 구간의 차트인지 명시 — 등락률과 창이 다르면 시청자가 오해한다.
                   ★ Globex 가 쉬는 동안(매일 17–18시 ET·주말)은 이 값이 멈춰 있다.
                     "24H" 만 찍으면 항상 도는 것처럼 읽힌다. -->
              <span class="ss-tf">{m.live === false ? "CLOSED" : "24H"}</span>
            </div>
            <!-- 시세는 별도 줄에 크게. 포인트 등락을 %와 나란히 둔다. -->
            <!-- ★ pct 가 null = **심볼이 안 왔다**. 예전엔 0 으로 채워서 초록 +0.00% 를
                 확정값처럼 그렸다 — "보합"과 "데이터 없음"은 완전히 다른 얘기다. -->
            <div class="ss-quote" class:u={m.pct != null && m.pct >= 0} class:d={m.pct != null && m.pct < 0}>
              <span class="ss-px">{m.price}</span>
              {#if m.abs && m.pct != null}<span class="ss-abs">{m.pct >= 0 ? "+" : "−"}{m.abs}</span>{/if}
              <span class="ss-pct">{m.pct == null ? "—" : `${m.pct >= 0 ? "+" : "−"}${Math.abs(m.pct).toFixed(2)}%`}</span>
            </div>
            <!-- 자체 SVG — 선물도 그릴 수 있고 iframe 이 아니라 가볍다 -->
            <div class="ss-chart">
              <Sparkline points={m.spark} up={(m.pct ?? 0) >= 0} base={m.base} />
            </div>
          </div>
        {/each}
      </div>
    </section>

    <!-- RIGHT: key event + watchlist -->
    <section class="col right">
      <div class="keyevent">
        <div class="ke-hdr"><span class="ke-lbl">◇ UPCOMING</span></div>

        <!-- 지표 발표 일정 — 출처가 FRED(연준)라 날짜가 확정치다 -->
        {#if macroReleases.length}
          <div class="ke-grp">DATA</div>
          <!-- ★ 실적 반응(MOVERS)이 들어오면 우측 3패널이 940px를 넘긴다(실측).
               UPCOMING 이 가장 크므로 여기서 자리를 낸다 — 가장 가까운 일정이 가장 중요하다. -->
          {#each macroReleases.slice(0, 3) as rel}
            <div class="ke-item">
              <div class="ke-el">
                <span class="ke-stars">{stars(rel.imp)}</span>
                <span class="ke-tit">{rel.name}</span>
              </div>
              <div class="ke-timer">{rel.date.slice(5)}</div>
            </div>
          {/each}
        {/if}

        <!-- 거시/정책 일정 — FOMC 등. 시장 전체를 움직인다. -->
        {#if macroEvents.length}
          <div class="ke-grp">EVENT</div>
          {#each macroEvents as ev (ev.title)}
            <div class="ke-item">
              <div class="ke-el">
                <span class="ke-stars">{stars(ev.imp)}</span>
                <span class="ke-tit">{ev.title}</span>
              </div>
              <div class="ke-timer">{countdown(ev.time, ev.estimated, nowMs)}</div>
            </div>
          {/each}
        {/if}

        <!-- 개별 종목 실적 — 종목/섹터를 움직인다. 세션(장전/장후)까지 표기. -->
        {#if earningsEvents.length}
          <div class="ke-grp">EARNINGS</div>
          <!-- ★ 개수를 고정하지 않는다. 실적 시즌엔 하루에 대형주가 여럿 내는데
               2에서 자르면 그날의 절반이 화면에서 사라진다. 위 그룹(거시·데이터)이
               차지한 만큼을 빼고 남는 자리를 준다 — 우측 컬럼은 넘침이 실측된 곳이라
               총량은 지킨다(1014·1072행 주석 참고). -->
          {#each earningsEvents.slice(0, Math.max(2, 5 - macroEvents.length - macroReleases.length - reportedRows.length)) as ev (ev.ticker + ev.time.getTime())}
            <div class="ke-item sub">
              <div class="ke-el">
                <span class="ke-stars">{stars(ev.imp)}</span>
                <span class="ke-tk">{ev.ticker}</span>
                <span class="ke-sess">{ev.session}</span>
              </div>
              <div class="ke-timer">{countdown(ev.time, ev.estimated, nowMs)}</div>
            </div>
          {/each}
        {/if}

        <!-- ★ 발표가 끝난 종목의 **결과**. 예전엔 MARKET FOCUS 에 섞여 있었는데
             그 자리를 AI 판단으로 바꾸면서 통째로 사라졌다 — 일정만 남고 결과가 없어졌다.
             일정 바로 아래가 원래 자리다: "누가 내나" 다음이 "어떻게 나왔나".
             ※ 등락률은 **검증된 것만** 찍는다. 리캡(LLM)이 주장한 값은 쓰지 않는다
               (calendar/+server.ts 의 INTC +10% ↔ −7.89% 사고 주석 참고). -->
        {#if reportedRows.length}
          <div class="ke-grp">REPORTED</div>
          {#each reportedRows as r (r.ticker)}
            <div class="ke-item sub">
              <div class="ke-el">
                <span class="ke-tk">{r.ticker}</span>
                {#if r.result}<span class="ke-res {r.result}">{r.result.toUpperCase()}</span>{/if}
                <!-- ★ 폭이 곧 정보다. META 가 예상을 16% 하회한 것과 QCOM 이 2.7%
                     하회한 것은 같은 MISS 라도 전혀 다른 사건이다. -->
                {#if r.surprisePct != null}
                  <span class="ke-surp">{r.surprisePct > 0 ? "+" : ""}{r.surprisePct.toFixed(1)}% vs est</span>
                {/if}
              </div>
              <div class="ke-timer" class:u={r.pct != null && r.pct >= 0} class:d={r.pct != null && r.pct < 0}>
                {r.pct == null ? "—" : `${r.pct >= 0 ? "+" : "−"}${Math.abs(r.pct).toFixed(2)}%`}
              </div>
            </div>
          {/each}
        {/if}

        {#if !macroEvents.length && !earningsEvents.length && !macroReleases.length && !reportedRows.length}
          <div class="ke-item"><div class="ke-tit">—</div></div>
        {/if}
      </div>

      <!-- ※ 예전엔 여기 EARNINGS 패널이 따로 있었는데 UPCOMING 의 EARNINGS 그룹과
           내용이 겹쳤다(예정 실적이 두 곳에 나왔다). 발표된 종목은 아래 MARKET DRIVERS
           이 반응%까지 담당하므로 이 패널을 지우고 공간을 헤드라인에 넘겼다. -->

      <!-- ===== US ECONOMY =====
           최신 발표치 + 이전치 대비 방향. 이건 '시장 반응'이 아니라 **지표 그 자체**라
           MARKET DRIVERS 와 한 패널에 두면 이름과 내용이 어긋난다.
           출처가 연준(FRED)이라 검증 대상이 아니라 기준이다. -->
      {#if macroReadings.length}
        <div class="panel econ">
          <div class="lbl">📊 US ECONOMY<span class="src-hint">latest actual · FRED</span></div>
          <!-- ★ 우측도 자리가 유한하다. 실적 반응(MOVERS)이 들어오면 아래 패널이
               통째로 화면 밖으로 밀린다(실측 339px 초과) → 반응이 있을 땐 지표를 줄인다. -->
          {#each macroReadings.slice(0, 4) as m}
            <!-- ★ 3상태다. 예전엔 `m.value > m.prev` 라는 **참/거짓 두 값**이라
                 "같다"가 "내렸다"로 렌더됐다. 실업률 4.1% → 4.1%(흔하다), FOMC 사이의
                 기준금리, 소수 첫째 자리에서 반올림돼 같아지는 CPI 가 전부 여기 걸린다.
                 화면은 변화가 없는데 "▼ vs prev" 를 비둘기 색으로 찍고 있었다. -->
            {@const dir = (m.prev == null || m.value == null) ? null
                        : (m.value > m.prev ? 1 : m.value < m.prev ? -1 : 0)}
            <div class="rx-row">
              <div class="rx-l">
                <div class="rx-tk">{m.label}</div>
                <div class="rx-tag">{m.period}{m.prev != null ? ` · prev ${m.prev}` : ""}</div>
              </div>
              <div class="rx-r">
                <div class="rx-pct"
                     class:u={dir !== null && dir !== 0 && (m.upIsHawkish ? dir < 0 : dir > 0)}
                     class:d={dir !== null && dir !== 0 && (m.upIsHawkish ? dir > 0 : dir < 0)}>
                  {m.value ?? "—"}{m.unit.startsWith("%") ? "%" : m.unit}
                </div>
                <!-- ★ 방향도 값과 **같은 색**을 쓴다.
                     예전엔 회색이라, 정작 "지난번보다 뜨거워졌나"가 한눈에 안 들어왔다.
                     기준은 등락이 아니라 매파/비둘기다 — CPI 상승은 빨강(악재),
                     실업률 상승도 빨강. upIsHawkish 가 그 방향을 들고 있다. -->
                <div class="rx-when"
                     class:u={dir !== null && dir !== 0 && (m.upIsHawkish ? dir < 0 : dir > 0)}
                     class:d={dir !== null && dir !== 0 && (m.upIsHawkish ? dir > 0 : dir < 0)}>
                  {dir == null ? "" : dir > 0 ? "▲ vs prev" : dir < 0 ? "▼ vs prev" : "= vs prev"}
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      <!-- ===== MARKET DRIVERS =====
           "무엇이 시장을 움직였나". 실적 목록과 성격이 다르다:
           저긴 '언제 발표하나' 일정표고, 여긴 '그래서 주가가 어떻게 됐나' 결과판이다.
           ※ 이름을 REACTION → DRIVERS 로 바꿨다. 시청자가 찾는 건 "시장이 반응했다"가
             아니라 **"무엇이 이 시장을 움직이고 있나"** 다. 담긴 내용(거시 결과 + 실제로
             움직인 종목)은 처음부터 드라이버 목록이었는데 이름만 다른 걸 말하고 있었다. -->
      <div class="panel react">
        <div class="lbl">⚡ MARKET DRIVER<span class="src-hint">what's moving it</span></div>

        <!-- ★ 지배 주제를 **한 단어로** 먼저 말한다.
             예전엔 이 패널이 MACRO/MOVERS 두 목록뿐이라, 주말이나 실적 비수기엔 양쪽 다
             비어서 "No macro release / No reaction data" 만 떴다. 정작 시장을 움직이는 게
             전쟁이어도 화면 어디에도 "WAR" 라는 말이 없었다.
             밑줄 근거는 헤드라인 몇 건이 이 주제인지 + 자산이 실제로 어떻게 반응했는지. -->
        {#if theme}
          <div class="mdrv">
            <div class="mdrv-top">
              <span class="mdrv-tag">{theme.label}</span>
              <span class="mdrv-lv" class:max={theme.level >= 5}>{stars(theme.level)}</span>
            </div>
            <!-- 왜 이 주제가 시장에 중요한가 — 주제마다 고정 문장이다.
                 그때그때 지어내지 않는다: 전달하는 건 사건이 아니라 메커니즘이라
                 이 문장이 틀릴 일이 없고, "왜 하필 이 세 자산인가"를 설명해 준다. -->
            {#if theme.note}<div class="mdrv-note">{theme.note}</div>{/if}
            <div class="mdrv-meta">{theme.count} of {theme.total} top headlines</div>
            <!-- 주제 이름만으론 "그래서 시장은?" 이 안 나온다. 실제 반응을 붙인다. -->
            {#if themeMoves.length}
              <div class="mdrv-ev">
                {#each themeMoves as m}
                  <span class="mdrv-a">
                    <b>{m.k}</b>
                    <i class:u={m.pct >= 0} class:d={m.pct < 0}>{m.pct >= 0 ? "+" : "−"}{Math.abs(m.pct).toFixed(2)}%</i>
                  </span>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        {#if pastMacro.length}
        <div class="rx-grp">MACRO<span class="rx-sub">last 7 days</span></div>

        <!-- 이미 지난 거시 이벤트. 지난 일정을 주는 무료 소스가 없어 피드에서 볼 때마다
             직접 쌓는다 → 처음엔 비어 있고 시간이 지나며 찬다. 그 사실을 그대로 말한다. -->
        <!-- ★ 개수를 제한한다. 우측 컬럼은 실측으로 두 번 넘쳤던 곳이고, 이번에도
             실적 목록을 늘리자마자 330px 넘쳐 MACRO 가 통째로 잘려 나갔다.
             위 그룹들이 쓴 만큼을 빼고 남는 자리만 쓴다 — 잘려 나가는 것보다
             처음부터 적게 넣는 게 낫다(잘리면 화면은 아무 표시도 안 한다). -->
        {#each pastMacro.slice(0, Math.max(1, 4 - Math.min(3, reportedRows.length) - (theme ? 2 : 0))) as ev}
          <div class="rx-row past">
            <div class="rx-l">
              <div class="rx-tk">
                {ev.title}
                <!-- 예상 대비 어떻게 나왔나. 좋다/나쁘다가 아니라 방향 표기다. -->
                {#if ev.surprise === "hot"}<span class="e-res miss">HOT</span>
                {:else if ev.surprise === "cool"}<span class="e-res beat">COOL</span>
                {:else if ev.surprise === "inline"}<span class="e-res inline">IN LINE</span>{/if}
              </div>
              <div class="rx-tag">
                {#if ev.actual}<b class="mx-a">{ev.actual}</b>{#if ev.consensus}<span class="mx-c">vs {ev.consensus}</span>{/if} · {/if}{ev.note || stars(ev.imp)}
              </div>
            </div>
            <div class="rx-r">
              <div class="rx-when done">{macroAgo(ev.whenET, nowMs)}</div>
            </div>
          </div>
        {/each}

        {/if}
        <!-- ※ 예정 이벤트는 여기 넣지 않는다. UPCOMING 이 담당한다.
             예전엔 FOMC 가 UPCOMING 과 여기 양쪽에 나왔다 (같은 중복 문제).
             ※ 비었을 땐 그룹 헤더째 감춘다. "No macro release" 두 줄이 패널의 절반을
                차지하면서, 정작 진짜 드라이버가 들어갈 자리를 먹고 있었다. -->

        <!-- ※ MOVERS 그룹은 좌측 MARKET FOCUS 로 옮겼다.
             둘 다 **개별 종목** 이야기인데 화면 양끝에 떨어져 있었고, 게다가 겹쳤다 —
             실적을 방금 낸 종목은 FOCUS 에 "REPORTED 3D AGO" 로도, MOVERS 에도 떴다.
             합치니 "왜 보고 있나(촉매)" 와 "그래서 어떻게 됐나(검증된 반응)" 가 한 줄에 붙는다.
             덤으로 우측이 1080p 안에 여유 있게 들어와 지표·일정 칸을 되돌릴 수 있었다.
             MARKET DRIVER 는 이제 **시장 전체 이야기**만 담는다 — 주제와 거시 결과. -->
        <!-- 셋 다 없을 때만 빈 상태를 말한다 (드라이버가 있으면 패널은 이미 제 역할을 한다) -->
        {#if !theme && pastMacro.length === 0}
          <div class="empty">No driver data</div>
        {/if}
      </div>
    </section>
  </main>

  <!-- ===== TICKER TAPE ===== -->
  <footer class="ft">
    <!-- 고지 밴드: 지연·비매매 고지 + 소스 표기 + TradingView 어트리뷰션.
         흐르는 테이프 안에 넣으면 스크롤로 사라져 "항상 보임" 요건을 못 채우므로 고정 셀로 둔다. -->
    <div class="disc">
      <span>DELAYED / PREV CLOSE · For information only, not investment advice</span>
      <span class="disc-sep">·</span>
      <span>Data: Finnhub · Finviz · Naver · CoinGecko</span>
      <!-- TradingView 어트리뷰션은 **실제로 그 위젯을 띄웠을 때만** 표기한다.
           기본 차트는 자체 렌더라 항상 붙여두면 사실과 다르다. -->
      {#if anyTv}
        <span class="disc-sep">·</span>
        <span>Charts by <a href="https://www.tradingview.com" target="_blank" rel="noreferrer">TradingView</a></span>
      {/if}
    </div>
    <!-- 흐르는 테이프는 자체 클리핑 박스 안에 둔다. 안 그러면 translateX 애니메이션이
         고지 밴드 위로 넘어와 글자가 겹친다. -->
    <div class="tape-vp">
    <div class="track">
      {#each [...boards.tape, ...boards.tape, ...boards.tape] as t}
        <!-- ★ 정지된 값은 헤더 스트립과 **같은 방식**으로 흐리게.
             주식은 정규장에만 움직이는데(무료 티어는 확장시간 미갱신) 여기만 원색이라
             62시간 묵은 금요일 종가가 실시간과 구분되지 않았다. -->
        <span class="mq-item" class:closed={t.live === false}>
          <span class="mq-k">{t.k}</span>
          <span class="mq-v">{t.v}</span>
          <span class="mq-p" class:u={t.pct >= 0} class:d={t.pct < 0}>
            {t.pct > 0 ? "+" : ""}{Number(t.pct).toFixed(2)}%{#if t.live === false}<span class="stale-mark">·{lastSessionTag}</span>{/if}
          </span>
        </span>
        <span class="mq-sep">·</span>
      {/each}
    </div>
    </div>
  </footer>

  <!-- 배경음악: 화면엔 안 보이고 소리만 난다. 조작은 /control 에서. -->
  <MusicPlayer playing={music.playing} volume={music.volume} cmdSeq={music.cmdSeq} cmd={music.cmd} />
</div>

<style>
  :global(body) { margin: 0; background: #000; overflow: hidden; font-family: 'Inter', system-ui, sans-serif; }
  .wrap {
    width: 1920px; height: 1080px; background: #08090c; color: #f2f3f5;
    display: flex; flex-direction: column; transform-origin: top left; overflow: hidden;
    letter-spacing: -0.01em;
  }
  .u { color: #39d98a; } .d { color: #ff5c5c; }
  .pos { --accent: #39d98a; } .neg { --accent: #ff5c5c; } .neu { --accent: #6b7280; }

  /* header */
  .hd {
    height: 66px; display: flex; align-items: center; justify-content: space-between;
    padding: 0 28px; background: #0b0d11; border-bottom: 1px solid #191c22;
  }
  .hd-l { display: flex; align-items: center; gap: 18px; }
  .logo { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
  .logo span { color: #6b7280; font-weight: 500; }
  .badge {
    display: flex; align-items: center; gap: 7px;
    font-size: 12px; font-weight: 700; letter-spacing: 0.06em;
    background: #14171d; padding: 6px 11px; border-radius: 999px; color: #8a919b;
    border: 1px solid #20242b;
  }
  .badge .dot { width: 7px; height: 7px; border-radius: 50%; background: #4b5563; }
  .badge.active { color: #fff; background: #0d1712; border-color: #1d3a28; }
  .badge.active .dot { background: #39d98a; box-shadow: 0 0 8px #39d98a; animation: pulse 1.6s infinite; }
  /* 닫힘 상태: 이유(WEEKEND/HOLIDAY…)와 재개장 시각을 같이 보여 준다 */
  .badge.closed { color: #9aa3ad; }
  .badge .b-main { font-weight: 800; }
  .badge .b-why { color: #d8a860; font-weight: 800; }
  .badge .b-why::before { content: "· "; color: #4b5563; }
  .badge .b-next { color: #6b7280; font-weight: 600; letter-spacing: 0; font-variant-numeric: tabular-nums; }
  @keyframes pulse { 50% { opacity: 0.35; } }

  /* 개장/마감 임박 카운트다운 칩 */
  .bell { display: flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 800;
    letter-spacing: 0.04em; padding: 6px 12px; border-radius: 999px; font-variant-numeric: tabular-nums; }
  .bell .bell-dot { width: 7px; height: 7px; border-radius: 50%; }
  .bell.open { color: #d8a860; background: #1a140a; border: 1px solid #2e2410; }
  .bell.open .bell-dot { background: #f5a623; }
  .bell.close { color: #ff8a8a; background: #1a0d0d; border: 1px solid #3a1616; }
  .bell.close .bell-dot { background: #ff5c5c; }
  .bell.soon .bell-dot { animation: pulse 1s infinite; }
  .bell.soon { animation: pulse 1.4s infinite; }

  /* 7슬롯(지수3 + 크로스에셋4)으로 늘어 gap 을 조금 좁힌다. 좁은 폭에선 가로 스크롤 없이 줄인다. */
  /* 세션 배지 — 헤더 시세가 어느 구간의 값인지 */
  .sesh { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.15;
    padding: 3px 11px 3px 0; margin-right: 4px; border-right: 1px solid #23272f; flex-shrink: 0; }
  .sesh-k { font-size: 12px; font-weight: 800; letter-spacing: 0.06em; color: #8a919b; white-space: nowrap; }
  .sesh.live .sesh-k { color: #39d98a; }
  .sesh-s { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; color: #5b6472; text-transform: uppercase; }
  .top-strip { display: flex; gap: 20px; flex-wrap: nowrap; }
  .idx { display: flex; gap: 7px; font-size: 15px; font-weight: 600; align-items: baseline; white-space: nowrap; }
  .idx .k { color: #6b7280; font-size: 13px; letter-spacing: 0.03em; }

  .hd-r { flex-wrap: nowrap; white-space: nowrap; }
  .hd-r { display: flex; align-items: center; gap: 14px; }
  .clock { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .clock .tz { color: #6b7280; font-size: 13px; font-weight: 600; }
  .upd {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: #5b8a72;
    background: #0d1712; border: 1px solid #16281d; padding: 5px 9px; border-radius: 999px;
    font-variant-numeric: tabular-nums;
  }
  .upd .upd-dot { width: 6px; height: 6px; border-radius: 50%; background: #39d98a; }
  /* LAG — 정규장 중 2분 이상 지연 */
  .upd.stale { color: #d8a860; background: #1a140a; border-color: #2e2410; }
  .upd.stale .upd-dot { background: #f5a623; }
  /* STALE / NO DATA — 화면 값을 믿으면 안 되는 상태 */
  .upd.dead { color: #ff8a8a; background: #1a0d0d; border-color: #3a1616; }
  .upd.dead .upd-dot { background: #ff5c5c; }
  /* 장 밖 = 전일 종가인 게 정상. 경보가 아니라 사실 표기 (중립 회색) */
  .upd.prev { color: #9aa3ad; background: #12151b; border-color: #23272f; }
  .upd.prev .upd-dot { background: #6b7280; }
  .idx .v.miss { color: #6b7280; }
  /* ★ 자기 시장이 닫힌 값 — 살아 있는 값과 같은 밝기로 두면 지금 시세로 읽힌다.
       색(빨강/초록)은 유지해 방향은 계속 보이게 하고, 밝기만 낮춘다. */
  .idx .v.closed { opacity: 0.45; }
  .idx .k.closed { opacity: 0.55; }
  .stale-mark { margin-left: 3px; font-size: 9px; font-weight: 800; letter-spacing: 0.04em;
    color: #6b7280; vertical-align: 1px; }

  /* body grid: 뉴스 | 차트(주인공) | 워치리스트 */
  .grid { flex: 1; display: grid; grid-template-columns: 440px 1fr 380px; gap: 14px; padding: 14px; overflow: hidden; }
  .col { display: flex; flex-direction: column; gap: 14px; height: 100%; overflow: hidden; }

  .lbl {
    padding: 12px 16px; font-size: 12px; font-weight: 800; letter-spacing: 0.1em;
    color: #7a828d; display: flex; align-items: center; gap: 8px;
  }

  .panel { background: #0d0f13; border: 1px solid #191c22; border-radius: 12px; overflow: hidden; }

  /* driver */
  .driver {
    background: #0d0f13; border: 1px solid #191c22; border-radius: 12px;
    border-left: 4px solid var(--accent, #6b7280); overflow: hidden;
    min-height: 132px; display: flex; flex-direction: column;
    /* ★ 절대 줄어들지 않는다. 서버가 길이로 문장을 자르지 않게 되면서 헤드라인이 두세 줄이
       될 수 있는데, flex 기본값(0 1 auto)이면 아래 패널들에 밀려 눌리고 overflow:hidden 이
       두 번째 줄을 잘라 먹는다(실측: "…Fed decision looms" 가 상자 밖으로 나갔다).
       화면에서 가장 중요한 문장이 레이아웃 압력에 지는 건 말이 안 된다. */
    flex: 0 0 auto;
  }
  .driver.nodata { border-left-color: #ff5c5c; }
  .driver-meta { margin-top: 8px; display: flex; gap: 8px; align-items: baseline;
    font-size: 16px; font-weight: 800; }
  .dm-age { color: #c7cdd6; }
  .dm-src { color: #8a919b; font-weight: 700; }
  /* ★ 3줄에서 끊는다. 서버가 더 이상 길이로 문장을 자르지 않으므로(자르다 뜻이
       바뀌는 사고가 반복됐다) 길이 제어는 전적으로 여기가 맡는다. */
  .driver-txt { padding: 4px 18px 20px; font-size: 27px; font-weight: 800; line-height: 1.2;
    display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden; }
  .drv-src { font-size: 10px; font-weight: 800; color: #7d94b8; letter-spacing: 0.04em;
    background: #12181f; border: 1px solid #1c2430; padding: 1px 6px; border-radius: 4px; }
  .drv-age { margin-left: auto; font-size: 11px; font-weight: 700; color: #6b7280; letter-spacing: 0; }
  /* 판단 출처 표기 — 규칙기반은 회색, AI 판단은 파랑. 시청자가 구분할 수 있어야 한다. */
  .origin { font-size: 10px; font-weight: 800; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 4px;
    background: #14171d; border: 1px solid #23272f; color: #8a919b; }
  .origin.ai { background: #101a26; border-color: #1d3350; color: #7db0e8; }
  .conf { font-size: 10px; font-weight: 800; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; }
  .conf.high { background: #0d1712; border: 1px solid #16281d; color: #39d98a; }
  .conf.medium { background: #1a140a; border: 1px solid #2e2410; color: #d8a860; }
  .conf.low { background: #1a0d0d; border: 1px solid #3a1616; color: #ff8a8a; }
  /* 피드 정지 표시 — 정상 동작 땐 안 보이고, /api/digest·/api/calendar 실패 때만 뜬다 */
  .stale-chip { font-size: 10px; font-weight: 800; letter-spacing: 0.06em; padding: 1px 6px; border-radius: 4px;
    background: #1a140a; border: 1px solid #2e2410; color: #d8a860; }
  /* 발표 완료 — 숫자 확보 */
  .e-dd.rep { color: #39d98a; font-size: 13px; }
  /* 발표됐지만 아직 결과·반응 집계 안 됨 */
  .e-dd.pend { color: #d8a860; font-size: 13px; }
  .e-eps.pend-t { color: #d8a860; font-weight: 700; }
  /* 발표된 행은 살짝 강조 */
  .e-row.done { border-color: #23303a; background: #0e1418; }
  /* 결과 뱃지: 예상 상회/하회/부합 */
  .e-res { font-size: 11px; font-weight: 800; padding: 2px 7px; border-radius: 5px; letter-spacing: 0.02em; }
  .e-res.beat { background: #0d1712; color: #39d98a; border: 1px solid #16281d; }
  .e-res.miss { background: #1a0d0d; color: #ff8a8a; border: 1px solid #3a1616; }
  .e-res.inline { background: #14171d; color: #9aa3ad; border: 1px solid #23272f; }
  /* 시장반응: 발표 후 주가 % */
  .e-react { font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1.1;
    display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
  .e-when { font-size: 12px; color: #6b7280; font-weight: 700; text-align: right; }
  /* 발표 전 당일 등락 — '반응'이 아니라는 걸 라벨 색으로도 구분 */
  .e-when.pre-print { color: #d8a860; letter-spacing: 0.03em; }
  /* 발표 당시 스냅샷 — 라이브와 색을 달리해 헷갈리지 않게 */
  /* ===== MARKET DRIVER ===== */
  /* 지배 주제 — TOP STORY 처럼 **한 덩어리로 크게**. 목록이 아니라 결론이다. */
  .mdrv { padding: 2px 2px 12px; border-bottom: 1px solid #191c22; margin-bottom: 10px; }
  .mdrv-top { display: flex; align-items: baseline; gap: 10px; }
  .mdrv-tag { font-size: 34px; font-weight: 900; letter-spacing: 0.01em; color: #ffffff; line-height: 1.05; }
  .mdrv-lv { font-size: 15px; font-weight: 800; color: #d8a860; }
  .mdrv-lv.max { color: #ff5c5c; }
  .mdrv-note { margin-top: 6px; font-size: 14px; font-weight: 600; line-height: 1.35; color: #a9b1bc; }
  .mdrv-meta { margin-top: 5px; font-size: 12px; font-weight: 700; color: #6b7280; letter-spacing: 0.02em; }
  /* 근거 = 자산이 실제로 어떻게 반응했나. 주제 이름만으론 "그래서 시장은?" 이 안 나온다. */
  .mdrv-ev { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 4px 16px;
    font-variant-numeric: tabular-nums; }
  .mdrv-a { display: inline-flex; align-items: baseline; gap: 5px; }
  .mdrv-a b { font-size: 11px; font-weight: 800; color: #7a828d; letter-spacing: 0.04em; }
  .mdrv-a i { font-style: normal; font-size: 17px; font-weight: 800; }
  .mdrv-a i.u { color: #39d98a; }
  .mdrv-a i.d { color: #ff5c5c; }

  .rx-grp { font-size: 12px; font-weight: 800; color: #6b7280; letter-spacing: 0.1em;
    margin: 6px 0 3px; display: flex; align-items: baseline; gap: 6px; }
  .rx-grp:first-of-type { margin-top: 2px; }
  .rx-sub { font-size: 10px; font-weight: 700; color: #4b5563; letter-spacing: 0.04em; }
  .rx-row { display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 8px 11px; border: 1px solid #191c22; border-radius: 8px; background: #0b0e13;
    margin-bottom: 5px; }
  .rx-l { min-width: 0; }
  .rx-tk { font-size: 17px; font-weight: 800; color: #e8edf4; display: flex; align-items: center; gap: 5px; }
  .rx-tag { font-size: 13px; color: #8a919b; font-weight: 600; margin-top: 1px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rx-r { text-align: right; flex-shrink: 0; min-width: 78px; }
  .rx-pct { font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .rx-pct.u { color: #39d98a; }
  .rx-pct.d { color: #ff5c5c; }
  .rx-when { font-size: 11px; font-weight: 700; color: #5b6472; letter-spacing: 0.03em; white-space: nowrap; }
  .rx-when.await { color: #d8a860; }
  .rx-when.done { color: #5b6472; }
  /* US ECONOMY 의 "▲/▼ vs prev" — 값과 같은 색으로 방향을 즉시 읽히게 한다 */
  .rx-when.u { color: #39d98a; }
  .rx-when.d { color: #ff5c5c; }
  /* 시총 변화액 — 등락률과 규모를 분리해서 보여준다 */
  .rx-imp { font-size: 12px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .rx-imp.u { color: #2f9c68; } .rx-imp.d { color: #c14a4a; }
  /* 미검증 — 실시세로 확인 못 한 값. 사실처럼 보이면 안 된다. */
  .rx-pct.unv { color: #7c8494 !important; }
  .rx-when.unv { color: #7a6a3a; }
  .rx-row.past { opacity: 0.85; }
  .mx-a { color: #c7cdd6; font-weight: 800; }
  .mx-c { color: #6b7280; font-weight: 600; margin-left: 3px; }
  .rx-note { font-size: 10px; color: #4b5563; font-weight: 600; padding: 2px 2px 6px; }

  .e-when.snap { color: #5b6472; letter-spacing: 0.02em; font-size: 11px; white-space: nowrap; }
  /* 세션 분해 (close / AH / pre) — 반응 %보다 작게, 보조 정보로 */
  .e-seg { display: flex; gap: 8px; justify-content: flex-end; margin-top: 3px;
    font-size: 10.5px; color: #6b7280; font-weight: 600; font-variant-numeric: tabular-nums; }
  /* 라이브 시세임을 알리는 맥동 점 */
  .live-pip { width: 7px; height: 7px; border-radius: 50%; background: #ff3b30;
    box-shadow: 0 0 7px #ff3b30; animation: pulse 1.4s infinite; flex-shrink: 0; }

  /* TODAY — 오늘의 핵심 이벤트·뉴스 + 영향 한 줄 */
  .today { flex: 0 0 auto; }
  .td-list { padding: 0 14px 12px; display: flex; flex-direction: column; gap: 9px; }
  .td-item { border-left: 3px solid var(--accent, #6b7280); padding: 1px 0 2px 11px; }
  .td-item.pos { --accent: #39d98a; } .td-item.neg { --accent: #ff5c5c; } .td-item.neu { --accent: #6b7280; }
  .td-top { display: flex; align-items: baseline; gap: 8px; }
  .td-arrow { font-size: 11px; color: var(--accent); flex-shrink: 0; }
  .td-tit { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; min-width: 0; }
  .td-when { margin-left: auto; font-size: 13px; font-weight: 800; color: #d8a860;
    font-variant-numeric: tabular-nums; white-space: nowrap; flex-shrink: 0; }
  .td-live { margin-left: auto; font-size: 12px; font-weight: 900; color: #ff5c5c;
    letter-spacing: 0.06em; animation: pulse 1.2s infinite; white-space: nowrap; flex-shrink: 0; }
  /* 영향 문구가 길면 패널이 아래를 밀어낸다 → 두 줄까지만 */
  .td-impact { font-size: 13.5px; color: #9aa3ad; font-weight: 600; line-height: 1.35; margin-top: 2px;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

  /* news — 별점 스캔용: 태그 대신 ★, 한 줄, 공간 절약 */
  .news-list { flex: 1; overflow: hidden; padding: 4px 10px 8px; display: flex; flex-direction: column; gap: 4px; }
  .news-item {
    display: flex; align-items: baseline; gap: 10px; padding: 7px 11px; border-radius: 8px;
    text-decoration: none; color: inherit; background: #101318; border: 1px solid #191c22;
  }
  /* 90분 넘은 **낮은 중요도** 뉴스만 흐리게 (맥락이지 신호가 아니다) */
  .news-item.old { opacity: 0.45; }
  /* 중요도 4~5 — 나이와 무관하게 또렷하게. 방송에서 제일 먼저 읽혀야 할 줄이다. */
  .news-item.hi { background: #12161c; border-color: #262b34; }
  .news-item.hi .n-tit { color: #ffffff; font-weight: 700; }
  .news-item.hi .n-age { color: #8a919b; }
  /* ★ 중요도 — 텍스트 태그보다 훨씬 빨리 읽힌다 */
  .n-stars { flex-shrink: 0; font-size: 14px; font-weight: 800; color: #4b5563; line-height: 1;
    min-width: 26px; }
  .n-stars.pos { color: #39d98a; }
  .n-stars.neg { color: #ff5c5c; }
  .n-tit { flex: 1; min-width: 0; font-size: 17px; font-weight: 600; line-height: 1.25; color: #eef1f4;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .src-hint { margin-left: auto; font-size: 10px; font-weight: 600; color: #4b5563; letter-spacing: 0; }
  .n-age { flex-shrink: 0; font-size: 12px; font-weight: 700; color: #6b7280; font-variant-numeric: tabular-nums; }

  /* center: 큰 차트가 주인공 */
  .center { min-width: 0; }

  /* 1~4분할 — 슬롯 수가 곧 배치. 3개는 위 1개 + 아래 2개가 가장 읽기 좋다. */
  .chart-grid { flex: 1 1 auto; min-height: 0; display: grid; gap: 10px; }
  .chart-grid[data-n="1"] { grid-template-columns: 1fr; grid-template-rows: 1fr; }
  .chart-grid[data-n="2"] { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
  .chart-grid[data-n="3"] { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
  .chart-grid[data-n="3"] > :first-child { grid-column: 1 / -1; }
  .chart-grid[data-n="4"] { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }

  .chart-card {
    min-height: 0; min-width: 0; background: #08090c; border: 1px solid #191c22; border-radius: 12px;
    overflow: hidden; display: flex; flex-direction: column;
  }
  .chart-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 10px 14px; border-bottom: 1px solid #191c22; flex: 0 0 auto;
  }
  .ch-name { font-size: 20px; font-weight: 800; letter-spacing: -0.01em; }
  /* 대체물(ETF 프록시 등)임을 화면에서 숨기지 않는다 */
  /* Auto-Sniper 가 잡은 차트는 테두리로 구분 — 자동으로 바뀐 걸 시청자가 알아야 한다 */
  .chart-card.sniped { border-color: #7a5c12; }
  .ch-snipe { font-size: 10px; font-weight: 800; color: #f0b429; letter-spacing: 0.08em;
    background: #17140c; border: 1px solid #3d3212; padding: 3px 8px; border-radius: 999px;
    white-space: nowrap; }
  /* 상품 표기 (TradingView 경로). 자체 렌더 차트는 .fc-inst 가 같은 역할을 한다. */
  .ch-inst { font-size: 10px; font-weight: 800; color: #7d94b8; letter-spacing: 0.06em;
    background: #12181f; border: 1px solid #1c2430; padding: 1px 5px; border-radius: 4px;
    white-space: nowrap; }
  .ch-note { font-size: 10px; font-weight: 700; color: #7c6a3a; letter-spacing: 0.04em;
    background: #17140c; border: 1px solid #2b2411; padding: 3px 7px; border-radius: 999px;
    white-space: nowrap; margin-right: auto; }
  /* 기본은 중립 회색. 정규장일 때만 초록. */
  .ch-meta { font-size: 12px; font-weight: 800; color: #8a919b; letter-spacing: 0.08em;
    background: #12151b; border: 1px solid #23272f; padding: 4px 10px; border-radius: 999px; }
  .ch-meta.live { color: #39d98a; background: #0d1712; border-color: #16281d; }
  /* TradingView autosize가 높이를 잡도록 명시적 최소 높이 강제 (0-height 방지) */
  .chart-body { flex: 1 1 auto; min-height: 0; position: relative; }
  /* TradingView autosize 가 높이를 못 잡는 경우가 있어 1분할일 때만 최소 높이를 준다 */
  .chart-grid[data-n="1"] .chart-body { min-height: 320px; }
  /* 영상은 헤드라인 아래 남는 공간에 들어간다. 헤드라인은 내용만큼만 차지한다. */
  .col.left > .news { flex: 0 0 auto; }
  /* 직전 TOP STORY 이력 (영상 없을 때만) */
  .mlink { flex: 0 0 auto; }
  /* 좌측 컬럼이 넘칠 때 **가장 먼저 양보하는 패널**을 명시한다.
     TOP STORY > 헤드라인 > MARKET FOCUS > 지난 스토리 순으로 중요하므로 맨 뒤가 줄어든다.
     정하지 않으면 flex 가 알아서 나누면서 정작 중요한 상자를 눌러 버린다. */
  .mlink.stories { flex: 0 1 auto; min-height: 0; }
  .ps-list { padding: 0 16px 12px; display: flex; flex-direction: column; gap: 8px; }
  /* 경과시간을 고정폭으로 왼쪽에 세워 세 줄이 시간축처럼 읽히게 한다 */
  .ps-item { display: grid; grid-template-columns: 40px 1fr auto; gap: 10px;
    align-items: baseline; border-left: 3px solid var(--accent, #3a4150); padding-left: 10px; }
  /* 헤드라인(17px)과 같은 크기로 두되 색만 낮춘다 — 유튜브에서 4~5배 축소돼 보이므로
     "지난 것"을 작게 만들면 그냥 안 읽힌다. 위계는 굵기·색으로 준다. */
  .ps-when { font-size: 14px; font-weight: 800; color: #6b7280; font-variant-numeric: tabular-nums; }
  .ps-txt { font-size: 17px; font-weight: 600; line-height: 1.3; color: #c7cdd6;
    overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
    -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
  .ps-src { font-size: 11px; font-weight: 700; color: #565d68; letter-spacing: 0.02em; }

  /* 시장의 관심 종목 — [티커] [왜] [관심도 막대] [등락률] */
  .im-list { padding: 0 16px 7px; display: flex; flex-direction: column; gap: 10px; }
  /* ★ 실적 배지(BEAT)와 검증 라벨(VERIFIED)이 들어가면서 그 행만 27→53px 로 튀었다.
     행 높이가 들쭉날쭉하면 좌측 컬럼이 넘친다 → 칸 너비를 넉넉히 주고 줄바꿈을 막는다. */
  .im-item { display: grid; grid-template-columns: 96px 104px 1fr 92px;
    gap: 10px; align-items: center; font-variant-numeric: tabular-nums; }
  .im-tk { font-size: 19px; font-weight: 800; color: #e8edf4; letter-spacing: 0.01em;
    white-space: nowrap; display: flex; align-items: baseline; gap: 5px; }
  /* 왜 여기 있는지. 촉매(실적)는 색을 줘서 "곧 뭔가 있다"를 먼저 보이게 한다 */
  .im-why { font-size: 11px; font-weight: 800; color: #7a828d; letter-spacing: 0.04em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .im-why.cat { color: #d8a860; }
  .im-bar { height: 8px; background: #14171d; border-radius: 4px; overflow: hidden; }
  .im-fill { display: block; height: 100%; border-radius: 4px; background: #3d6ea8; opacity: 0.85; }
  .im-pct { font-size: 17px; font-weight: 800; text-align: right; }
  .im-pct.u { color: #39d98a; }
  .im-pct.d { color: #ff5c5c; }
  /* 정지된 값 — 헤더 스트립(.idx .v.closed)과 같은 투명도를 쓴다 */
  .im-pct.closed { opacity: 0.45; }
  /* 주제 행 — 티커가 없다 ("MEMORY CYCLE" 처럼 논쟁 자체가 주제이거나 비상장).
     한 줄 높이를 유지해야 한다 — 좌측 컬럼은 1080p 에 딱 맞춰져 있어 행이 커지면 넘친다.
     막대를 빼고 그 자리를 이름·설명에 준다. */
  .im-item.theme { grid-template-columns: minmax(0, max-content) 1fr 92px; }
  .im-item.theme .im-tk { font-size: 16px; letter-spacing: 0.03em; }
  .im-item.theme .im-why { color: #8a919b; letter-spacing: 0.01em; }
  .im-item.theme .im-bar { display: none; }
  /* 검증 안 된 값 — 리캡(LLM)이 준 숫자가 실제와 정반대였던 사고가 있었다 */
  .im-pct.unv { color: #a08a4a; }
  /* 등락률 + 검증 상태를 오른쪽 한 칸에 세로로 쌓는다 */
  .im-px { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.02; }
  .im-ver { font-size: 8px; font-weight: 800; letter-spacing: 0.05em; color: #5b6472; line-height: 1.2; }
  .im-ver.unv { color: #7a6a3a; }

  /* 하단 슬림 스파크라인 스트립 */
  /* ── 섹터 로테이션 스트립 ─────────────────────────
     한 줄 고정 44px. 12칸이 폭을 나눠 갖고, 색은 화면의 기존 상승/하락 색을 쓴다.
     칸마다 배경 농도를 주지 않는다 — 히트맵처럼 칠하면 1080p 에서 글자가 안 읽힌다. */
  /* ★ 62px. 44px 로 뒀더니 행에 17px 만 남아 **섹터 이름이 4px 로 뭉개져 안 보였다**
     (실측). 퍼센트만 12개 늘어선 줄은 아무 의미가 없다 — 무엇의 퍼센트인지 모른다. */
  .sect { height: 62px; flex-shrink: 0; display: flex; flex-direction: column; gap: 4px;
    padding: 4px 10px; background: #101318; border: 1px solid #1d2128; border-radius: 8px;
    font-variant-numeric: tabular-nums; overflow: hidden; }
  .sect.closed { opacity: 0.55; }
  .sect-h { display: flex; align-items: baseline; gap: 8px; }
  .sect-t { font-size: 10px; font-weight: 800; letter-spacing: 0.08em; color: #8a919b; }
  .sect-s { font-size: 9px; font-weight: 700; letter-spacing: 0.05em; color: #5b6472; }
  .sect-sp { margin-left: 8px; color: #8a919b; }
  .sect-row { display: flex; gap: 4px; flex: 1; min-height: 0; }
  .sect-c { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 1px;
    align-items: center; justify-content: center; border-radius: 4px; background: #14171d;
    padding: 2px 2px; }
  .sect-n { font-size: 9px; line-height: 1.25; font-weight: 700; letter-spacing: 0.02em; color: #7a828d;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .sect-p { font-size: 14px; font-weight: 800; line-height: 1.15; }
  .sect-c.u .sect-p { color: #39d98a; }
  .sect-c.d .sect-p { color: #ff5c5c; }

  /* ── TAPE READ ─────────────────────────────────────────
     높이 44px 고정. 어느 상태든 같은 자리를 차지해서 눈이 매번 같은 곳에 떨어진다.
     ※ 맥동(animation)은 쓰지 않는다 — 이 저장소에서 맥동은 진짜 라이브인 것
       (.badge.active .dot 등)에만 쓰는 표기이고, 이 값은 5분봉이라 틱이 아니다. */
  .tape30 { height: 44px; flex-shrink: 0; display: flex; align-items: center; gap: 0 12px;
    padding: 0 14px; background: #101318; border: 1px solid #1d2128; border-radius: 8px;
    font-variant-numeric: tabular-nums; overflow: hidden; white-space: nowrap; }
  .tape30 .t30-lab { display: flex; flex-direction: column; line-height: 1.15;
    width: 92px; flex-shrink: 0; }
  .t30-k { font-size: 11px; font-weight: 800; letter-spacing: 0.07em; color: #8a919b; }
  .t30-s { font-size: 9px; font-weight: 700; letter-spacing: 0.09em; color: #5b6472; }

  .t30-arrow { font-size: 15px; }
  .t30-sub { font-size: 18px; font-weight: 800; letter-spacing: 0.03em; color: #dfe4ea; }
  .t30-pct { font-size: 22px; font-weight: 800; }
  .t30-shape { font-size: 12px; font-weight: 800; letter-spacing: 0.04em; color: #9aa3ad; }
  .t30-give { font-size: 11px; font-weight: 700; letter-spacing: 0.03em; color: #f5a623;
    border: 1px solid #4a3a12; background: #1c1708; padding: 2px 7px; border-radius: 4px; }

  .t30-row { display: inline-flex; align-items: baseline; gap: 5px; }
  .t30-rn { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; color: #7a828d; }
  .t30-rp { font-size: 15px; font-weight: 800; }
  .t30-quiet { font-size: 11px; font-weight: 800; letter-spacing: 0.09em; color: #5b6472;
    margin-left: auto; }

  .t30-off { font-size: 18px; color: #4b5563; }
  .t30-reason { font-size: 12px; font-weight: 700; letter-spacing: 0.05em; color: #6b7280; }

  /* 움직일 때만 좌측 강조선. 색은 화면의 기존 상승/하락 색을 그대로 쓴다 */
  .tape30.t-moving { border-color: #2a2f38; box-shadow: inset 3px 0 0 0 #39d98a; }
  .tape30.t-moving:has(.t30-pct.d) { box-shadow: inset 3px 0 0 0 #ff5c5c; }
  .tape30 .u { color: #39d98a; }
  .tape30 .d { color: #ff5c5c; }
  .tape30.t-closed, .tape30.t-nodata, .tape30.t-warming { opacity: 0.72; }

  .ke-res { font-size: 9px; font-weight: 800; letter-spacing: 0.06em; padding: 1px 5px;
    border-radius: 3px; margin-left: 6px; }
  .ke-res.beat { color: #39d98a; background: #0e2a1c; border: 1px solid #1d4a33; }
  .ke-res.miss { color: #ff5c5c; background: #2a1113; border: 1px solid #4a1f22; }
  .ke-surp { font-size: 9px; font-weight: 700; color: #7a828d; margin-left: 6px; }
  .ke-res.inline { color: #8a919b; background: #14171d; border: 1px solid #23272f; }

  .spark-strip { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; height: 180px; flex-shrink: 0; }
  .ss-card { background: #0d0f13; border: 1px solid #191c22; border-radius: 10px; padding: 10px 12px 8px;
    display: flex; flex-direction: column; gap: 6px; overflow: hidden; }
  .ss-top { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
  .ss-name { font-size: 12px; font-weight: 700; color: #8a919b; letter-spacing: 0.03em; }
  /* 정지된 테이프 항목 — 헤더 스트립(.idx .v.closed)과 같은 투명도 */
  .mq-item.closed { opacity: 0.45; }
  .ss-tf { margin-left: 6px; font-size: 9px; font-weight: 800; color: #6b7280;
    border: 1px solid #2b3240; border-radius: 3px; padding: 0 3px; letter-spacing: 0.04em; }
  .ss-quote { display: flex; align-items: baseline; gap: 10px; flex-shrink: 0;
    font-variant-numeric: tabular-nums; line-height: 1.1; margin: 2px 0 4px; }
  .ss-px { font-size: 22px; font-weight: 800; color: #e8edf4; }
  .ss-abs, .ss-pct { font-size: 15px; font-weight: 800; }
  .ss-quote.u .ss-abs, .ss-quote.u .ss-pct { color: #39d98a; }
  .ss-quote.d .ss-abs, .ss-quote.d .ss-pct { color: #ff5c5c; }
  .ss-chart { flex: 1; min-height: 90px; border-radius: 6px; overflow: hidden; position: relative; }

  .keyevent {
    background: linear-gradient(180deg, #12100a, #0d0f13); border: 1px solid #2a2410; border-radius: 12px;
    padding: 16px 20px;
  }
  .ke-hdr { margin-bottom: 6px; }
  .ke-lbl { color: #f5c518; font-weight: 800; font-size: 13px; letter-spacing: 0.08em; }
  /* 그룹 라벨 — MACRO / EARNINGS 를 시각적으로 분리 */
  .ke-grp { font-size: 10px; font-weight: 800; letter-spacing: 0.12em; color: #6b7280;
    margin: 8px 0 2px; padding-top: 7px; border-top: 1px solid #2a2410; }
  .ke-hdr + .ke-grp { margin-top: 0; padding-top: 0; border-top: 0; }
  .ke-item { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 5px 0; }
  .ke-el { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .ke-tk { font-size: 19px; font-weight: 800; letter-spacing: 0.01em; }
  /* ★ 이벤트 중요도 — 한눈에 우선순위가 보인다 */
  .ke-stars { font-size: 12px; font-weight: 800; color: #f5c518; line-height: 1; flex-shrink: 0; }
  .ke-sess { font-size: 11px; font-weight: 700; color: #8a919b; letter-spacing: 0.03em; }
  .ke-tit { font-size: 21px; font-weight: 700; letter-spacing: 0.01em; }
  .ke-timer { font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; flex-shrink: 0; }
  /* 두 번째(다음의 다음) 이벤트는 위계를 낮춘다 */
  .ke-item.sub { opacity: 0.8; }
  .ke-item.sub .ke-tit { font-size: 17px; font-weight: 600; }
  .ke-item.sub .ke-timer { font-size: 16px; color: #c7cdd6; }

  /* ※ 여기 있던 .movers / .m-row / .m-tag / .m-vol / .mp / .m-pre / .sort-by (19줄) 는
        렌더되는 마크업이 하나도 없는 유령 클래스라 제거했다. movers 파이프라인 자체도 삭제됨. */

  /* 실적 캘린더 */
  .earn { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 120px; }
  /* MARKET DRIVERS 는 내용만큼만 차지한다 — EARNINGS 목록을 잡아먹으면 안 된다 */
  .react { flex: 0 0 auto; padding: 0 12px 10px; }
  .react .lbl { padding: 10px 4px 4px; }
  /* 지표 패널 — '반응'이 아니라 발표치라 별도 패널로 분리했다 */
  .econ { flex: 0 0 auto; padding: 0 12px 10px; }
  .econ .lbl { padding: 10px 4px 4px; }
  .e-list { padding: 6px 12px 10px; flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: 5px; }
  .e-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 13px; background: #101318; border: 1px solid #191c22; border-radius: 9px;
  }
  .e-row.watch { border-color: #2f4a38; background: #0e1512; }
  .e-l { min-width: 0; }
  .e-tk { font-size: 16px; font-weight: 800; display: flex; align-items: center; gap: 6px; }
  .e-star { color: #39d98a; font-size: 13px; }
  .e-sub { font-size: 11px; color: #8a919b; font-weight: 600; margin-top: 2px; display: flex; gap: 5px;
    flex-wrap: nowrap; overflow: hidden; white-space: nowrap; }
  .e-time { color: #6b7280; }
  /* 반응 %·라벨이 들어갈 폭을 확보한다. 예전엔 폭이 없어 "ON REPORT · AH" 가
     왼쪽 태그 글자 위로 겹쳐 찍혔다. */
  .e-r { text-align: right; flex-shrink: 0; min-width: 84px; margin-left: 10px; }
  .e-dd { font-size: 16px; font-weight: 800; color: #c7cdd6; font-variant-numeric: tabular-nums; }
  .e-dd.soon { color: #f5a623; }
  .e-eps { font-size: 11px; color: #6b7280; font-weight: 700; margin-top: 2px; }

  .empty { text-align: center; padding: 24px; color: #4b5563; font-weight: 600; }

  /* tape */
  .ft { height: 46px; background: #0b0d11; border-top: 1px solid #191c22; display: flex; align-items: center; overflow: hidden; }
  /* 고지 밴드 — 스크롤/애니메이션 없이 항상 보이는 자리. 대비 4.5:1 이상. */
  .disc {
    flex: 0 0 auto; display: flex; align-items: center; gap: 7px;
    padding: 0 16px 0 20px; margin-right: 4px; height: 100%;
    border-right: 1px solid #191c22;
    font-size: 13px; font-weight: 600; color: #c7cdd6; white-space: nowrap;
  }
  .disc a { color: #c7cdd6; text-decoration: none; border-bottom: 1px solid #3a4049; }
  .disc-sep { color: #4b5563; }
  .tape-vp { flex: 1 1 auto; min-width: 0; height: 100%; display: flex; align-items: center; overflow: hidden; }
  .track { display: flex; padding-left: 20px; animation: scroll 55s linear infinite; white-space: nowrap; }
  .mq-item { display: inline-flex; align-items: center; gap: 9px; font-size: 16px; font-weight: 700; }
  .mq-k { color: #8a919b; } .mq-v { color: #f2f3f5; font-variant-numeric: tabular-nums; }
  .mq-p { font-variant-numeric: tabular-nums; }
  .mq-sep { margin: 0 22px; color: #2a2e36; }
  @keyframes scroll { 100% { transform: translateX(-33.33%); } }

  /* ============================================================
     모바일 / 태블릿 (≤1200px) — 통째 축소 대신 세로 재배치.
     방송용 1920 레이아웃(.wrap, 위 규칙)은 그대로 유지됨.
     ============================================================ */
  @media (max-width: 1200px) {
    :global(body) { overflow: auto; }
  }

  .wrap.m {
    width: 100%; height: auto; min-height: 100vh;
    transform: none !important; overflow: visible;
  }

  /* 헤더: 접히고 컴팩트하게 */
  .wrap.m .hd { height: auto; flex-wrap: wrap; gap: 8px 14px; padding: 10px 14px; }
  .wrap.m .logo { font-size: 18px; }
  .wrap.m .hd-l { gap: 10px; }
  .wrap.m .top-strip {
    order: 3; width: 100%; gap: 14px; overflow-x: auto; flex-wrap: nowrap;
    padding-bottom: 4px; -webkit-overflow-scrolling: touch;
  }
  .wrap.m .top-strip::-webkit-scrollbar { display: none; }
  .wrap.m .idx { flex-shrink: 0; font-size: 14px; }
  .wrap.m .hd-r { gap: 10px; }
  .wrap.m .clock { font-size: 17px; }
  .wrap.m .upd { font-size: 10px; }

  /* 본문: 3열 → 세로 1열 (차트 먼저) */
  .wrap.m .grid {
    display: flex; flex-direction: column; gap: 12px; padding: 12px; overflow: visible;
  }
  .wrap.m .col { width: 100%; height: auto; overflow: visible; }
  .wrap.m .center { order: 1; }
  .wrap.m .left   { order: 2; }
  .wrap.m .right  { order: 3; }

  /* 차트: 모바일 고정 높이 */
  .wrap.m .chart-grid { flex: none; height: 46vh; min-height: 280px; }
  /* 폰에서 4분할은 판독 불가 → 세로로 쌓되 2열까지만 */
  .wrap.m .chart-grid[data-n="3"], .wrap.m .chart-grid[data-n="4"] { grid-template-columns: 1fr 1fr; }
  .wrap.m .chart-grid[data-n="3"] > :first-child { grid-column: 1 / -1; }
  .wrap.m .ch-name { font-size: 18px; }
  .wrap.m .spark-strip { height: 78px; }

  /* 뉴스: 전부 보이게, 글씨 읽기 좋게 */
  .wrap.m .driver { min-height: 0; }
  .wrap.m .driver-txt { font-size: 20px; padding: 4px 16px 16px; }
  .wrap.m .news { flex: none; }
  .wrap.m .news-list { overflow: visible; }
  /* 실제 폰에서 URL 을 직접 열면 헤드라인 전체를 줄바꿈으로 (잘라내지 않음) */
  .wrap.m .n-tit { font-size: 17px; white-space: normal; overflow: visible; }

  /* 실적 캘린더: 전부 보이게 */
  .wrap.m .earn { flex: none; }
  .wrap.m .e-list { overflow: visible; }

  /* 모바일에서 36px 미니차트는 판독 불가 → 숨김 (등락률은 .ss-top 에 이미 있다) */
  .wrap.m .ss-chart { display: none; }
  .wrap.m .spark-strip { height: auto; }

  /* 하단 티커: 유지 (스크롤). 고지 밴드는 줄바꿈 허용 */
  .wrap.m .ft { height: auto; flex-wrap: wrap; padding: 6px 0; }
  .wrap.m .disc { border-right: 0; white-space: normal; font-size: 12px; padding: 4px 12px; }

  /* Breaking 토스트: 화면 하단 고정 */
  .wrap.m :global(.toast) { position: fixed; bottom: 12px; left: 50%; width: calc(100% - 24px); }
  .wrap.m :global(.toast .row) { grid-template-columns: auto 1fr; }
  .wrap.m :global(.toast .imp) { display: none; }
  .wrap.m :global(.toast .msg) { font-size: 17px; white-space: normal; }
</style>
