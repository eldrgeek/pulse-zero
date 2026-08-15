// review-demo.js — authenticated narrated-demo player (R2b evidence).
//
// Same owner gate as review-data.js / review-asset.js: a report card's demo
// narrates internal review detail, so it is never a static file under
// public/ — it lives base64-encoded in review-demos-files/manifest.json
// (packaged by review/package-demo.py from a _estate/bin/demo-record output)
// and is only ever returned to a verified owner request.
//
// GET ?list=1                -> JSON { demos: [{slug, date, caption, ...}] }
// GET ?slug=<slug>           -> the player.html content (base64, text/html)
const manifest = require('./review-demos-files/manifest.json');

const SUPABASE_URL = 'https://omfwcodoimjmbrhssvfl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_vi2qDWjozUJ5mi9dwirkLA_rj6UaqLf';
const ALLOWED_EMAILS = ['mw@mike-wolf.com', 'mw.personalmail@gmail.com'];

const jsonHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function errorResponse(statusCode, body) {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...jsonHeaders, 'Access-Control-Allow-Methods': 'GET, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return errorResponse(405, { error: 'GET only' });
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return errorResponse(401, { error: 'Sign in to Pulse first.' });
  }

  try {
    const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: authHeader },
    });
    if (!userResponse.ok) {
      return errorResponse(401, { error: 'Your Pulse session has expired.' });
    }
    const user = await userResponse.json();
    if (!ALLOWED_EMAILS.includes((user.email || '').toLowerCase())) {
      return errorResponse(403, { error: 'This board is private.' });
    }

    const params = event.queryStringParameters || {};
    if (params.list) {
      const demos = Object.values(manifest).map((d) => d.meta);
      return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ demos }) };
    }

    const slug = params.slug || '';
    if (!Object.prototype.hasOwnProperty.call(manifest, slug)) {
      return errorResponse(404, { error: 'Unknown demo.' });
    }
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/html',
        'Cache-Control': 'private, max-age=3600',
      },
      body: manifest[slug].html_b64,
      isBase64Encoded: true,
    };
  } catch (_) {
    return errorResponse(502, { error: 'Demo temporarily unavailable.' });
  }
};
