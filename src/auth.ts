// The password gate. One shared password, held only as the Worker secret
// APP_PASSWORD; this module never sees the plaintext except transiently on a
// login POST. No user model, no recovery — deliberately minimal (master's brief).
//
// Two crypto facts drive the shape here:
//   1. Comparisons are constant-time. A naive `a === b` on a secret leaks its
//      length and prefix through timing. Web Crypto has no timingSafeEqual, so we
//      use the canonical double-HMAC trick: HMAC both sides under a random
//      per-call key and compare the two 32-byte MACs. An attacker can't predict a
//      MAC, so a plain byte loop over the MACs leaks nothing about the inputs.
//   2. The session cookie is a bearer token DERIVED from the secret, never the
//      password itself. token = HMAC-SHA256(APP_PASSWORD, SESSION_LABEL). A client
//      that logged in holds this token; nobody can forge it without APP_PASSWORD.
//      Rotating APP_PASSWORD changes the derived token, so old cookies stop
//      validating for free — no session store to purge.

const SESSION_LABEL = "standup-session-v1";
export const SESSION_COOKIE = "sr_session";

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(keyBytes: Uint8Array | string, data: string): Promise<ArrayBuffer> {
  const raw = typeof keyBytes === "string" ? enc.encode(keyBytes) : keyBytes;
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", key, enc.encode(data));
}

// constantTimeEqual compares two strings without leaking their contents through
// timing. Double-HMAC under a fresh random key: the MACs are equal iff the inputs
// are, and are otherwise unpredictable, so the final byte loop is safe to run in
// variable time. Length differences are absorbed because both MACs are 32 bytes.
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  // generateKey is typed CryptoKey | CryptoKeyPair; HMAC always yields a single
  // symmetric CryptoKey, so the narrowing cast is safe.
  const key = (await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])) as CryptoKey;
  const macA = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(a)));
  const macB = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < macA.length; i++) diff |= macA[i] ^ macB[i];
  return diff === 0;
}

// sessionToken derives the bearer token from the secret. Absent/blank secret
// yields "" — see isConfigured/verifyPassword: an unconfigured gate fails closed
// (nobody can log in) rather than open.
export async function sessionToken(secret: string | undefined): Promise<string> {
  if (!secret) return "";
  return toHex(await hmac(secret, SESSION_LABEL));
}

// verifyPassword is the login check: constant-time compare of the submitted
// password against the secret. False when the gate is unconfigured.
export async function verifyPassword(
  secret: string | undefined,
  candidate: string,
): Promise<boolean> {
  if (!secret) return false;
  return constantTimeEqual(secret, candidate);
}

// isAuthed decides whether a request already holds a valid session. It compares
// the cookie's token against the freshly-derived expected token in constant time.
export async function isAuthed(req: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return false;
  return constantTimeEqual(token, await sessionToken(secret));
}

// readCookie pulls one cookie value out of the Cookie header. No dependency on a
// cookie library — the gate needs exactly one cookie.
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// SESSION_MAX_AGE bounds how long a login lasts before the browser drops the
// cookie. 30 days is a convenience window, not a security boundary — rotating
// APP_PASSWORD invalidates every outstanding cookie immediately regardless.
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

// setSessionCookie / clearSessionCookie build the Set-Cookie header value.
// HttpOnly (no JS access), Secure (HTTPS only — workers.dev is always TLS),
// SameSite=Lax (survives top-level navigation, blocks cross-site POST CSRF).
export function setSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
