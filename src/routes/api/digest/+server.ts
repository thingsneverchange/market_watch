import type { RequestHandler } from "./$types";
import { OPENAI_SECRET } from "$env/static/private";

const NYT_RSS = "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml";

// ET formatter
const etTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true
});
function toET(pubDate?: string) {
  if (!pubDate) return "";
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return "";
  return etTime.format(d).replace(" ", "");
}

// RSS parse
function parseNYTRss(xml: string) {
  const items: { title: string; link: string; pubDate?: string; timeET: string }[] = [];
  const blocks = xml.split("<item>").slice(1);

  for (const b of blocks) {
    const title =
      (b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ??
        b.match(/<title>(.*?)<\/title>/)?.[1])?.trim();

    const link = b.match(/<link>(.*?)<\/link>/)?.[1]?.trim();
    const pubDate = b.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();

    if (title && link) {
      items.push({ title, link, pubDate, timeET: toET(pubDate) });
    }
    if (items.length >= 12) break;
  }
  return items;
}

async function fetchNYT() {
  const r = await fetch(NYT_RSS, { cache: "no-store" });
  if (!r.ok) return [];
  const xml = await r.text();
  return parseNYTRss(xml);
}

// strict schema
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    now: { type: "string" },
    breaking: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            timeET: { type: "string" },
            headline: { type: "string" },
            level: { type: "integer", minimum: 1, maximum: 5 }
          },
          required: ["timeET", "headline", "level"]
        }
      ]
    },
    news: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          timeET: { type: "string" },
          title: { type: "string" },
          level: { type: "integer", minimum: 1, maximum: 5 },
          link: { anyOf: [{ type: "string" }, { type: "null" }] }
        },
        required: ["timeET", "title", "level", "link"]
      }
    }
  },
  required: ["now", "breaking", "news"]
} as const;

function clamp(s: string, n: number) {
  const t = (s ?? "").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

async function makeDigest(items: { title: string; link: string; timeET: string }[]) {
  if (!OPENAI_SECRET) {
    return {
      now: "Digest offline.",
      breaking: null,
      news: items.slice(0, 5).map((x) => ({
        timeET: x.timeET || "",
        title: clamp(x.title, 62),
        level: 2,
        link: x.link
      }))
    };
  }

  const system = `
You generate ultra-short on-screen market overlays.

Output must be ENGLISH. Keep it broadcast-ready.

Rules:
- now: exactly ONE sentence, <= 78 characters. Must say WHY markets move (one driver).
- breaking: optional. headline <= 62 chars. One clause only.
- news: exactly 5 items.
  - title <= 62 chars (headline-style, readable, no quotes/parentheses).
  - level 1-5 market impact (5 = major).
Use provided timeET. If blank, keep "".
Return strict JSON only.
`;

  const body = {
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify({ items }, null, 2) }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "digest_pack",
        strict: true,
        schema: SCHEMA
      }
    },
    store: false
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_SECRET}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    return {
      now: "Digest error.",
      breaking: null,
      news: items.slice(0, 5).map((x) => ({
        timeET: x.timeET || "",
        title: clamp(x.title, 62),
        level: 2,
        link: x.link
      }))
    };
  }

  const j = await r.json();
  const text = (j.output ?? [])
    .flatMap((o: any) => o.content ?? [])
    .filter((c: any) => c.type === "output_text")
    .map((c: any) => c.text)
    .join("\n")
    .trim();

  try {
    const parsed = JSON.parse(text);

    // extra safety clamp for UI
    parsed.now = clamp(parsed.now, 78);
    if (parsed.breaking?.headline) parsed.breaking.headline = clamp(parsed.breaking.headline, 62);
    parsed.news = (parsed.news ?? []).slice(0, 5).map((n: any) => ({
      timeET: n.timeET ?? "",
      title: clamp(n.title ?? "", 62),
      level: Math.min(5, Math.max(1, Number(n.level ?? 2))),
      link: n.link ?? null
    }));

    return parsed;
  } catch {
    return {
      now: "Digest parse error.",
      breaking: null,
      news: items.slice(0, 5).map((x) => ({
        timeET: x.timeET || "",
        title: clamp(x.title, 62),
        level: 2,
        link: x.link
      }))
    };
  }
}

export const GET: RequestHandler = async () => {
  const items = await fetchNYT();
  const pack = await makeDigest(items);

  return new Response(JSON.stringify({ ...pack, updatedAt: new Date().toISOString() }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
};
