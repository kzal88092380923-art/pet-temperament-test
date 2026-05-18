// 쿠팡 파트너스 Deeplink Conversion API 프록시
// 일반 쿠팡 URL(검색·상품·카테고리) → 파트너스 affiliate 링크로 일괄 변환
// POST { urls: [string, ...] }  →  { links: { [originalUrl]: partnerUrl } }

const crypto = require('crypto');

const COUPANG_HOST = 'api-gateway.coupang.com';
const DEEPLINK_PATH = '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';

function coupangDatetime() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return (
    String(d.getUTCFullYear()).slice(2) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

function sign(method, path, query, datetime, secretKey) {
  const message = datetime + method + path + (query || '');
  return crypto.createHmac('sha256', secretKey).update(message).digest('hex');
}

function isAllowedCoupangUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return [
      'www.coupang.com',
      'm.coupang.com',
      'link.coupang.com',
      'coupa.ng',
    ].includes(url.hostname);
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  const accessKey = process.env.COUPANG_ACCESS_KEY;
  const secretKey = process.env.COUPANG_SECRET_KEY;
  if (!accessKey || !secretKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Coupang API keys not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid JSON' }) }; }

  let urls = (body.urls || []).filter(u => typeof u === 'string' && isAllowedCoupangUrl(u));
  if (urls.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'urls array required' }) };
  }
  // 쿠팡 Deeplink API는 한 번에 다수 URL 지원, 안전하게 20개 제한
  urls = urls.slice(0, 20);

  const datetime = coupangDatetime();
  const signature = sign('POST', DEEPLINK_PATH, '', datetime, secretKey);
  const authorization = `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;

  try {
    const res = await fetch(`https://${COUPANG_HOST}${DEEPLINK_PATH}`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coupangUrls: urls }),
    });
    const text = await res.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }

    if (!res.ok || (payload.rCode && payload.rCode !== '0')) {
      return {
        statusCode: res.status || 502,
        headers,
        body: JSON.stringify({
          error: 'Coupang API error',
          status: res.status,
          rCode: payload.rCode,
          rMessage: payload.rMessage || payload.raw,
        }),
      };
    }

    const data = payload.data || [];
    const map = {};
    for (const item of data) {
      if (item && item.originalUrl) {
        map[item.originalUrl] = item.shortenUrl || item.landingUrl || item.originalUrl;
      }
    }

    return {
      statusCode: 200,
      headers: { ...headers, 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({ links: map, count: data.length }),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'fetch failed', message: err.message }) };
  }
};
