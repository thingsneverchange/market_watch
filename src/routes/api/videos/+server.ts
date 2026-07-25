import type { RequestHandler } from "./$types";
import { getVerifiedVideos } from "$lib/server/livevideos";

export const GET: RequestHandler = async () => {
  const videos = await getVerifiedVideos();
  return new Response(JSON.stringify({ videos, verifiedAt: Date.now() }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
