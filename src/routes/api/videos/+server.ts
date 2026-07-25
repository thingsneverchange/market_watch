import type { RequestHandler } from "./$types";
import { getFeed, fresh } from "$lib/server/marketfeed";
import { parseYouTubeId } from "$lib/server/control";

// ============================================================
//  라이브 영상 후보 — Claude 가 찾은 목록을 **실제 존재하는지 재검증**해서 내보낸다.
//
//  왜 재검증하나: LLM 은 그럴듯한 유튜브 ID 를 지어낼 수 있다. 그대로 송출하면
//  방송에 "동영상을 사용할 수 없음"이 뜬다. 유튜브 oEmbed 는 **API 키 없이**
//  존재 여부를 확인해 주고, 진짜 제목까지 돌려준다 → 검증된 것만 컨트롤러에 보인다.
// ============================================================

type Verified = {
  title: string;      // oEmbed 가 준 실제 제목 (없으면 Claude 제목)
  url: string;
  videoId: string;
  source: string;
  note: string | null;
  startET: string | null;
  live: boolean;
  author: string | null;
};

const TTL_MS = 5 * 60_000;
let cache: { at: number; data: Verified[] } | null = null;
let inflight: Promise<Verified[]> | null = null;

/** oEmbed 로 실존 확인 (API 키 불필요). 200 = 존재, 그 외 = 없음/비공개. */
async function verify(videoId: string): Promise<{ title: string; author: string } | null> {
  const url =
    `https://www.youtube.com/oembed?format=json&url=` +
    encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) return null;
    const j: any = await r.json();
    return { title: String(j?.title ?? ""), author: String(j?.author_name ?? "") };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const GET: RequestHandler = async () => {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) {
    return json({ videos: cache.data, verifiedAt: cache.at });
  }
  if (inflight) return json({ videos: await inflight, verifiedAt: Date.now() });

  inflight = (async () => {
    const feed = await getFeed();
    const item = fresh(feed, "live_videos" as any);
    const raw: any[] = (item as any)?.payload?.items ?? [];

    const out: Verified[] = [];
    await Promise.all(
      raw.slice(0, 8).map(async (v) => {
        const id = parseYouTubeId(String(v?.url ?? ""));
        // 채널 라이브 URL(/@channel/live)은 영상 ID 가 없어 oEmbed 검증이 불가능하다.
        // 이런 항목은 "검증 불가"로 두지 않고 아예 제외한다 — 방송에 빈 화면을 띄우느니 안 보이는 게 낫다.
        if (!id) return;
        const ok = await verify(id);
        if (!ok) return; // 존재하지 않는 ID(=환각) 는 버린다
        out.push({
          title: ok.title || String(v?.title ?? ""),
          url: `https://www.youtube.com/watch?v=${id}`,
          videoId: id,
          source: String(v?.source ?? "other"),
          note: v?.note ? String(v.note) : null,
          startET: v?.startET ? String(v.startET) : null,
          live: v?.live === true,
          author: ok.author || null
        });
      })
    );

    // 라이브 먼저, 그다음 시작 시각 순
    out.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      const ta = a.startET ? Date.parse(a.startET) : Infinity;
      const tb = b.startET ? Date.parse(b.startET) : Infinity;
      return ta - tb;
    });

    cache = { at: Date.now(), data: out };
    inflight = null;
    return out;
  })();

  const videos = await inflight;
  return json({ videos, verifiedAt: Date.now() });
};

function json(obj: unknown) {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
