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
  let digest = {
    driver: { text: "—", sentiment: "neu", source: "", sources: [] as any[], url: "", why: "", confidence: "", epoch: 0, origin: "none", noData: true },
    news: [] as any[]
  };
  // 직전 TOP STORY 3건. 스토리가 갈리면 이전 것은 흔적 없이 사라져서,
  // 중간에 들어온 시청자에겐 "지금까지 무슨 일이 있었나"가 통째로 없었다.
  let prevStories: any[] = [];
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
  // 이미 지난 거시 이벤트 (최근 5개, 1주일 이내). 무료 경제 캘린더가 없어 직접 쌓는다.
  let pastMacro: any[] = [];
  // 거시 지표 실제치 — **FRED(연준 원본)**. LLM 이 개입하지 않는 경로다.
  let macroReadings: any[] = [];
  let macroReleases: any[] = [];

  // ---- 속보 토스트 (단일 소유자) ----
  // 예전에는 전역 변수 1개 + writer 2개(자동/수동) + 추적되지 않는 setTimeout N개 구조라
  // 두 번째 속보가 무음·조기소멸했고, 새로고침하면 유령 속보가 사이렌과 함께 재방송됐다.
  const BREAKING_MS = 12000;
  type Toast = { seq: number; headline: string; level: number; manual: boolean; silent: boolean; ageSec: number };
  let breakingData: Toast | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let toastSeq = 0;

  let seenBreaking = new Map<string, number>(); // id → 처음 본 시각(ms). 나이 기준으로 정리한다.
  let breakingBooted = false;                   // 첫 로드 땐 밀린 뉴스 폭탄 억제
  let manualBooted = false;
  let lastManualBreakingId = 0;

  // 하단 미니차트 = **지수 선물 3종(NQ·ES·YM)**, 자체 SVG 렌더.
  //  TradingView 무료 임베드는 선물을 아예 못 그린다(실측) → 24시간 스트림에서 정작 중요한
  //  나스닥 선물 움직임을 못 보여준다. Finviz 추이로 직접 그려 그 제약을 없앴다.
  //  덤: iframe 3개가 사라져 24시간 방송의 메모리·CPU 부담도 크게 줄었다.
  let minis: {
    key: string; label: string; pct: number; price: string; abs: string | null;
    spark: number[]; base: number | null;
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
    tvSymbol: string; futKey: string; nvCode?: string; sniper?: boolean; why?: string };
  let slots: Slot[] = [{ key: "nq", label: "NASDAQ", note: "", mode: "fut",
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

  /** TOP STORY 근거 매체 목록 ("CNBC · Reuters"). 마크업에선 타입 주석을 못 쓴다 */
  $: srcNames = (digest.driver.sources ?? [])
    .map((s: any) => s?.name)
    .filter(Boolean)
    .join(" · ");

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
    breakingData = { seq: ++toastSeq, headline, level, manual, silent, ageSec };
    toastTimer = setTimeout(dismissToast, BREAKING_MS);
  }
  function dismissToast() {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    breakingData = null;
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

  async function refreshControl() {
    const j = await jget("/api/control");
    if (!j) return;
    if (j.version !== ctlVersion) {
      ctlVersion = j.version;
      if (Array.isArray(j.slots) && j.slots.length) {
        // 슬롯 구성이 바뀌면 TradingView 실패 기록을 초기화한다
        // (한 번 실패했다고 그 슬롯이 영원히 자체 렌더로 고정되면 안 된다)
        if (j.slots.map((x: any) => x.key).join() !== slots.map((x) => x.key).join()) {
          tvFailed = new Set();
        }
        slots = j.slots;
      }
      if (j.chartInterval && j.chartInterval !== chartInterval) chartInterval = j.chartInterval;
      if (j.chartStyle === "line" || j.chartStyle === "candle") chartStyle = j.chartStyle;
      // 영상 송출/내리기 (컨트롤러에서 사람이 결정)
      const v = j.video && j.video.id ? { id: j.video.id, label: j.video.label ?? "" } : null;
      if (v?.id !== video?.id) video = v;
      videoPlaying = !!j.videoPlaying;
      if (j.music) music = j.music; // 배경음악 상태 (재생/볼륨/곡이동)
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
    refresh(); refreshBreaking(); refreshControl(); refreshMacro();

    // ※ 폴링 주기는 "호출 횟수"가 아니다. refresh 1회 = 유일 티커 17개 조회다.
    //   Finnhub 무료 한도 60 req/min 안에 들어오려면 주기 15s + 서버 TTL 20s 조합이 필요하다.
    //   (예전 설정은 실측 176 req/min 으로 한도의 3배였고, 상시 429 상태였다)
    const t1 = setInterval(updateTimers, 1000);
    const t2 = setInterval(refresh, 15000);
    const t3 = setInterval(refreshBreaking, 15000);
    const t5 = setInterval(refreshControl, 1500); // 컨트롤러 반응성
    // 거시 지표는 월 단위로 갱신되는 값이라 10분이면 충분하다 (서버는 6시간 캐시)
    const t6 = setInterval(refreshMacro, 600000);
    return () => {
      window.removeEventListener("resize", resize);
      [t1, t2, t3, t5, t6].forEach(clearInterval);
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
      {#each headerLabels as k}
        {@const t = boards.top.find((x) => x.k === k)}
        <div class="idx">
          <span class="k">{k}</span>
          {#if t}
            <span class="v" class:u={t.pct >= 0} class:d={t.pct < 0}>
              {t.pct > 0 ? "+" : ""}{Number(t.pct).toFixed(2)}%
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
            {#each brief as b}
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
      {:else if prevStories.length}
        <div class="panel mlink">
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
    </section>

    <!-- CENTER: 1분봉 차트 (컨트롤러 조종) -->
    <section class="col center">
      <!-- 1~4개 차트. 슬롯 수가 곧 배치 (1=전체, 2=좌우, 3=1+2, 4=2x2) -->
      <div class="chart-grid" data-n={slots.length}>
        {#each slots as sl (sl.key)}
          <div class="chart-card" class:sniped={sl.sniper}>
            <div class="chart-head">
              <!-- 선물 모드는 차트 안의 큰 시세 표기가 이름을 담당한다 (중복 방지) -->
              <span class="ch-name">{sl.mode === "tv" ? sl.label : ""}</span>
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
                <!-- 지수 원본. 현지 거래소 세션이라 미국 시계로 LIVE 를 주장하지 않는다. -->
                <span class="ch-meta">INDEX</span>
              {:else}
                <span class="ch-meta" class:live={isMarketOpen}>
                  {IV_LABEL[chartInterval] ?? chartInterval} · {marketMsg}
                </span>
              {/if}
            </div>
            <div class="chart-body">
              {#if sl.mode === "tv" && tvFailed.has(sl.key) && (sl.futKey || sl.nvCode)}
                <!-- TradingView 가 안 뜬 슬롯 → 자체 렌더로 대체.
                     빈 화면보다 5분봉이라도 나오는 편이 낫다. -->
                <FuturesChart src={sl.futKey ? "finviz" : "naver"}
                              symbol={sl.futKey || sl.nvCode || ""} tf={futTf} name={sl.label}
                              compact={slots.length > 2} style={chartStyle} />
              {:else if sl.mode === "nv"}
                <FuturesChart src="naver" symbol={sl.nvCode ?? ""} tf={futTf} name={sl.label}
                              compact={slots.length > 2} style={chartStyle} />
              {:else if sl.mode === "fut"}
                <!-- 임시 슬롯(fv:)은 라벨이 심볼코드("SB")뿐이라 이름을 넘기지 않는다.
                     그러면 차트가 소스가 준 진짜 이름("Sugar")을 쓴다. -->
                <FuturesChart symbol={sl.futKey} tf={futTf}
                              name={sl.key.startsWith("fv:") ? "" : sl.label}
                              compact={slots.length > 2} style={chartStyle}
                              why={sl.why ?? ""} />
              {:else}
                <TVChart symbol={sl.tvSymbol} interval={chartInterval}
                         on:fail={() => { tvFailed = new Set([...tvFailed, sl.key]); }} />
              {/if}
            </div>
          </div>
        {/each}
      </div>

      <div class="spark-strip">
        {#each minis as m (m.key)}
          <div class="ss-card">
            <div class="ss-top">
              <span class="ss-name">{m.label}</span>
              <!-- 어느 구간의 차트인지 명시 — 등락률과 창이 다르면 시청자가 오해한다 -->
              <span class="ss-tf">24H</span>
            </div>
            <!-- 시세는 별도 줄에 크게. 포인트 등락을 %와 나란히 둔다. -->
            <div class="ss-quote" class:u={m.pct >= 0} class:d={m.pct < 0}>
              <span class="ss-px">{m.price}</span>
              {#if m.abs}<span class="ss-abs">{m.pct >= 0 ? "+" : "−"}{m.abs}</span>{/if}
              <span class="ss-pct">{m.pct >= 0 ? "+" : "−"}{Math.abs(m.pct).toFixed(2)}%</span>
            </div>
            <!-- 자체 SVG — 선물도 그릴 수 있고 iframe 이 아니라 가볍다 -->
            <div class="ss-chart">
              <Sparkline points={m.spark} up={m.pct >= 0} base={m.base} />
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
          {#each earningsEvents as ev (ev.ticker + ev.time.getTime())}
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

        {#if !macroEvents.length && !earningsEvents.length && !macroReleases.length}
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
          {#each macroReadings.slice(0, 4) as m}
            {@const hotter = m.prev != null && m.value != null && m.value > m.prev}
            <div class="rx-row">
              <div class="rx-l">
                <div class="rx-tk">{m.label}</div>
                <div class="rx-tag">{m.period}{m.prev != null ? ` · prev ${m.prev}` : ""}</div>
              </div>
              <div class="rx-r">
                <div class="rx-pct"
                     class:u={m.upIsHawkish ? !hotter : hotter}
                     class:d={m.upIsHawkish ? hotter : !hotter}>
                  {m.value ?? "—"}{m.unit.startsWith("%") ? "%" : m.unit}
                </div>
                <div class="rx-when">{m.prev == null ? "" : hotter ? "▲ vs prev" : "▼ vs prev"}</div>
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
        <div class="lbl">⚡ MARKET DRIVERS<span class="src-hint">what moved it</span></div>

        <div class="rx-grp">MACRO<span class="rx-sub">last 7 days</span></div>

        <!-- 이미 지난 거시 이벤트. 지난 일정을 주는 무료 소스가 없어 피드에서 볼 때마다
             직접 쌓는다 → 처음엔 비어 있고 시간이 지나며 찬다. 그 사실을 그대로 말한다. -->
        {#each pastMacro as ev}
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

        <!-- ※ 예정 이벤트는 여기 넣지 않는다. UPCOMING 이 담당한다.
             예전엔 FOMC 가 UPCOMING 과 여기 양쪽에 나왔다 (같은 중복 문제). -->
        {#if pastMacro.length === 0}
          <div class="rx-note">No macro release in the last 7 days.</div>
        {/if}

        <div class="rx-grp">MOVERS<span class="rx-sub">post-earnings · recent first</span></div>
        {#each reactions.slice(0, 4) as r}
          <div class="rx-row">
            <div class="rx-l">
              <div class="rx-tk">
                {r.ticker}
                {#if r.result === "beat"}<span class="e-res beat">BEAT</span>
                {:else if r.result === "miss"}<span class="e-res miss">MISS</span>
                {:else if r.result === "inline"}<span class="e-res inline">IN LINE</span>{/if}
              </div>
              {#if r.tag}<div class="rx-tag">{r.tag}</div>{/if}
            </div>
            <div class="rx-r">
              <!-- ★ 검증 여부를 숨기지 않는다.
                   리캡(LLM)이 준 숫자가 실제와 정반대였던 사고가 있었다
                   (INTC: 리캡 "+3.4%" vs 실제 −7.89%). 실시세로 확인된 값만
                   평상 표기하고, 확인 못 한 값은 "~" 와 흐린 색으로 구분한다. -->
              <div class="rx-pct" class:u={r.pct >= 0} class:d={r.pct < 0} class:unv={!r.verified}>
                {#if r.live}<span class="live-pip"></span>{/if}{r.pct > 0 ? "+" : "−"}{Math.abs(r.pct).toFixed(1)}%
              </div>
              <!-- ★ 등락률만으로는 "시장을 움직인 종목"을 못 가린다.
                   GOOGL −6% 가 TSLA −14.5% 보다 시장에 더 큰 사건이다(시총이 3배).
                   시총 변화액을 같이 띄워 규모를 분리한다. -->
              {#if r.impactB != null}
                <div class="rx-imp" class:u={r.impactB >= 0} class:d={r.impactB < 0}>
                  {r.impactB >= 0 ? "+" : "−"}${Math.abs(r.impactB) >= 1000
                    ? (Math.abs(r.impactB) / 1000).toFixed(1) + "T"
                    : Math.abs(r.impactB) + "B"}
                </div>
              {/if}
              <div class="rx-when" class:unv={!r.verified}>
                {r.live ? "LIVE" : r.verified ? "VERIFIED" : "UNVERIFIED"}
              </div>
            </div>
          </div>
        {/each}
        {#if reactions.length === 0}
          <div class="empty">No reaction data</div>
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
        <span class="mq-item">
          <span class="mq-k">{t.k}</span>
          <span class="mq-v">{t.v}</span>
          <span class="mq-p" class:u={t.pct >= 0} class:d={t.pct < 0}>
            {t.pct > 0 ? "+" : ""}{Number(t.pct).toFixed(2)}%
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
  }
  .driver.nodata { border-left-color: #ff5c5c; }
  .driver-meta { margin-top: 8px; display: flex; gap: 8px; align-items: baseline;
    font-size: 16px; font-weight: 800; }
  .dm-age { color: #c7cdd6; }
  .dm-src { color: #8a919b; font-weight: 700; }
  .driver-txt { padding: 4px 18px 20px; font-size: 27px; font-weight: 800; line-height: 1.2; }
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
  /* ===== MARKET DRIVERS ===== */
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
  .td-impact { font-size: 13.5px; color: #9aa3ad; font-weight: 600; line-height: 1.35; margin-top: 2px; }

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

  /* 하단 슬림 스파크라인 스트립 */
  .spark-strip { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; height: 180px; flex-shrink: 0; }
  .ss-card { background: #0d0f13; border: 1px solid #191c22; border-radius: 10px; padding: 10px 12px 8px;
    display: flex; flex-direction: column; gap: 6px; overflow: hidden; }
  .ss-top { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
  .ss-name { font-size: 12px; font-weight: 700; color: #8a919b; letter-spacing: 0.03em; }
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
