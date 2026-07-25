<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  // 배경음악 — YouTube 재생목록 (사용자 본인 음악).
  //
  //  ※ 이 컴포넌트는 **화면에 아무것도 그리지 않는다(헤드리스)**.
  //     오디오는 방송 화면(오버레이)에서 나야 OBS 가 잡으므로 플레이어는 여기 두되,
  //     조작 UI 는 /control(폰)로 옮겨서 방송 화면을 깨끗하게 유지한다.
  //     → 부모가 control 상태를 폴링해 playing/volume/cmdSeq 를 내려준다.
  export let list = "PLDW9aYE0CQaQmdJ6-yDNF8WHyadZAgZX8";
  export let playing = false;   // /control 의 재생/일시정지
  export let volume = 30;       // /control 의 볼륨
  export let cmdSeq = 0;        // 곡 이동 명령 시퀀스 (바뀔 때 1회만 실행)
  export let cmd: "none" | "next" | "prev" = "none";

  let host: HTMLDivElement;
  let player: any = null;
  let ready = false;
  let lastSeq = 0;

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
        autoplay: 0,       // 자동재생하지 않는다 — /control 에서 재생을 눌러야 시작
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
            e.target.setShuffle(true);
            if (playing) e.target.playVideo();
          } catch {}
        },
        onError: () => { /* 개별 영상 오류는 다음 곡으로 넘어가며 무시 */ }
      }
    });
  });

  onDestroy(() => { try { player?.destroy?.(); } catch {} });

  // /control 상태 → 플레이어 반영
  $: if (ready && player) {
    try { playing ? player.playVideo() : player.pauseVideo(); } catch {}
  }
  $: if (ready && player) {
    try { player.setVolume(Math.max(0, Math.min(100, volume))); } catch {}
  }
  // 곡 이동은 seq 가 바뀐 순간 딱 한 번만 (폴링마다 반복 실행되면 곡이 계속 넘어간다)
  $: if (ready && player && cmdSeq !== lastSeq) {
    lastSeq = cmdSeq;
    try {
      if (cmd === "next") player.nextVideo();
      else if (cmd === "prev") player.previousVideo();
    } catch {}
  }
</script>

<!-- 화면에 보이지 않는다. 오디오만 흐른다 (OBS 가 페이지 오디오를 캡처).
     display:none 은 쓰지 않는다 — YT 가 재생을 멈춘다. 1px 로 접어 화면 밖에 둔다. -->
<div class="mp-headless" aria-hidden="true"><div bind:this={host}></div></div>

<style>
  .mp-headless {
    position: absolute; width: 1px; height: 1px;
    left: -9999px; top: 0; overflow: hidden; opacity: 0; pointer-events: none;
  }
</style>
