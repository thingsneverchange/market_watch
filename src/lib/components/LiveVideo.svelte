<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  // 라이브 영상 패널 — 좌측 컬럼(평소엔 MARKET HEADLINES 자리)에 사각형으로 뜬다.
  //
  //  ※ raw <iframe> 이 아니라 YouTube IFrame API 를 쓴다.
  //     이유: "동영상을 재생할 수 없음"(임베드 차단·삭제·지역제한)을 **감지할 방법이 iframe 엔 없다**.
  //     API 의 onError 를 받아야 화면에 그 사실을 알리고 유튜브 링크를 띄울 수 있다.
  //     방송 중에 원인 모를 검은 화면이 떠 있는 게 최악이다.
  export let videoId = "";
  export let label = "";
  /** /control 의 재생 상태. **자동재생하지 않고** 이 값에 따른다. */
  export let playing = false;

  let host: HTMLDivElement;
  let player: any = null;
  let ready = false;
  let state: "loading" | "ok" | "error" = "loading";
  let errMsg = "";
  let token = 0; // 세대 토큰 — 영상이 바뀌면 이전 콜백을 무효화

  // /control 의 재생 토글을 따라간다 (플레이어가 준비된 뒤에만).
  // 자동재생을 끄고 이 경로로만 재생한다 — 올리자마자 소리가 나가면 방송 사고다.
  $: if (ready && player) {
    try { playing ? player.playVideo() : player.pauseVideo(); } catch {}
  }

  // YouTube 에러 코드 → 사람이 읽을 수 있는 원인
  const ERR: Record<number, string> = {
    2: "Invalid video ID",
    5: "Playback not supported here",
    100: "Video not found or private",
    101: "Owner disabled embedding",
    150: "Owner disabled embedding"
  };

  function loadYT(): Promise<any> {
    const w = window as any;
    if (w.YT && w.YT.Player) return Promise.resolve(w.YT);
    return new Promise((resolve) => {
      const prev = w.onYouTubeIframeAPIReady;
      w.onYouTubeIframeAPIReady = () => { try { prev?.(); } catch {} resolve(w.YT); };
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const s = document.createElement("script");
        s.src = "https://www.youtube.com/iframe_api";
        s.async = true;
        document.head.appendChild(s);
      }
    });
  }

  async function build(id: string) {
    const my = ++token;
    state = "loading";
    errMsg = "";
    try { player?.destroy?.(); } catch {}
    player = null;
    if (!id || !host) return;

    const YT = await loadYT();
    if (my !== token || !host) return; // 그 사이 영상이 바뀌었으면 버린다

    player = new YT.Player(host, {
      width: "100%",
      height: "100%",
      videoId: id,
      playerVars: {
        // ★ 자동재생하지 않는다 — 송출 여부는 /control 에서 사람이 결정한다.
        //   (영상을 올리자마자 소리가 나가면 방송 사고가 된다)
        autoplay: 0, mute: 0, rel: 0, modestbranding: 1, playsinline: 1,
        cc_load_policy: 1, cc_lang_pref: "en", iv_load_policy: 3
      },
      events: {
        onReady: (e: any) => {
          if (my !== token) return;
          ready = true;
          // 컨트롤에서 이미 "재생"으로 눌러 둔 상태면 그때만 튼다
          if (playing) { try { e.target.playVideo(); } catch {} }
        },
        onStateChange: (e: any) => { if (my === token && e.data === 1) state = "ok"; },
        onError: (e: any) => {
          if (my !== token) return;
          state = "error";
          errMsg = ERR[Number(e?.data)] ?? `Playback error (${e?.data})`;
          console.error("[LiveVideo] embed failed:", id, e?.data, errMsg);
        }
      }
    });

    // 임베드가 조용히 실패하는 경우(에러 이벤트도 안 오는 경우)를 위한 백스톱
    setTimeout(() => {
      if (my === token && state === "loading") {
        state = "error";
        errMsg = "Stream did not start";
      }
    }, 12000);
  }

  $: if (videoId) build(videoId);
  onMount(() => { if (videoId) build(videoId); });
  onDestroy(() => { token++; try { player?.destroy?.(); } catch {} });
</script>

<div class="lv">
  <div class="lv-hd">
    <span class="lv-dot"></span>
    <span class="lv-lbl">{label || "LIVE"}</span>
    {#if state === "ok"}<span class="lv-badge">ON AIR</span>{/if}
  </div>
  <div class="lv-box">
    <div class="lv-host" bind:this={host}></div>
    {#if state !== "ok"}
      <div class="lv-overlay" class:err={state === "error"}>
        {#if state === "loading"}
          <span class="lv-spin"></span> Loading stream…
        {:else}
          <!-- 원인을 감추지 않는다. 임베드가 막힌 영상은 유튜브에서 직접 열어야 한다. -->
          <div class="lv-emsg">{errMsg}</div>
          <a class="lv-link" href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer">
            Open on YouTube ↗
          </a>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .lv { background: #0d0f13; border: 1px solid #2a1416; border-radius: 12px; overflow: hidden;
    display: flex; flex-direction: column; }
  .lv-hd { display: flex; align-items: center; gap: 8px; padding: 10px 14px; }
  .lv-dot { width: 8px; height: 8px; border-radius: 50%; background: #ff3b30;
    box-shadow: 0 0 8px #ff3b30; animation: pulse 1.4s infinite; flex-shrink: 0; }
  .lv-lbl { font-size: 14px; font-weight: 800; color: #f2f3f5; letter-spacing: 0.01em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lv-badge { margin-left: auto; font-size: 10px; font-weight: 800; letter-spacing: 0.08em;
    color: #ff8a8a; background: #1a0d0d; border: 1px solid #3a1616; padding: 2px 7px; border-radius: 4px; }
  /* 16:9 사각형 */
  .lv-box { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; }
  .lv-host { position: absolute; inset: 0; }
  .lv-box :global(iframe) { width: 100%; height: 100%; border: 0; display: block; }
  .lv-overlay { position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 14px;
    background: #08090c; color: #9aa3ad; font-size: 14px; font-weight: 600; }
  .lv-overlay.err { color: #d8a860; }
  .lv-emsg { font-size: 15px; font-weight: 700; }
  .lv-link { color: #7db0e8; font-size: 13px; font-weight: 700; text-decoration: none;
    border-bottom: 1px solid #1d3350; }
  .lv-spin { width: 18px; height: 18px; border: 2px solid #2a2e36; border-top-color: #ff5c5c;
    border-radius: 50%; animation: sp .8s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
</style>
