// GA4 Data API proxy for the dashboard.
// Required Netlify env:
// - GA4_PROPERTY_ID: numeric GA4 property id, not the measurement id
// - GOOGLE_SERVICE_ACCOUNT_JSON: full service account JSON
//   or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const TOKEN_SKEW_MS = 5 * 60 * 1000;
const REPORT_CACHE_MS = 60 * 1000;

let cachedToken = null;
let cachedTokenExpiresAt = 0;
const reportCache = new Map(); // key -> { expiresAt, payload }

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function getServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
    };
  }
  return {
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
    privateKey: process.env.GOOGLE_PRIVATE_KEY,
  };
}

function normalizePrivateKey(key) {
  return (key || '').replace(/\\n/g, '\n');
}

function createJwt(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsigned)
    .sign(normalizePrivateKey(privateKey), 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${unsigned}.${signature}`;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - TOKEN_SKEW_MS) {
    return cachedToken;
  }
  const { clientEmail, privateKey } = getServiceAccount();
  if (!clientEmail || !privateKey) {
    throw new Error('Missing Google service account credentials');
  }
  const assertion = createJwt(clientEmail, privateKey);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await res.json();
  if (!res.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || 'Failed to get Google access token');
  }
  cachedToken = payload.access_token;
  cachedTokenExpiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
  return cachedToken;
}

async function gaRequest(propertyId, method, body, token) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  if (!res.ok) {
    const msg = payload.error && payload.error.message ? payload.error.message : 'GA4 Data API error';
    throw new Error(msg);
  }
  return payload;
}

function metricValue(report, fallback = 0) {
  const value = report && report.rows && report.rows[0] && report.rows[0].metricValues
    ? report.rows[0].metricValues[0].value
    : null;
  return value == null ? fallback : Number(value);
}

function eventCounts(report) {
  const counts = { visit: 0, complete: 0, coupang_click: 0 };
  for (const row of report.rows || []) {
    const name = row.dimensionValues && row.dimensionValues[0] ? row.dimensionValues[0].value : '';
    const count = row.metricValues && row.metricValues[0] ? Number(row.metricValues[0].value) : 0;
    if (Object.prototype.hasOwnProperty.call(counts, name)) counts[name] = count;
  }
  return counts;
}

function isValidISO(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function resolveRange(params) {
  const period = (params.period || 'today').toLowerCase();
  const today = new Date();
  const fmt = d => {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  if (period === 'custom' && isValidISO(params.start) && isValidISO(params.end)) {
    return { startDate: params.start, endDate: params.end, label: '사용자 지정' };
  }
  if (period === 'week') {
    const s = new Date(today); s.setDate(today.getDate() - 6);
    return { startDate: fmt(s), endDate: fmt(today), label: '최근 7일' };
  }
  if (period === 'month') {
    const s = new Date(today); s.setDate(today.getDate() - 29);
    return { startDate: fmt(s), endDate: fmt(today), label: '최근 30일' };
  }
  return { startDate: fmt(today), endDate: fmt(today), label: '오늘' };
}

function buildDailySeries(dailyReport, range) {
  const map = {};
  for (const row of dailyReport.rows || []) {
    const date = row.dimensionValues && row.dimensionValues[0] ? row.dimensionValues[0].value : '';
    const users = row.metricValues && row.metricValues[0] ? Number(row.metricValues[0].value) : 0;
    if (date) {
      // GA4 dateDimension is YYYYMMDD - normalize to YYYY-MM-DD
      const iso = date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
      map[iso] = users;
    }
  }
  const out = [];
  const start = new Date(range.startDate + 'T00:00:00');
  const end = new Date(range.endDate + 'T00:00:00');
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const d = new Date(t);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    const iso = `${y}-${m}-${dd}`;
    out.push({ date: iso, users: map[iso] || 0 });
  }
  return out;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=30',
  };

  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'GA4_PROPERTY_ID is required',
        measurementId: 'G-HFQCEBY2PW',
      }),
    };
  }

  const params = (event && event.queryStringParameters) || {};
  const range = resolveRange(params);
  const cacheKey = `${range.startDate}_${range.endDate}`;

  try {
    const cached = reportCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ...cached.payload, cached: true }),
      };
    }

    const token = await getAccessToken();
    const dateRanges = [{ startDate: range.startDate, endDate: range.endDate }];

    const [realtimeReport, visitorsReport, eventsReport, dailyReport, cumulativeReport] = await Promise.all([
      gaRequest(propertyId, 'runRealtimeReport', { metrics: [{ name: 'activeUsers' }] }, token),
      gaRequest(propertyId, 'runReport', { dateRanges, metrics: [{ name: 'activeUsers' }] }, token),
      gaRequest(propertyId, 'runReport', {
        dateRanges,
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
          filter: {
            fieldName: 'eventName',
            inListFilter: { values: ['visit', 'complete', 'coupang_click'] },
          },
        },
      }, token),
      gaRequest(propertyId, 'runReport', {
        dateRanges,
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'activeUsers' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      }, token),
      // 누적: 사이트 launch 이후 (2년 백워드)
      gaRequest(propertyId, 'runReport', {
        dateRanges: [{ startDate: '730daysAgo', endDate: 'today' }],
        metrics: [{ name: 'totalUsers' }],
      }, token),
    ]);

    const counts = eventCounts(eventsReport);
    const visits = counts.visit || metricValue(visitorsReport);
    const completionRate = visits > 0 ? Math.round((counts.complete / visits) * 100) : 0;
    const daily = buildDailySeries(dailyReport, range);

    const payload = {
      source: 'ga4',
      measurementId: 'G-HFQCEBY2PW',
      period: params.period || 'today',
      periodLabel: range.label,
      dateRange: { start: range.startDate, end: range.endDate },
      realtimeUsers: metricValue(realtimeReport),
      todayVisitors: metricValue(visitorsReport),
      visitEvents: counts.visit,
      completions: counts.complete,
      completionRate,
      coupangClicks: counts.coupang_click,
      daily,
      totalVisitors: metricValue(cumulativeReport),
      cumulativeSince: '730일 전',
      updatedAt: new Date().toISOString(),
    };
    reportCache.set(cacheKey, { payload, expiresAt: Date.now() + REPORT_CACHE_MS });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...payload, cached: false }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
