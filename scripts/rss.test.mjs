// RSS 파서 테스트 — 고정 자료는 **프로덕션에서 실제로 받아 온 XML** 이다.
// (scripts/fixtures/*.xml, 2026-07-27 10:0x ET 수집)
//
// 파서가 어긋나면 조용히 0건이 되고 화면은 "뉴스가 없네"로 보인다.
// 그래서 매체별 XML 차이(CDATA 유무, <source> 유무, 제목 접미사)를 실물로 고정해 둔다.
//
// 실행: node scripts/rss.test.mjs   (npm test 에 포함)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseRss, unescapeXml, tagText } from "../src/lib/server/rss.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(here, "fixtures", n + ".xml"), "utf8");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; return; }
  fail++;
  console.error(`✗ ${name}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`);
};
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; return; }
  fail++;
  console.error(`✗ ${name}${detail ? "\n   " + detail : ""}`);
};

// ── 엔티티 복원 ───────────────────────────────────────
eq("숫자 엔티티", unescapeXml("Micron&#39;s guidance"), "Micron's guidance");
eq("16진 엔티티", unescapeXml("AT&#x26;T"), "AT&T");
eq("이중 이스케이프", unescapeXml("S&amp;#39;s"), "S's");
eq("&amp; 는 마지막에", unescapeXml("Procter &amp; Gamble"), "Procter & Gamble");
eq("태그 제거", unescapeXml("<b>Fed</b> holds"), "Fed holds");
eq("공백 정리", unescapeXml("  a\n\n  b  "), "a b");
eq("CDATA 추출", tagText("<title><![CDATA[Hello]]></title>", "title"), "Hello");
eq("속성 있는 태그", tagText('<guid isPermaLink="false">x1</guid>', "guid"), "x1");

// ── CNBC (CDATA, <source> 없음) ───────────────────────
{
  const items = parseRss(fixture("cnbc-tech"), "CNBC Tech");
  ok("CNBC: 항목이 파싱된다", items.length >= 20, `got ${items.length}`);
  ok("CNBC: 매체명이 피드명으로 채워진다", items.every((i) => i.source === "CNBC Tech"));
  ok("CNBC: 전부 시각이 있다", items.every((i) => Number.isFinite(i.epoch) && i.epoch > 1_600_000_000));
  ok("CNBC: 전부 URL 이 있다", items.every((i) => /^https?:\/\//.test(i.url)));
  ok("CNBC: 제목에 잔여 태그가 없다", items.every((i) => !/[<>]/.test(i.title)));
  // ★ 사용자가 놓쳤다고 지적한 바로 그 기사가 이 피드에 있었다
  ok("CNBC: CXMT(창신메모리) 기사가 잡힌다",
    items.some((i) => /CXMT/i.test(i.title)),
    "제목 예시: " + items.slice(0, 3).map((i) => i.title).join(" | "));
}

// ── MarketWatch ───────────────────────────────────────
{
  const items = parseRss(fixture("marketwatch"), "MarketWatch");
  ok("MW: 항목이 파싱된다", items.length >= 8, `got ${items.length}`);
  ok("MW: 전부 시각이 있다", items.every((i) => i.epoch > 1_600_000_000));
  ok("MW: 전부 URL 이 있다", items.every((i) => /^https?:\/\//.test(i.url)));
}

// ── 구글 뉴스 (<source> 있음 + 제목 접미사) ───────────
{
  const items = parseRss(fixture("googlenews-semi"), "Google News");
  ok("GN: 항목이 파싱된다", items.length >= 80, `got ${items.length}`);
  ok("GN: 원 매체명을 <source> 에서 뽑는다",
    items.some((i) => i.source && i.source !== "Google News"),
    "매체 예시: " + [...new Set(items.map((i) => i.source))].slice(0, 6).join(", "));
  // 제목 끝의 " - 매체명" 이 남아 있으면 방송 자막이 지저분해진다
  const leftover = items.filter((i) => {
    const esc = i.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\s[-–—]\\s${esc}$`, "i").test(i.title);
  });
  eq("GN: 제목의 매체명 접미사가 제거된다", leftover.length, 0);
  ok("GN: 전부 시각이 있다", items.every((i) => i.epoch > 1_600_000_000));
}

// ── 망가진 입력에도 죽지 않는다 ───────────────────────
eq("빈 문자열", parseRss("", "X").length, 0);
eq("item 없음", parseRss("<rss><channel><title>t</title></channel></rss>", "X").length, 0);
eq("pubDate 없으면 버린다", parseRss("<item><title>a</title><link>http://x</link></item>", "X").length, 0);
eq("link 없으면 버린다",
  parseRss("<item><title>a</title><pubDate>Mon, 27 Jul 2026 13:00:00 GMT</pubDate></item>", "X").length, 0);
eq("닫는 태그 없어도 안 죽는다",
  parseRss("<item><title>a</title><pubDate>Mon, 27 Jul 2026 13:00:00 GMT</pubDate><link>http://x</link>", "X").length, 1);
eq("undefined", parseRss(undefined, "X").length, 0);

console.log(`\nrss: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
