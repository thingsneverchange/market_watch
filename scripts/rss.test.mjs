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
import { isBlockedPublisher, isPressRelease } from "../src/lib/server/headline.ts";

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

// ── 와이어 게이트 (콘텐츠밀 · 자동생성 기사) ──────────
// 실측: 와이어를 붙이자마자 이 매체·제목들이 방송 화면에 올라왔다.
ok("MarketBeat 차단", isBlockedPublisher("MarketBeat"));
ok("GuruFocus 차단", isBlockedPublisher("GuruFocus"));
ok("TechStock² 차단", isBlockedPublisher("TechStock²"));
ok("The Times of India 차단", isBlockedPublisher("The Times of India"));
ok("simplywall.st 차단 (도메인 표기, 공백 없음)", isBlockedPublisher("simplywall.st"));
ok("Simply Wall St 차단 (공백 표기)", isBlockedPublisher("Simply Wall St"));
ok("Reuters 통과", !isBlockedPublisher("Reuters"));
ok("CNBC 통과", !isBlockedPublisher("CNBC"));
ok("The Information 통과 (이번 반도체 1보)", !isBlockedPublisher("The Information"));
ok("Yahoo Finance 통과", !isBlockedPublisher("Yahoo Finance"));
ok("빈 매체명 통과", !isBlockedPublisher(""));

ok("소형주 보도자료 차단",
  isPressRelease("Northeast Bancorp (NASDAQ:NBN) Issues Quarterly Earnings Results"));
ok("자동 시세기사 차단", isPressRelease("Baker Hughes (NASDAQ:BKR) Shares Gap Up After Strong Earnings"));
ok("등급 자동기사 차단", isPressRelease("Acme Corp Given Average Rating of Hold by Brokerages"));
ok("지분변동 자동기사 차단", isPressRelease("Vanguard Group Position Boosted by 3.2%"));
ok("목표가 자동기사 차단", isPressRelease("Micron price target raised to $950 at Citi"));
// 로펌 집단소송 보도자료 — PR Newswire 를 타고 멀쩡한 매체로 들어와 매체 차단을 비껴간다
ok("집단소송 보도자료 차단 (실측)",
  isPressRelease("INVESTOR ALERT: The Hub Group, Inc. (NASDAQ: HUBG) Investors with Substantial Losses Have Opportunity to Lead Class Action"));
ok("주주 알림 차단", isPressRelease("SHAREHOLDER ALERT: Pomerantz Law Firm Investigates Claims On Behalf of Investors"));
ok("소송 마감 알림 차단", isPressRelease("DEADLINE REMINDER: Levi & Korsinsky Reminds Shareholders of Lawsuit"));
ok("진짜 규제 기사는 통과",
  !isPressRelease("SEC opens investigation into Nvidia chip export practices"));
ok("진짜 기사는 통과: CXMT",
  !isPressRelease("Chipmaker CXMT's 466% market debut surge makes it the most valuable China-listed company"));
ok("진짜 기사는 통과: ASML",
  !isPressRelease("ASML and U.S. chip stocks sink on report of China's DUV breakthrough"));
ok("진짜 실적 기사는 통과",
  !isPressRelease("Alphabet beats on earnings but capex guidance spooks investors"));

// 실제 피드에 게이트를 걸어 무엇이 남는지 확인한다 (전멸하면 게이트가 과하다)
{
  const items = parseRss(fixture("googlenews-semi"), "Google News");
  const kept = items.filter((i) => !isBlockedPublisher(i.source) && !isPressRelease(i.title));
  ok("게이트가 실제 피드를 전멸시키지 않는다", kept.length >= items.length * 0.5,
    `${kept.length}/${items.length} 통과`);
  ok("게이트 후에도 CXMT 기사가 남는다", kept.some((i) => /CXMT|466%/i.test(i.title)));
}

console.log(`\nrss: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
