import type { RequestHandler } from "./$types";
import { OPENAI_SECRET } from "$env/static/private";

const NYT_RSS = "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml";

const etTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit", minute: "2-digit", hour12: true
});

function toET(pubDate?: string) {
  if (!pubDate) return "";
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return "";
  return etTime.format(d).replace(" ", "");
}

async function fetchNYT() {
  try {
    const r = await fetch(NYT_RSS);
    const xml = await r.text();
    // Simple Regex Parse
    const items = [];
    const blocks = xml.split("<item>").slice(1);
    for (const b of blocks) {
      const title = (b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ?? b.match(/<title>(.*?)<\/title>/)?.[1])?.trim();
      const link = b.match(/<link>(.*?)<\/link>/)?.[1]?.trim();
      const pubDate = b.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();
      if (title && link) items.push({ title, link, timeET: toET(pubDate) });
      if (items.length >= 12) break;
    }
    return items;
  } catch { return []; }
}

const SCHEMA = {
  type: "object",
  properties: {
    driver: {
      type: "object",
      properties: {
        text: { type: "string" },
        sentiment: { type: "string", enum: ["bull", "bear", "neutral"] }
      },
      required: ["text", "sentiment"]
    },
    news: {
      type: "array",
      items: {
        type: "object",
        properties: {
          originalIndex: { type: "integer" },
          title: { type: "string" },
          sentiment: { type: "string", enum: ["pos", "neg", "neu"] },
          level: { type: "integer" }
        },
        required: ["originalIndex", "title", "sentiment", "level"]
      }
    }
  },
  required: ["driver", "news"]
} as const;

export const GET: RequestHandler = async () => {
  const items = await fetchNYT();

  if (!OPENAI_SECRET) {
    return new Response(JSON.stringify({
      driver: { text: "API Key Missing", sentiment: "neutral" },
      news: items.slice(0,5).map(x=>({...x, sentiment:"neu", level:3}))
    }));
  }

  const system = `
    Analyze market news.
    1. 'driver': ONE short sentence (max 50 chars) on WHY market moves. Identify sentiment (bull/bear/neutral).
    2. 'news': Pick 5 items. Rewrite titles to be SUPER SHORT (max 5 words).
       Sentiment: pos/neg/neu. Level: 1-5.
  `;

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(items.map((x,i)=>({i,t:x.title}))) }],
        response_format: { type: "json_schema", json_schema: { name: "news", strict: true, schema: SCHEMA } }
      })
    });

    const j = await r.json();
    const parsed = JSON.parse(j.choices[0].message.content);

    // Merge back
    const news = parsed.news.map((n:any) => ({
      ...items[n.originalIndex],
      title: n.title,
      sentiment: n.sentiment,
      level: n.level
    }));

    return new Response(JSON.stringify({ driver: parsed.driver, news }));
  } catch {
    return new Response(JSON.stringify({
      driver: { text: "Market Data Unavailable", sentiment: "neutral" },
      news: []
    }));
  }
};
