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
      max_memory_restart: "400M",
      kill_timeout: 10000,
      // 비밀값은 전부 .env 에서 읽는다. 여기 하드코딩 금지.
      node_args: "--env-file=/home/market-watch/.env",
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
