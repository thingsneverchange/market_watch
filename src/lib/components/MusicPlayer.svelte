<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  // 배경음악 — YouTube 재생목록 (사용자 본인 음악). 방송 오버레이의 보조 오디오다.
  //  ※ 자동재생하지 않는다. 반드시 재생(►) 버튼을 눌러야 켜진다.
  //    (방송 중 갑자기 소리가 나는 사고 방지 + 브라우저 자동재생 정책과도 무관해짐)
  export let list = "PLDW9aYE0CQaQmdJ6-yDNF8WHyadZAgZX8";
  export let startVolume = 30;

  // ---- 상태 ----
  let host: HTMLDivElement;
  let player: any = null;
  let ready = false;
  let playing = false;
  let muted = false;
  let shuffled = true;
  let expanded = false;
  let volume = startVolume;
  let title = "";

  // YouTube IFrame API 를 한 번만 로드한다.
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

  onMount(async () => {
    const YT = await loadYT();
    if (!host) return;
    player = new YT.Player(host, {
      width: "100%",
      height: "100%",
      playerVars: {
        listType: "playlist",
        list,
        autoplay: 0,          // 정책상 소리 있는 자동재생은 어차피 막힌다 → 제스처로 시작
        loop: 1,
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        iv_load_policy: 3
      },
      events: {
        onReady: (e: any) => {
          ready = true;
          try {
            e.target.setVolume(volume);
            if (shuffled) e.target.setShuffle(true);
            // ★ 자동재생하지 않는다 — 사용자가 ► 를 눌러야 시작한다.
          } catch {}
        },
        onStateChange: (e: any) => {
          // 1=재생, 2=일시정지, 3=버퍼링, 0=종료
          playing = e.data === 1;
          try { title = player?.getVideoData?.().title ?? title; } catch {}
        },
        onError: () => { /* 개별 영상 오류는 다음 곡으로 넘어가며 무시 */ }
      }
    });
  });

  onDestroy(() => { try { player?.destroy?.(); } catch {} });

  function togglePlay() {
    if (!player) return;
    if (playing) player.pauseVideo();
    else player.playVideo();
  }
  function next() { try { player?.nextVideo?.(); } catch {} }
  function prev() { try { player?.previousVideo?.(); } catch {} }
  function toggleMute() {
    if (!player) return;
    muted = !muted;
    muted ? player.mute() : player.unMute();
  }
  function toggleShuffle() {
    shuffled = !shuffled;
    try { player?.setShuffle?.(shuffled); } catch {}
  }
  function onVolume(e: Event) {
    volume = Number((e.target as HTMLInputElement).value);
    muted = false;
    try { player?.unMute?.(); player?.setVolume?.(volume); } catch {}
  }
</script>

<!-- 좌하단 컴팩트 플레이어. 접으면 pill, 펴면 컨트롤 + 소형 영상. 오디오는 접어도 계속 흐른다. -->
<div class="mp" class:expanded>
  <div class="mp-bar">
    <button class="mp-btn play" class:on={playing} on:click={togglePlay} title={playing ? "Pause" : "Play"}>
      {#if playing}❚❚{:else}►{/if}
    </button>
    <div class="mp-info" on:click={() => (expanded = !expanded)} role="button" tabindex="0"
         on:keydown={(e) => { if (e.key === "Enter") expanded = !expanded; }}>
      <span class="mp-eq" class:on={playing}><i></i><i></i><i></i></span>
      <span class="mp-title">{playing ? (title || "MUSIC") : (title || "MUSIC — press ►")}</span>
    </div>
    <button class="mp-btn" on:click={prev} title="Previous">⏮</button>
    <button class="mp-btn" on:click={next} title="Next">⏭</button>
    <button class="mp-btn" class:active={shuffled} on:click={toggleShuffle} title="Shuffle">⇄</button>
    <button class="mp-btn" on:click={toggleMute} title={muted ? "Unmute" : "Mute"}>{muted ? "🔇" : "🔊"}</button>
    <input class="mp-vol" type="range" min="0" max="100" value={volume} on:input={onVolume} title="Volume" />
    <button class="mp-btn caret" on:click={() => (expanded = !expanded)} title={expanded ? "Collapse" : "Expand"}>
      {expanded ? "▾" : "▴"}
    </button>
  </div>
  <!-- 영상 영역: 접으면 높이 0 (display:none 은 쓰지 않는다 — YT 가 재생을 멈춘다) -->
  <div class="mp-video"><div bind:this={host}></div></div>
</div>

<style>
  .mp {
    position: absolute; left: 14px; bottom: 58px; z-index: 60;
    width: 340px; background: rgba(11,13,17,.94); border: 1px solid #23272f;
    border-radius: 12px; overflow: hidden; box-shadow: 0 16px 50px rgba(0,0,0,.5);
    backdrop-filter: blur(6px);
  }
  .mp-bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; }
  .mp-btn {
    flex: 0 0 auto; background: #14171d; border: 1px solid #23272f; color: #c7cdd6;
    border-radius: 7px; width: 28px; height: 28px; font-size: 12px; cursor: pointer;
    display: flex; align-items: center; justify-content: center; padding: 0; line-height: 1;
  }
  .mp-btn:hover { background: #1b1f27; color: #fff; }
  .mp-btn.active { color: #39d98a; border-color: #16281d; background: #0d1712; }
  .mp-btn.play { width: 32px; height: 32px; font-size: 13px; color: #fff; background: #1f2530; }
  .mp-btn.play.on { color: #39d98a; border-color: #16281d; background: #0d1712; }
  .mp-info { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 7px; cursor: pointer; }
  .mp-title {
    font-size: 12px; font-weight: 600; color: #c7cdd6; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  /* 이퀄라이저 바 — 재생 중일 때만 춤춘다 */
  .mp-eq { flex: 0 0 auto; display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; }
  .mp-eq i { width: 3px; height: 4px; background: #4b5563; border-radius: 1px; }
  .mp-eq.on i { background: #39d98a; animation: mp-eq 0.9s ease-in-out infinite; }
  .mp-eq.on i:nth-child(2) { animation-delay: 0.3s; }
  .mp-eq.on i:nth-child(3) { animation-delay: 0.6s; }
  @keyframes mp-eq { 0%,100% { height: 4px; } 50% { height: 12px; } }
  .mp-vol { flex: 0 0 54px; width: 54px; accent-color: #39d98a; height: 3px; }
  .mp-btn.caret { width: 24px; }

  /* 영상: 기본 접힘(높이 0). 펴면 뜬다. display:none 대신 높이로 접어 오디오 유지. */
  .mp-video { height: 0; transition: height .18s ease; background: #000; }
  .mp .mp-video :global(iframe) { width: 100%; height: 100%; border: 0; display: block; }
  .mp.expanded .mp-video { height: 191px; } /* 340px 폭의 16:9 */

  /* 모바일: 화면을 가리지 않게 더 작게 */
  :global(.wrap.m) .mp { left: 8px; bottom: 8px; width: 260px; position: fixed; }
  :global(.wrap.m) .mp.expanded .mp-video { height: 146px; }
</style>
