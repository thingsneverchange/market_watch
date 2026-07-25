<script lang="ts">
  import "$lib/css/global.css";
  import BreakingToast from "$lib/components/BreakingToast.svelte";
  import TVChart from "$lib/components/TVChart.svelte";
  import MusicPlayer from "$lib/components/MusicPlayer.svelte";
  import { marketState, marketBell, type MarketBell } from "$lib/market-hours";
  import { onMount } from "svelte";

  // ---- 상태 ----
  let etNow = "";
  let marketMsg = "LOADING";
  let isMarketOpen = false;
  let marketSession = "CLOSED";
  let bell: MarketBell = { kind: null, ms: 0 }; // 개장/마감 임박 카운트다운

  // 헤더 상단 스트립은 응답 배열이 아니라 **고정 라벨 목록** 기준으로 그린다.
  // 예전에는 티커가 죽으면 배열에서 조용히 빠져 자리째 사라지고 나머지가 왼쪽으로 밀렸다.
  // ★ 개별 대형주(NVDA/AAPL/MSFT) 대신 크로스에셋으로 다양화 — 지수(주식) + 반도체 + 크립토 + 원자재.
  //   지수 3종은 Finnhub(장 밖엔 전일 종가), SOXX/BTC/GOLD/OIL 은 Yahoo(밤·주말에도 라이브).
  const INDEX_LABELS = ["S&P 500", "NASDAQ 100", "DOW", "SOXX", "BTC", "GOLD", "OIL"];

  let boards = { top: [] as any[], tape: [] as any[], dataAsOf: null as number | null, missing: [] as string[] };
  let digest = {
    driver: { text: "—", sentiment: "neu", source: "", url: "", why: "", confidence: "", epoch: 0, origin: "none", noData: true },
    news: [] as any[]
  };
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

  // 하단 미니차트 = 주요 지수 3종(DOW·S&P 500·러셀2000). 큰 중앙차트가 NASDAQ 을 담당하므로
  // 나머지 미국 대표지수를 여기서 보여 준다. (NYSE 종합지수는 무료 임베드 미렌더라 러셀2000 로 대체)
  // ※ 차트 tv 심볼과 옆 % 의 label(boards.top key)을 맞춘다. ETF 프록시는 무료 임베드에서 렌더된다.
  const MINI_CHARTS = [
    { label: "DOW",          tv: "AMEX:DIA" },
    { label: "S&P 500",      tv: "AMEX:SPY" },
    { label: "RUSSELL 2000", tv: "AMEX:IWM" }
  ];

  // 데이터 신선도 — "내가 fetch 한 시각"이 아니라 "소스가 준 마지막 체결 시각"
  let dataAsOf: number | null = null;
  let firstLoadDone = false;
  let freshness: { cls: string; text: string } = { cls: "", text: "…" };

  const IV_LABEL: Record<string, string> = { "1": "1분", "5": "5분", "15": "15분", "60": "1시간", "D": "일봉" };
  // 화면 표기용 한국어 매핑 (템플릿의 {@const} 는 타입 주석을 못 쓰므로 여기 둔다)
  const CONF_LABEL: Record<string, string> = { high: "확실", medium: "보통", low: "불확실" };
  const WHEN_LABEL: Record<string, string> = { PRE: "장전", AH: "시간외", LIVE: "실시간" };

  // 차트 배지 세션 문구 — marketState() 는 순수 NYSE 시계라서 크로스에셋엔 거짓말을 한다.
  //   BTC 차트(BINANCE:BTCUSDT)는 주말에도 실시간인데 "WEEKEND" 라고 찍혔다.
  //   · 크립토 → 24/7 (항상 라이브)
  //   · 현물 금속/FX/원자재(OANDA:XAU / TVC:GOLD·USOIL 등) → NYSE 세션을 주장하지 않는다(중립 "SPOT")
  //   · 그 외(지수 추종 ETF: QQQ/SPY/DIA/SOXX/IWM/KORU) → 기존 NYSE 세션 그대로
  function chartSession(sym: string): { label: string; live: boolean } | null {
    const s = (sym || "").toUpperCase();
    if (/BTC|ETH|CRYPTO|BINANCE|COINBASE|BITSTAMP|USDT|DOGE|:SOL|:XRP/.test(s)) return { label: "24시간", live: true };
    if (/OANDA:|TVC:|FX_IDC|FOREXCOM|XAU|XAG|USOIL|UKOIL|WTI|BRENT|CRUDE/.test(s)) return { label: "현물", live: false };
    return null; // 지수 ETF → 기존 NYSE 세션 사용
  }
  $: chartSess = chartSession(chartSymbol);

  // 방송 컨트롤 (컨트롤러가 조종 → 오버레이가 폴링 반영)
  let chartSymbol = "NASDAQ:QQQ";
  let chartInterval = "1";
  let chartLabel = "NASDAQ 100";
  let ctlVersion = 0;

  let scale = 1;

  function updateTimers() {
    const now = new Date();
    nowMs = now.getTime(); // 뉴스 나이 재계산용 (정지된 헤드라인도 매초 늙는다)
    etNow = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true
    }).format(now);

    // 휴장일·조기폐장까지 아는 공용 시장시계. 예전에는 이 로직이 서버/클라에 복붙돼 있었고
    // 휴장일 처리가 없어 추수감사절·크리스마스에도 "MARKET OPEN" 이 켜졌다.
    const s = marketState(now);
    isMarketOpen = s.open;
    marketMsg = s.msg;
    marketSession = s.session;
    bell = marketBell(now); // 개장/마감 임박 (실측 시장시계 파생 — 하드코딩·DST·조기폐장 모두 반영)

    freshness = computeFreshness(s.open);
    // 이벤트 카운트다운은 템플릿에서 countdown(ev.time, …, nowMs) 로 매초 재계산된다.
  }

  /** ET 시:분 표기 ("10:00 ET") — TODAY 브리핑의 예정 이벤트용 */
  function etClock(ms: number): string {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false
    }).format(new Date(ms)) + " ET";
  }

  /** 개장/마감 임박 카운트다운 mm:ss */
  function bellText(ms: number): string {
    const t = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  }

  /** 이벤트까지 남은 시간. 추정 시각이면 분 단위 정밀 카운트다운을 주장하지 않는다. */
  function countdown(t: Date, estimated: boolean, now: number): string {
    const diff = t.getTime() - now;
    if (diff <= -60000) return "종료";
    if (diff <= 0) return "지금";
    const d = Math.floor(diff / 864e5);
    const h = Math.floor((diff % 864e5) / 36e5);
    const m = Math.floor((diff % 36e5) / 6e4);
    if (estimated) return d > 0 ? `약 ${d}일 후` : `약 ${h}시간 후`;
    return d > 0 ? `${d}일 ${h}시간 후` : `${h}시간 ${m}분 후`;
  }

  /**
   * 신선도 판정은 세션 인지형이어야 한다.
   * "15분 넘으면 빨강" 같은 절대 임계값은 주말·장마감 내내 참이라 경보 피로만 만든다.
   */
  function computeFreshness(open: boolean): { cls: string; text: string } {
    if (!firstLoadDone) return { cls: "", text: "…" };
    if (dataAsOf == null) return { cls: "dead", text: "데이터 없음" };

    const ageMin = (Date.now() - dataAsOf) / 60000;
    const t = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).format(new Date(dataAsOf));

    if (open) {
      if (ageMin > 15) return { cls: "dead", text: `지연 ${t} ET` };
      if (ageMin > 2) return { cls: "stale", text: `${t} ET (지연)` };
      return { cls: "", text: `${t} ET` };
    }
    // 장 밖에서는 전일 종가인 게 정상이다 — 경보가 아니라 사실을 표기한다.
    return { cls: "prev", text: `전일종가 ${t} ET` };
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
  async function refreshControl() {
    const j = await jget("/api/control");
    if (!j) return;
    if (j.version !== ctlVersion) {
      ctlVersion = j.version;
      if (j.tvSymbol && j.tvSymbol !== chartSymbol) chartSymbol = j.tvSymbol;
      if (j.chartInterval && j.chartInterval !== chartInterval) chartInterval = j.chartInterval;
      if (j.chartLabel) chartLabel = j.chartLabel;
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
    if (m < 1) return "방금";
    if (m < 60) return `${Math.round(m)}분 전`;
    if (m < 60 * 48) return `${Math.round(m / 60)}시간 전`;
    return `${Math.round(m / 1440)}일 전`;
  }

  onMount(() => {
    resize();
    window.addEventListener("resize", resize);
    refresh(); refreshBreaking(); refreshControl();

    // ※ 폴링 주기는 "호출 횟수"가 아니다. refresh 1회 = 유일 티커 17개 조회다.
    //   Finnhub 무료 한도 60 req/min 안에 들어오려면 주기 15s + 서버 TTL 20s 조합이 필요하다.
    //   (예전 설정은 실측 176 req/min 으로 한도의 3배였고, 상시 429 상태였다)
    const t1 = setInterval(updateTimers, 1000);
    const t2 = setInterval(refresh, 15000);
    const t3 = setInterval(refreshBreaking, 15000);
    const t5 = setInterval(refreshControl, 1500); // 컨트롤러 반응성
    return () => {
      window.removeEventListener("resize", resize);
      [t1, t2, t3, t5].forEach(clearInterval);
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
      <div class="badge" class:active={isMarketOpen}>
        <span class="dot"></span>{marketMsg}
      </div>
      <!-- 개장/마감 임박 카운트다운 (마지막 1시간에만, 마지막 5분엔 맥동) -->
      {#if bell.kind}
        <div class="bell {bell.kind}" class:soon={bell.ms <= 300000}>
          <span class="bell-dot"></span>{bell.kind === "open" ? "개장까지" : "마감까지"} {bellText(bell.ms)}
        </div>
      {/if}
    </div>
    <!-- 고정 슬롯 렌더: 티커가 죽어도 자리가 남고 "—" 로 결측을 드러낸다 -->
    <div class="top-strip">
      {#each INDEX_LABELS as k}
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
      <div class="clock">{etNow} <span class="et">ET</span></div>
      <!-- 항상 렌더한다. 예전에는 첫 요청이 실패하면 배지가 DOM 에 아예 생기지 않아
           오프라인 콜드스타트가 "조용한 장"처럼 보였다. -->
      <div class="upd {freshness.cls}" title="시세 기준 시각 (소스가 준 마지막 체결)">
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
          지금 시장
          {#if digest.driver.origin === "ai" && digest.driver.confidence}
            <span class="conf {digest.driver.confidence}">{CONF_LABEL[digest.driver.confidence] ?? digest.driver.confidence}</span>
          {/if}
          {#if digestStale}<span class="stale-chip" title="뉴스 피드 응답 없음 — 마지막 값 표시 중">갱신 중단</span>{/if}
        </div>
        <div class="driver-txt">{digest.driver.text}</div>
      </div>

      <!-- TODAY: 오늘 시장의 핵심 이벤트·뉴스 + 각각의 영향 한 줄.
           예정 이벤트는 시작시각으로 카운트다운/LIVE NOW 를 여기(클라이언트)서 계산한다. -->
      {#if brief.length}
        <div class="panel today">
          <div class="lbl">오늘의 이슈<span class="src-hint">이벤트 · 영향</span></div>
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
                    <span class="td-live">● 진행중</span>
                  {:else if Number.isFinite(st) && st > nowMs}
                    <span class="td-when">{b.estimated ? "약 " : ""}{etClock(st)}</span>
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
          마켓 헤드라인
          <span class="src-hint">최신 · 중요도순</span>
        </div>
        <div class="news-list">
          {#each digest.news as n}
            {@const ageM = n.epoch ? (nowMs / 1000 - n.epoch) / 60 : 0}
            {@const s = sent(n.sentiment)}
            <!-- 트레이더 스캔: [임팩트레일] [주체칩 ▲/▾] 한 줄 헤드라인 … [출처·나이]. 90분↑은 흐리게. -->
            <a class="news-item {s}" class:old={ageM > 90} href={n.url} target="_blank" rel="noreferrer" title={n.title}>
              <span class="n-rail" class:l5={n.level >= 5} class:l4={n.level === 4}></span>
              <span class="n-topic {s}">
                <span class="n-arrow">{s === "pos" ? "▲" : s === "neg" ? "▾" : "•"}</span>{n.topic ?? "MKT"}
              </span>
              <span class="n-tit">{n.short ?? n.title}</span>
              <span class="n-right">
                {#if n.source}<span class="n-src">{n.source}</span>{/if}
                {#if n.epoch}<span class="n-age">{ago(n.epoch, nowMs)}</span>{/if}
              </span>
            </a>
          {/each}
          {#if digest.news.length === 0}
            <div class="empty">헤드라인 없음</div>
          {/if}
        </div>
      </div>
    </section>

    <!-- CENTER: 1분봉 차트 (컨트롤러 조종) -->
    <section class="col center">
      <div class="chart-card">
        <div class="chart-head">
          <span class="ch-name">{chartLabel}</span>
          <!-- 예전 표기는 두 가지를 동시에 거짓말했다: 1분봉을 "1M"(=월봉)으로 찍었고,
               주말·휴장·차트 실패를 불문하고 초록 "LIVE" 를 박았다. -->
          <span class="ch-meta" class:live={chartSess ? chartSess.live : isMarketOpen}>
            {IV_LABEL[chartInterval] ?? chartInterval} · {chartSess ? chartSess.label : marketMsg}
          </span>
        </div>
        <div class="chart-body">
          <TVChart symbol={chartSymbol} interval={chartInterval} />
        </div>
      </div>

      <div class="spark-strip">
        {#each MINI_CHARTS as mc}
          {@const top = boards.top.find((x) => x.k === mc.label)}
          <div class="ss-card">
            <div class="ss-top">
              <span class="ss-name">{mc.label}</span>
              {#if top}
                <span class="ss-pct" class:u={top.pct >= 0} class:d={top.pct < 0}>
                  {top.pct > 0 ? "+" : ""}{Number(top.pct).toFixed(2)}%
                </span>
              {/if}
            </div>
            <!-- 314x137px 슬롯에 풀 차팅 엔진을 3개 더 띄울 이유가 없다 → 경량 위젯 -->
            <div class="ss-chart"><TVChart symbol={mc.tv} mini={true} variant="mini" /></div>
          </div>
        {/each}
      </div>
    </section>

    <!-- RIGHT: key event + watchlist -->
    <section class="col right">
      <div class="keyevent">
        <div class="ke-hdr"><span class="ke-lbl">◇ 예정</span></div>

        <!-- 거시/정책 일정 — FOMC·CPI 등. 시장 전체를 움직인다. -->
        {#if macroEvents.length}
          <div class="ke-grp">거시 · 정책</div>
          {#each macroEvents as ev (ev.title)}
            <div class="ke-item">
              <div class="ke-tit">{ev.title}</div>
              <div class="ke-timer">{countdown(ev.time, ev.estimated, nowMs)}</div>
            </div>
          {/each}
        {/if}

        <!-- 개별 종목 실적 — 종목/섹터를 움직인다. 세션(장전/장후)까지 표기. -->
        {#if earningsEvents.length}
          <div class="ke-grp">실적 발표</div>
          {#each earningsEvents as ev (ev.ticker + ev.time.getTime())}
            <div class="ke-item sub">
              <div class="ke-el">
                <span class="ke-tk">{ev.ticker}{#if ev.watch}<span class="ke-star">★</span>{/if}</span>
                <span class="ke-sess">{ev.session}</span>
              </div>
              <div class="ke-timer">{countdown(ev.time, ev.estimated, nowMs)}</div>
            </div>
          {/each}
        {/if}

        {#if !macroEvents.length && !earningsEvents.length}
          <div class="ke-item"><div class="ke-tit">—</div></div>
        {/if}
      </div>

      <div class="panel earn">
        <div class="lbl">📅 실적 캘린더
          {#if calendarStale}<span class="stale-chip" title="캘린더 피드 응답 없음 — 마지막 값 표시 중">갱신 중단</span>{/if}
          <span class="src-hint">최근 발표순</span></div>
        <div class="e-list">
          {#each upcoming as e}
            <!-- 발표된 종목(결과+반응)을 위로, 예정을 아래로. 설명 문구는 없다. -->
            <div class="e-row" class:watch={e.watch} class:done={e.status !== "upcoming"}>
              <div class="e-l">
                <div class="e-tk">
                  {e.ticker}
                  {#if e.watch}<span class="e-star">★</span>{/if}
                  {#if e.result === "beat"}<span class="e-res beat">상회</span>
                  {:else if e.result === "miss"}<span class="e-res miss">하회</span>
                  {:else if e.result === "inline"}<span class="e-res inline">부합</span>{/if}
                </div>
                <div class="e-sub">
                  <span>{e.dateET}</span>
                  <span>{e.status === "reported" || e.status === "pending" ? "발표" : "· " + e.session}</span>
                  {#if e.tag}<span>· {e.tag}</span>{/if}
                </div>
              </div>
              <div class="e-r">
                {#if e.reactionPct != null}
                  <!-- 두 국면을 라벨로 구분한다:
                       · reaction = 발표 후 반응 (PRE/AH/LIVE)
                       · pre      = 오늘 발표 예정 종목의 '발표 전 당일 등락' → INTO PRINT -->
                  <div class="e-react" class:u={e.reactionPct >= 0} class:d={e.reactionPct < 0}>
                    {#if e.reactionLive}<span class="live-pip"></span>{/if}{e.reactionPct > 0 ? "+" : ""}{e.reactionPct.toFixed(1)}%
                  </div>
                  {#if e.movePhase === "pre"}
                    <div class="e-when pre-print">발표 앞두고</div>
                  {:else if e.reactionWhen}
                    <div class="e-when">{WHEN_LABEL[e.reactionWhen] ?? e.reactionWhen}</div>
                  {/if}
                {:else if e.status === "reported"}
                  <div class="e-dd rep">발표완료</div>
                  {#if e.epsActual != null}
                    <div class="e-eps"><b>${Number(e.epsActual).toFixed(2)}</b></div>
                  {/if}
                {:else if e.status === "pending"}
                  <!-- 발표됐지만 결과·반응이 아직 집계 안 됨. 공백을 공백이라 말한다. -->
                  <div class="e-dd pend">발표완료</div>
                  <div class="e-eps pend-t">집계중</div>
                {:else}
                  <div class="e-dd" class:soon={e.dday <= 1}>
                    {e.dday <= 0 ? "오늘" : "D-" + e.dday}
                  </div>
                {/if}
              </div>
            </div>
          {/each}
          {#if upcoming.length === 0}
            <div class="empty">최근 실적 없음</div>
          {/if}
        </div>
      </div>
    </section>
  </main>

  <!-- ===== TICKER TAPE ===== -->
  <footer class="ft">
    <!-- 고지 밴드: 지연·비매매 고지 + 소스 표기 + TradingView 어트리뷰션.
         흐르는 테이프 안에 넣으면 스크롤로 사라져 "항상 보임" 요건을 못 채우므로 고정 셀로 둔다. -->
    <div class="disc">
      <span>지연 시세 · 정보 제공 목적이며 투자 권유가 아닙니다</span>
      <span class="disc-sep">·</span>
      <span>데이터: Finnhub &amp; Yahoo</span>
      <span class="disc-sep">·</span>
      <span>차트: <a href="https://www.tradingview.com" target="_blank" rel="noreferrer">TradingView</a></span>
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

  <!-- 배경음악 (YouTube 재생목록). 좌하단 컴팩트 플레이어. -->
  <MusicPlayer />
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
  .badge.active { color: #fff; background: #1a0f10; border-color: #3a1416; }
  .badge.active .dot { background: #ff3b30; box-shadow: 0 0 8px #ff3b30; animation: pulse 1.6s infinite; }
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
  .top-strip { display: flex; gap: 20px; flex-wrap: nowrap; }
  .idx { display: flex; gap: 7px; font-size: 15px; font-weight: 600; align-items: baseline; white-space: nowrap; }
  .idx .k { color: #6b7280; font-size: 13px; letter-spacing: 0.03em; }

  .hd-r { display: flex; align-items: center; gap: 14px; }
  .clock { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .clock .et { color: #6b7280; font-size: 13px; font-weight: 600; }
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
  .e-when { font-size: 11px; color: #6b7280; font-weight: 700; text-align: right; }
  /* 발표 전 당일 등락 — '반응'이 아니라는 걸 라벨 색으로도 구분 */
  .e-when.pre-print { color: #d8a860; letter-spacing: 0.03em; }
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

  /* news — 트레이더 스캔용: 주체 먼저 · 한 줄 · 오래된 건 흐리게 */
  .news { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  /* ★ YouTube 폰 축소(4~5배)에서도 읽히도록 텍스트를 키운다. 4건만 크게. */
  .news-list { flex: 1; overflow: hidden; padding: 6px 10px 10px; display: flex; flex-direction: column; gap: 7px; }
  .news-item {
    display: flex; align-items: flex-start; gap: 11px; padding: 12px 13px; border-radius: 10px;
    text-decoration: none; color: inherit; background: #101318; border: 1px solid #191c22;
  }
  .news-item.old { opacity: 0.5; } /* 90분 넘은 뉴스는 신호가 아니라 맥락 → 흐리게 */
  .n-rail { width: 4px; align-self: stretch; border-radius: 3px; background: var(--accent, #6b7280); flex-shrink: 0; }
  .n-rail.l5 { background: #ff3b30; box-shadow: 0 0 8px rgba(255,59,48,.6); }
  .n-rail.l4 { background: #f5a623; }
  /* 주체 칩 — 티커/토픽 + 방향 화살표. 눈이 가장 먼저 닿는 곳. */
  .n-topic { flex-shrink: 0; display: inline-flex; align-items: center; gap: 5px; min-width: 66px;
    font-size: 15px; font-weight: 800; letter-spacing: 0.02em; padding: 4px 9px; border-radius: 7px;
    background: #14171d; border: 1px solid #23272f; color: #c7cdd6; }
  .n-topic.pos { color: #39d98a; border-color: #16281d; background: #0d1712; }
  .n-topic.neg { color: #ff6b6b; border-color: #3a1616; background: #1a0d0d; }
  .n-arrow { font-size: 11px; opacity: 0.95; }
  /* 잘라내지 않는다 — 헤드라인 전체를 줄바꿈으로 보여 준다 ("…" 금지). 4건이라 자리는 충분. */
  .n-tit { flex: 1; min-width: 0; font-size: 19px; font-weight: 600; line-height: 1.28; color: #eef1f4;
    white-space: normal; overflow: visible; padding-top: 1px; }
  .n-right { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 0; line-height: 1.15; }
  .n-src { font-size: 10px; font-weight: 700; color: #5b6472; text-transform: uppercase; letter-spacing: 0.03em; }
  .src-hint { margin-left: auto; font-size: 10px; font-weight: 600; color: #4b5563; letter-spacing: 0; }
  .n-age { font-size: 14px; font-weight: 800; color: #99a1ab; font-variant-numeric: tabular-nums; }

  /* center: 큰 차트가 주인공 */
  .center { min-width: 0; }
  .chart-card {
    flex: 1 1 auto; min-height: 0; background: #08090c; border: 1px solid #191c22; border-radius: 12px;
    overflow: hidden; display: flex; flex-direction: column;
  }
  .chart-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 18px; border-bottom: 1px solid #191c22; flex: 0 0 auto;
  }
  .ch-name { font-size: 20px; font-weight: 800; letter-spacing: -0.01em; }
  /* 기본은 중립 회색. 정규장일 때만 초록. */
  .ch-meta { font-size: 12px; font-weight: 800; color: #8a919b; letter-spacing: 0.08em;
    background: #12151b; border: 1px solid #23272f; padding: 4px 10px; border-radius: 999px; }
  .ch-meta.live { color: #39d98a; background: #0d1712; border-color: #16281d; }
  /* TradingView autosize가 높이를 잡도록 명시적 최소 높이 강제 (0-height 방지) */
  .chart-body { flex: 1 1 auto; min-height: 320px; position: relative; }

  /* 하단 슬림 스파크라인 스트립 */
  .spark-strip { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; height: 180px; flex-shrink: 0; }
  .ss-card { background: #0d0f13; border: 1px solid #191c22; border-radius: 10px; padding: 10px 12px 8px;
    display: flex; flex-direction: column; gap: 6px; overflow: hidden; }
  .ss-top { display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
  .ss-name { font-size: 12px; font-weight: 700; color: #8a919b; letter-spacing: 0.03em; }
  .ss-pct { font-size: 13px; font-weight: 800; font-variant-numeric: tabular-nums; }
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
  .ke-star { color: #39d98a; font-size: 12px; margin-left: 3px; }
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
  .earn { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .e-list { padding: 8px 12px 12px; flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: 7px; }
  .e-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 15px; background: #101318; border: 1px solid #191c22; border-radius: 10px;
  }
  .e-row.watch { border-color: #2f4a38; background: #0e1512; }
  .e-l { min-width: 0; }
  .e-tk { font-size: 18px; font-weight: 800; display: flex; align-items: center; gap: 6px; }
  .e-star { color: #39d98a; font-size: 13px; }
  .e-sub { font-size: 12px; color: #8a919b; font-weight: 600; margin-top: 3px; display: flex; gap: 5px; flex-wrap: wrap; }
  .e-time { color: #6b7280; }
  .e-r { text-align: right; flex-shrink: 0; }
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
  .wrap.m .chart-card { flex: none; height: 46vh; min-height: 280px; }
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
