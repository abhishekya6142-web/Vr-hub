// youtube-auth.ts
//
// Google Sign-In for the YouTube app inside VR Hub.
// Uses a POPUP window (not a full-page redirect) so the WebXR session
// in the main window is never interrupted.
//
// Flow:
// 1. openGoogleLoginPopup() opens a small popup pointed at Google's OAuth
//    consent screen.
// 2. User logs in + approves scopes.
// 3. Google redirects the POPUP to /api/auth-callback?code=...
// 4. auth-callback.js (serverless function) exchanges the code for tokens
//    using the client secret (server-side only, never exposed to browser)
//    and returns a small HTML page that does:
//       window.opener.postMessage({ type: 'YT_AUTH_SUCCESS', tokens }, ...)
//       window.close()
// 5. This file listens for that postMessage, stores tokens, and the
//    caller's onLogin callback fires.
//
// Tokens are stored in localStorage so login persists across reloads.
// Access tokens expire in ~1hr; refreshToken() is called automatically
// when an API call gets a 401.

const STORAGE_KEY = "vrhub_yt_auth";

// TODO: replace with your actual OAuth Client ID from Google Cloud Console
// (the "Web client 1" you already created).
const CLIENT_ID = "YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com";

// This must exactly match one of the "Authorized redirect URIs" you added
// in Google Cloud Console for that OAuth client.
const REDIRECT_URI = `${window.location.origin}/api/auth-callback`;

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/youtube.readonly",
].join(" ");

export interface YTAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // ms epoch
  id_token?: string;
}

export interface YTUserProfile {
  name: string;
  email: string;
  picture: string;
}

function saveTokens(tokens: YTAuthTokens) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

function loadTokens(): YTAuthTokens | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as YTAuthTokens;
  } catch {
    return null;
  }
}

export function clearAuth() {
  localStorage.removeItem(STORAGE_KEY);
}

export function isLoggedIn(): boolean {
  const t = loadTokens();
  return !!t?.access_token;
}

/**
 * Opens the Google consent screen in a popup window.
 * Resolves with tokens on success, rejects on failure/cancel.
 */
export function openGoogleLoginPopup(): Promise<YTAuthTokens> {
  return new Promise((resolve, reject) => {
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", SCOPES);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");

    const width = 480;
    const height = 640;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    const popup = window.open(
      authUrl.toString(),
      "vrhub_google_login",
      `width=${width},height=${height},left=${left},top=${top}`
    );

    if (!popup) {
      reject(new Error("Popup blocked. Please allow popups for this site."));
      return;
    }

    let settled = false;

    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (!event.data || event.data.type !== "YT_AUTH_SUCCESS") return;

      settled = true;
      window.removeEventListener("message", handleMessage);
      clearInterval(pollClosed);

      const tokens: YTAuthTokens = event.data.tokens;
      saveTokens(tokens);
      resolve(tokens);
    }

    window.addEventListener("message", handleMessage);

    // If the user closes the popup manually without completing login
    const pollClosed = window.setInterval(() => {
      if (popup.closed) {
        clearInterval(pollClosed);
        window.removeEventListener("message", handleMessage);
        if (!settled) {
          reject(new Error("Login cancelled."));
        }
      }
    }, 500);
  });
}

/**
 * Exchanges the refresh token for a new access token via the same
 * serverless function (it supports a ?refresh_token= mode too).
 */
async function refreshAccessToken(): Promise<YTAuthTokens | null> {
  const current = loadTokens();
  if (!current?.refresh_token) return null;

  const res = await fetch("/api/auth-callback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: current.refresh_token }),
  });

  if (!res.ok) return null;

  const data = await res.json();
  const tokens: YTAuthTokens = {
    access_token: data.access_token,
    refresh_token: current.refresh_token, // refresh token doesn't change
    expires_at: Date.now() + data.expires_in * 1000,
    id_token: data.id_token ?? current.id_token,
  };
  saveTokens(tokens);
  return tokens;
}

/**
 * Returns a valid access token, refreshing it first if it's expired
 * or about to expire. Returns null if the user isn't logged in.
 */
export async function getValidAccessToken(): Promise<string | null> {
  let tokens = loadTokens();
  if (!tokens) return null;

  const isExpiringSoon = tokens.expires_at - Date.now() < 60_000;
  if (isExpiringSoon) {
    tokens = await refreshAccessToken();
    if (!tokens) {
      clearAuth();
      return null;
    }
  }

  return tokens.access_token;
}

/**
 * Fetches basic profile info (name, email, picture) for the logged-in user.
 */
export async function fetchUserProfile(): Promise<YTUserProfile | null> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return null;

  const res = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;

  const data = await res.json();
  return { name: data.name, email: data.email, picture: data.picture };
}

/**
 * Helper for calling any YouTube Data API v3 endpoint with the user's
 * access token attached. Example:
 *   const subs = await ytApiFetch("subscriptions?part=snippet&mine=true&maxResults=25");
 */
export async function ytApiFetch(pathAndQuery: string): Promise<any | null> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return null;

  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/${pathAndQuery}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) return null;
  return res.json();
}

export function logout() {
  clearAuth();
}
