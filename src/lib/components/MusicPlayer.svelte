<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  // 배경음악 — YouTube 재생목록. 방송 오버레이의 보조 오디오다.
  //  ※ 저작권: 유튜브 임베드 플레이어는 유튜브 안에서의 재생 라이선스만 커버한다.
  //    이 오디오를 다시 '내 방송'으로 재송출(트위치/유튜브 라이브)하면 Content ID/DMCA
  //    대상이 될 수 있다. 개인 모니터링은 무방하나 공개 스트리밍은 사용자 책임이다.
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
  let started = false;         // 사용자 제스처로 재생을 한 번이라도 시작했는가 (autoplay 정책)
  let volume = startVolume;
  let title = "";
  let blocked = false;         // autoplay 가 브라우저 정책에 막힘

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
            // 자동재생 시도 — 막히면 blocked 로 두고 사용자가 ▶ 를 누른다.
            e.target.playVideo();
          } catch {}
        },
        onStateChange: (e: any) => {
          // 1=재생, 2=일시정지, 3=버퍼링, 0=종료
          playing = e.data === 1;
          if (e.data === 1) { started = true; blocked = false; }
          try { title = player?.getVideoData?.().title ?? title; } catch {}
        },
        onError: () => { /* 개별 영상 오류는 다음 곡으로 넘어가며 무시 */ }
      }
    });

    // 재생 상태가 짧게 안 잡히면 autoplay 가 막힌 것으로 본다 (사용자에게 ▶ 노출)
    setTimeout(() => { if (ready && !started) blocked = true; }, 1500);
  });

  onDestroy(() => { try { player?.destroy?.(); } catch {} });

  function togglePlay() {
    if (!player) return;
    started = true; blocked = false;
    if (playing) player.pauseVideo();
    else player.playVideo();
  }
  function next() { started = true; try { player?.nextVideo?.(); } catch {} }
  function prev() { started = true; try { player?.previousVideo?.(); } catch {} }
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
    <button class="mp-btn play" class:blocked on:click={togglePlay} title={playing ? "Pause" : "Play"}>
      {#if playing}❚❚{:else}►{/if}
    </button>
    <div class="mp-info" on:click={() => (expanded = !expanded)} role="button" tabindex="0"
         on:keydown={(e) => { if (e.key === "Enter") expanded = !expanded; }}>
      <span class="mp-eq" class:on={playing}><i></i><i></i><i></i></span>
      <span class="mp-title">{blocked && !started ? "MUSIC — click ► to play" : (title || "MUSIC")}</span>
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
  .mp-btn.play.blocked { background: #ff3b30; border-color: #ff3b30; animation: mp-pulse 1.5s infinite; }
  @keyframes mp-pulse { 50% { opacity: .55; } }
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
