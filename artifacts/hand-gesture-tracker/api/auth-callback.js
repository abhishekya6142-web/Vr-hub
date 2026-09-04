// api/auth-callback.js
//
// Vercel serverless function. Handles two things:
//
// 1. GET  /api/auth-callback?code=...
//    Google redirects the POPUP window here after login/consent.
//    We exchange the code for tokens (using the CLIENT_SECRET, which stays
//    server-side only) and return a tiny HTML page that posts the tokens
//    back to the main window via postMessage, then closes itself.
//
// 2. POST /api/auth-callback   { refresh_token }
//    Called from the frontend to silently refresh an expired access token.
//    Returns { access_token, expires_in, id_token }.
//
// Environment variables required (set in Vercel Project Settings):
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

function getRedirectUri(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}/api/auth-callback`;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return handleCodeExchange(req, res);
  }
  if (req.method === "POST") {
    return handleRefresh(req, res);
  }
  res.status(405).send("Method not allowed");
}

async function handleCodeExchange(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.status(200).send(popupResultHtml({ error }));
  }
  if (!code) {
    return res.status(400).send("Missing code");
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: getRedirectUri(req),
        grant_type: "authorization_code",
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      return res
        .status(200)
        .send(popupResultHtml({ error: tokenData.error_description || "token_exchange_failed" }));
    }

    const tokens = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + tokenData.expires_in * 1000,
      id_token: tokenData.id_token,
    };

    return res.status(200).send(popupResultHtml({ tokens }));
  } catch (err) {
    return res.status(200).send(popupResultHtml({ error: "server_error" }));
  }
}

async function handleRefresh(req, res) {
  const { refresh_token } = req.body || {};
  if (!refresh_token) {
    return res.status(400).json({ error: "Missing refresh_token" });
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "refresh_token",
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      return res.status(401).json({ error: tokenData.error || "refresh_failed" });
    }

    return res.status(200).json({
      access_token: tokenData.access_token,
      expires_in: tokenData.expires_in,
      id_token: tokenData.id_token,
    });
  } catch (err) {
    return res.status(500).json({ error: "server_error" });
  }
}

// Small HTML page returned inside the popup. It relays the result to the
// opener window (the main VR Hub tab) and then closes itself.
function popupResultHtml({ tokens, error }) {
  const payload = error
    ? { type: "YT_AUTH_ERROR", error }
    : { type: "YT_AUTH_SUCCESS", tokens };

  return `<!DOCTYPE html>
<html>
  <body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee;">
    <p>${error ? "Login failed. You can close this window." : "Login successful. Closing..."}</p>
    <script>
      if (window.opener) {
        window.opener.postMessage(${JSON.stringify(payload)}, window.location.origin);
      }
      setTimeout(() => window.close(), ${error ? 2000 : 400});
    </script>
  </body>
</html>`;
}
