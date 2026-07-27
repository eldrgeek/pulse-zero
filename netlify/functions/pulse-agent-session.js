// Authenticated ElevenLabs session broker for Pulse.
//
// The browser sends its existing Supabase access token. We verify that token
// with Supabase and require an allowlisted Mike identity before using the
// server-only ElevenLabs API key to mint a short-lived signed WebSocket URL.
const SUPABASE_URL = 'https://omfwcodoimjmbrhssvfl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_vi2qDWjozUJ5mi9dwirkLA_rj6UaqLf';
const AGENT_ID = 'agent_9901kxk0yphafwrvpes82h4me49n';
// Both of Mike's identities: the magic-link address and the Google account
// "Continue with Google" returns. Mirror of public.is_pulse_owner() in
// supabase/migrations/20260727_google_signin_owner_emails.sql.
const ALLOWED_EMAILS = ['mw@mike-wolf.com', 'mw.personalmail@gmail.com'];

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function response(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return response(405, { error: 'GET only' });
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return response(401, { error: 'Sign in to Pulse first.' });
  }

  const elevenKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenKey) {
    return response(503, { error: 'Pulse voice is not configured.' });
  }

  try {
    const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: authHeader,
      },
    });
    if (!userResponse.ok) {
      return response(401, { error: 'Your Pulse session has expired.' });
    }
    const user = await userResponse.json();
    if (!ALLOWED_EMAILS.includes((user.email || '').toLowerCase())) {
      return response(403, { error: 'This Pulse is private.' });
    }

    const signedResponse = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(AGENT_ID)}`,
      { headers: { 'xi-api-key': elevenKey } },
    );
    if (!signedResponse.ok) {
      return response(502, { error: 'Pulse voice authorization is temporarily unavailable.' });
    }
    const signed = await signedResponse.json();
    if (!signed.signed_url) {
      return response(502, { error: 'Pulse voice authorization returned no session.' });
    }
    return response(200, { signed_url: signed.signed_url });
  } catch (_) {
    return response(502, { error: 'Pulse voice authorization is temporarily unavailable.' });
  }
};
