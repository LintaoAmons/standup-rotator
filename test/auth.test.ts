// The password gate. These run under vitest's Node runtime, where globalThis
// .crypto.subtle is the same Web Crypto the Worker uses — so the constant-time
// compare, token derivation and cookie handling are exercised for real, no fake.

import { describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  constantTimeEqual,
  isAuthed,
  readCookie,
  sessionToken,
  setSessionCookie,
  SESSION_COOKIE,
  verifyPassword,
} from "../src/auth";

const SECRET = "correct horse battery staple";

// reqWithCookie builds a Request carrying a single session cookie value.
function reqWithCookie(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) headers.set("Cookie", `${SESSION_COOKIE}=${value}; other=x`);
  return new Request("https://example.com/", { headers });
}

describe("constantTimeEqual", () => {
  it("true for identical strings", async () => {
    expect(await constantTimeEqual("abc", "abc")).toBe(true);
  });
  it("false for different strings of equal length", async () => {
    expect(await constantTimeEqual("abc", "abd")).toBe(false);
  });
  it("false for different lengths", async () => {
    expect(await constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("verifyPassword", () => {
  it("accepts the correct password", async () => {
    expect(await verifyPassword(SECRET, SECRET)).toBe(true);
  });
  it("rejects a wrong password", async () => {
    expect(await verifyPassword(SECRET, "wrong")).toBe(false);
  });
  it("fails closed when APP_PASSWORD is unset (nobody can log in)", async () => {
    expect(await verifyPassword(undefined, "anything")).toBe(false);
    expect(await verifyPassword("", "")).toBe(false);
  });
});

describe("sessionToken", () => {
  it("is deterministic for a secret", async () => {
    expect(await sessionToken(SECRET)).toBe(await sessionToken(SECRET));
  });
  it("differs across secrets, so rotating the password invalidates old cookies", async () => {
    expect(await sessionToken(SECRET)).not.toBe(await sessionToken(SECRET + "!"));
  });
  it("is empty when unconfigured", async () => {
    expect(await sessionToken(undefined)).toBe("");
  });
  it("is not the password itself", async () => {
    expect(await sessionToken(SECRET)).not.toContain(SECRET);
  });
});

describe("isAuthed", () => {
  it("accepts a request whose cookie holds the derived token", async () => {
    const token = await sessionToken(SECRET);
    expect(await isAuthed(reqWithCookie(token), SECRET)).toBe(true);
  });
  it("rejects a forged / wrong token", async () => {
    expect(await isAuthed(reqWithCookie("deadbeef"), SECRET)).toBe(false);
  });
  it("rejects a token derived from a different password", async () => {
    const stale = await sessionToken(SECRET);
    expect(await isAuthed(reqWithCookie(stale), SECRET + "rotated")).toBe(false);
  });
  it("rejects a request with no cookie", async () => {
    expect(await isAuthed(reqWithCookie(null), SECRET)).toBe(false);
  });
  it("fails closed when unconfigured", async () => {
    const token = await sessionToken(SECRET);
    expect(await isAuthed(reqWithCookie(token), undefined)).toBe(false);
  });
});

describe("cookie header", () => {
  it("readCookie round-trips the value set by setSessionCookie", async () => {
    const token = await sessionToken(SECRET);
    const setCookie = setSessionCookie(token);
    // Set-Cookie is "name=value; attrs" — the Request Cookie header is "name=value".
    const value = setCookie.split(";")[0].split("=").slice(1).join("=");
    expect(readCookie(reqWithCookie(value), SESSION_COOKIE)).toBe(token);
  });
  it("setSessionCookie is HttpOnly, Secure, SameSite=Lax", () => {
    const c = setSessionCookie("t");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
  });
  it("clearSessionCookie expires the cookie immediately", () => {
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });
});
