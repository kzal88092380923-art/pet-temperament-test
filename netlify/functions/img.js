// 쿠팡 상품 이미지 프록시 (/api/img?u=<이미지주소>)
// 폰의 광고/추적 차단으로 이미지가 안 뜨는 경우의 2차 경로.
// 허용: https + ads-partners.coupang.com(/image1/ 경로만) + 쿠팡 CDN 서브도메인(image*, img*, thumbnail*, static)
// 리다이렉트도 동일 규칙으로 최대 3회까지만 따라간다.

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TOTAL_TIMEOUT_MS = 4500;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const CDN_HOST_RE = /^(image|img|thumbnail|static)[a-z0-9-]*\.coupangcdn\.com$/;

function isAllowedUrl(u) {
  if (!u || u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'ads-partners.coupang.com') return u.pathname.startsWith('/image1/');
  return CDN_HOST_RE.test(h);
}

function parseUrl(s, base) {
  try { return new URL(s, base); } catch { return null; }
}

function fail(statusCode, msg) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    body: msg,
  };
}

async function discard(res) {
  try { if (res && res.body) await res.body.cancel(); } catch (e) { /* ignore */ }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'method not allowed');

  // 다른 사이트에서의 핫링크·교차 출처 호출 차단 (헤더가 없는 요청은 허용)
  const h = event.headers || {};
  const site = h['sec-fetch-site'] || h['Sec-Fetch-Site'];
  if (site && site !== 'same-origin') return fail(403, 'forbidden');

  const qs = event.queryStringParameters || {};
  const keys = Object.keys(qs);
  if (keys.length !== 1 || keys[0] !== 'u') return fail(400, 'bad query');
  let cur = parseUrl(qs.u);
  if (!cur || !isAllowedUrl(cur)) return fail(400, 'host not allowed');

  const signal = AbortSignal.timeout(TOTAL_TIMEOUT_MS); // 모든 hop과 본문 읽기가 공유
  try {
    let res = null;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      res = await fetch(cur.href, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; pet-img-proxy)', Accept: 'image/*' },
        signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await discard(res);
        const next = loc ? parseUrl(loc, cur) : null;
        if (!next || !isAllowedUrl(next)) return fail(400, 'redirect not allowed');
        if (i === MAX_REDIRECTS) return fail(502, 'too many redirects');
        cur = next;
        continue;
      }
      break;
    }
    if (!res.ok) {
      console.log(`img proxy upstream ${cur.hostname} status ${res.status}`);
      await discard(res);
      return fail(502, 'upstream error');
    }
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_TYPES.has(ct)) { await discard(res); return fail(415, 'not an allowed image type'); }
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    if (len > MAX_BYTES) { await discard(res); return fail(413, 'too large'); }

    // 스트리밍하며 누적 크기 검사
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { await reader.cancel().catch(() => {}); return fail(413, 'too large'); }
      chunks.push(Buffer.from(value));
    }
    return {
      statusCode: 200,
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=86400',
        'Netlify-CDN-Cache-Control': 'public, durable, max-age=86400',
        'Netlify-Vary': 'query=u',
        'X-Content-Type-Options': 'nosniff',
      },
      body: Buffer.concat(chunks).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.log(`img proxy fetch failed ${cur.hostname} ${err && err.name}`);
    return fail(502, 'fetch failed');
  }
};

exports.isAllowedUrl = isAllowedUrl;
