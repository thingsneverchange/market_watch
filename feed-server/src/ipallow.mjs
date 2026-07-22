// ============================================================
//  IP 허용목록
//
//  이 서버에는 ufw / iptables / nft 가 설치돼 있지 않고 클라우드 방화벽도 없다.
//  즉 포트를 열면 인터넷 전체에 노출된다 → **차단은 이 파일이 유일한 방어선이다.**
//
//  설계 원칙:
//   · 기본값은 "전부 차단". 설정이 비어 있으면 열지 않는다 (fail-closed).
//   · 거절된 IP 를 로그에 남긴다 — 가정용 IP 는 바뀌므로, 접속이 안 될 때
//     로그만 보면 "지금 내 IP 가 뭘로 바뀌었는지" 바로 알 수 있어야 한다.
//   · 프록시를 안 쓰므로 X-Forwarded-For 를 **신뢰하지 않는다.**
//     (신뢰하면 누구나 헤더를 위조해 통과할 수 있다)
// ============================================================

/** "1.2.3.4" → 32비트 정수 */
function ipToInt(ip) {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const s of p) {
    // 앞자리 0 패딩("029")을 거부한다. 계층에 따라 8진수로 해석될 수 있어
    // "같은 IP 처럼 보이지만 다른 값"이 되는 우회 경로가 생긴다.
    if (!/^(0|[1-9]\d{0,2})$/.test(s)) return null;
    const v = Number(s);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** "1.2.3.0/24" 또는 "1.2.3.4" → 매처 */
function parseRule(rule) {
  const s = rule.trim();
  if (!s) return null;
  const [addr, bitsRaw] = s.split("/");
  const base = ipToInt(addr);
  if (base === null) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask, text: s };
}

export function parseAllowList(raw) {
  const rules = [];
  const bad = [];
  for (const part of String(raw || "").split(/[,\s]+/)) {
    if (!part) continue;
    const r = parseRule(part);
    if (r) rules.push(r);
    else bad.push(part);
  }
  return { rules, bad };
}

/**
 * 소켓의 실제 원격 주소를 정규화한다.
 * ::ffff:1.2.3.4 (IPv4-mapped IPv6) 형태를 1.2.3.4 로 되돌린다.
 */
export function normalizeRemote(addr) {
  if (!addr) return "";
  let a = String(addr);
  if (a.startsWith("::ffff:")) a = a.slice(7);
  return a;
}

export function isAllowed(remote, rules) {
  const n = ipToInt(remote);
  if (n === null) return false; // IPv6 등 파싱 불가 → 차단 (fail-closed)
  return rules.some((r) => ((n & r.mask) >>> 0) === r.base);
}

/** 최근 거절 기록 (진단용, 메모리에만 보관) */
const recentDenied = new Map(); // ip → {count, first, last}
const MAX_TRACKED = 50;

export function recordDenied(ip) {
  const now = Date.now();
  const e = recentDenied.get(ip);
  if (e) {
    e.count++;
    e.last = now;
  } else {
    if (recentDenied.size >= MAX_TRACKED) {
      // 가장 오래된 것 제거
      let oldest = null, oldestAt = Infinity;
      for (const [k, v] of recentDenied) if (v.last < oldestAt) { oldestAt = v.last; oldest = k; }
      if (oldest) recentDenied.delete(oldest);
    }
    recentDenied.set(ip, { count: 1, first: now, last: now });
  }
}

export function deniedSummary() {
  return [...recentDenied.entries()]
    .sort((a, b) => b[1].last - a[1].last)
    .slice(0, 20)
    .map(([ip, v]) => ({ ip, count: v.count, lastAt: new Date(v.last).toISOString() }));
}
