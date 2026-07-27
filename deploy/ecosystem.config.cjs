// PM2 설정 — 오버레이(SvelteKit). themecloset·market-feed 와 완전히 분리된 별도 앱.
//
//  이름 : market-watch-overlay   (market-feed / themecloset-* 와 헷갈리지 않게 접미사까지 붙임)
//  포트 : 6211                   (market-feed 6210 / themecloset 6109·5109 와 다름)
//  경로 : /home/market-watch
//  방어 : hooks.server.ts 의 IP 허용목록 (nginx 없이 포트 직결이라 이게 유일한 방어선)
module.exports = {
  apps: [
    {
      name: "market-watch-overlay",
      script: "./build/index.js",
      cwd: "/home/market-watch",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 3000,
      watch: false,
      // ★ 400M 이었는데 **실사용보다 낮았다.** 프로덕션이 30초마다 재시작하고 있었다
      //   (실측: 재시작 232회, out.log 에 "Listening" 이 정확히 30초 간격으로 찍힘).
      //   방송이 매 30초마다 ~10초씩 끊겼다는 뜻이다.
      //
      //   원인은 누수가 아니라 **V8 이 GC 압력 없이 힙을 키운 것**이다. 8GB 머신에서
      //   기본 old-space 가 수 GB라 Node 는 400M 을 신경 쓸 이유가 없다 —
      //   실측 RSS 는 기동 10초 만에 344MB → 647MB 로 뛰었다.
      //   pm2 의 max_memory_restart 는 **V8 에게 알려지지 않는다.** 두 숫자를 맞춰야 한다.
      //
      //   → --max-old-space-size 로 V8 이 먼저 GC 하게 만들고, pm2 상한은 그 위에 둔다.
      //     상한만 올리면 V8 은 여전히 계속 커진다(문제를 미루기만 한다).
      max_memory_restart: "900M",
      kill_timeout: 10000,
      // 비밀값은 전부 .env 에서 읽는다. 여기 하드코딩 금지.
      node_args: "--env-file=/home/market-watch/.env --max-old-space-size=384",
      env: {
        NODE_ENV: "production",
        PORT: 6211,
        HOST: "0.0.0.0",
        // adapter-node 는 프록시가 없으면 소켓 주소를 그대로 클라이언트 IP 로 준다.
        // (앞단에 nginx 를 두게 되면 ADDRESS_HEADER 를 설정해야 IP 허용목록이 정확해진다)
        BODY_SIZE_LIMIT: "1M"
      },
      error_file: "/home/market-watch/logs/err.log",
      out_file: "/home/market-watch/logs/out.log",
      merge_logs: true,
      time: true
    }
  ]
};
