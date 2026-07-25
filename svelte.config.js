import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		// adapter-node: 서버에서 PM2 로 직접 돌린다 (nginx 없이 포트 직결).
		// 앞단에 프록시가 없으므로 소켓 주소가 곧 클라이언트 IP → hooks.server.ts 의
		// IP 허용목록이 신뢰할 수 있는 값을 본다.
		adapter: adapter()
	}
};

export default config;
