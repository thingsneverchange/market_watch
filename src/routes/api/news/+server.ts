import type { RequestHandler } from "./$types";

function parseNYTRss(xml: string) {
  const items: { title: string; link: string; pubDate?: string }[] = [];

  const blocks = xml.split("<item>").slice(1);
  for (const b of blocks) {
    const title =
      (b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ??
        b.match(/<title>(.*?)<\/title>/))?.[1]?.trim();

    const link = (b.match(/<link>(.*?)<\/link>/) ?? [])[1]?.trim();
    const pubDate = (b.match(/<pubDate>(.*?)<\/pubDate>/) ?? [])[1]?.trim();

    if (title && link) items.push({ title, link, pubDate });
    if (items.length >= 10) break;
  }
  return items;
}

export const GET: RequestHandler = async () => {
  const url = "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml";
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (FirmnoteOverlay)" } });

  if (!res.ok) {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }

  const xml = await res.text();
  const items = parseNYTRss(xml);

  return new Response(JSON.stringify({ items }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "s-maxage=60, stale-while-revalidate=300"
    }
  });
};
