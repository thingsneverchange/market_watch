// PM2 설정 — themecloset 앱들과 완전히 분리된 별도 앱.
//
//  이름   : market-feed          (themecloset-* 와 접두어가 다름)
//  포트   : 6210                 (themecloset 은 6109 / 5109)
//  DB     : SQLite 파일          (themecloset 의 MySQL 과 무관)
//  경로   : /home/market-feed    (themecloset_builder 와 별도)
//
// ※ instances: 1 (cluster 아님) — SQLite 쓰기는 cron 하나뿐이라
//    워커를 늘릴 이유가 없고, 단일 프로세스면 WAL 경합도 사라진다.
module.exports = {
  apps: [
    {
      name: "market-feed",
      script: "./src/server.mjs",
      cwd: "/home/market-feed/feed-server",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 3000,
      watch: false,
      max_memory_restart: "200M",
      kill_timeout: 10000,
      // 비밀값과 IP 허용목록은 전부 .env 에서 읽는다. 여기 하드코딩 금지.
      node_args: "--env-file=/home/market-feed/feed-server/.env",
      error_file: "/home/market-feed/feed-server/logs/err.log",
      out_file: "/home/market-feed/feed-server/logs/out.log",
      merge_logs: true,
      time: true
    }
  ]
};
