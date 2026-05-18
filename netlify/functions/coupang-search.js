// 쿠팡 파트너스 Product Search API 프록시
// HMAC-SHA256 서명 후 호출 → 결과를 클라이언트에 반환
// 환경변수 (Netlify): COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY

const crypto = require('crypto');

const COUPANG_HOST = 'api-gateway.coupang.com';
const SEARCH_PATH = '/v2/providers/affiliate_open_api/apis/openapi/v1/products/search';

// 쿠팡 서명용 datetime: YYMMDDTHHmmssZ (UTC)
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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const accessKey = process.env.COUPANG_ACCESS_KEY;
  const secretKey = process.env.COUPANG_SECRET_KEY;
  if (!accessKey || !secretKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Coupang API keys not configured' }),
    };
  }

  const params = event.queryStringParameters || {};
  const keyword = (params.keyword || '').trim();
  const limit = Math.min(parseInt(params.limit || '5', 10) || 5, 20);
  if (!keyword) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'keyword is required' }),
    };
  }

  const query = `keyword=${encodeURIComponent(keyword)}&limit=${limit}`;
  const datetime = coupangDatetime();
  const signature = sign('GET', SEARCH_PATH, query, datetime, secretKey);
  const authorization = `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;

  try {
    const res = await fetch(`https://${COUPANG_HOST}${SEARCH_PATH}?${query}`, {
      method: 'GET',
      headers: { Authorization: authorization },
    });
    const text = await res.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }

    if (!res.ok || payload.rCode && payload.rCode !== '0') {
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

    const items = (payload.data && payload.data.productData) || [];
    const products = items.map(p => ({
      id: p.productId,
      name: p.productName,
      price: p.productPrice,
      image: p.productImage,
      url: p.productUrl,
      category: p.categoryName,
      isRocket: p.isRocket,
      isFreeShipping: p.isFreeShipping,
    }));

    return {
      statusCode: 200,
      headers: { ...headers, 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({ keyword, products }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'fetch failed', message: err.message }),
    };
  }
};
