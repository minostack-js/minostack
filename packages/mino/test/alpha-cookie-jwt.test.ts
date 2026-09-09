import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import {
  parseCookie,
  serializeCookie,
  getCookie,
  setCookie,
  appendSetCookie,
  getSetCookies,
  signCookie,
  unsignCookie,
  createCookieSigner,
} from "../src/cookie.js";
import { BadRequestError, UnauthorizedError } from "../src/errors.js";
import { sign, verify, decode, jwt } from "../src/jwt.js";
import type { JwtJwk } from "../src/jwt.js";
import type { Handler } from "../src/types.js";

function appWith(mw: Handler): Mino {
  const app = new Mino();
  app.use(mw);
  return app;
}

async function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

// ─────────────────────────────────────────────────────────────────
// cookie
// ─────────────────────────────────────────────────────────────────

describe("alpha: parseCookie", () => {
  it("parses basic pairs", () => {
    expect(parseCookie("a=1; b=2")).toEqual({ a: "1", b: "2" });
  });

  it("trims, decodes, splits on first =, handles empties", () => {
    expect(parseCookie(undefined)).toEqual({});
    expect(parseCookie("")).toEqual({});
    expect(parseCookie("  n=hello%20world ; e=a=b ; flag ")).toEqual({
      n: "hello world",
      e: "a=b",
      flag: "",
    });
    // malformed percent-encoding falls back to raw, quoted values unquoted
    expect(parseCookie('q=%; w="hi"')).toEqual({ q: "%", w: "hi" });
  });

  it("rejects more than 100 cookies with 400", () => {
    const header = Array.from({ length: 101 }, (_, i) => `c${i}=v`).join("; ");
    try {
      parseCookie(header);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestError);
      expect((e as BadRequestError).status).toBe(400);
    }
  });

  it("rejects values over 8kb with 400", () => {
    try {
      parseCookie(`big=${"x".repeat(8193)}`);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestError);
      expect((e as BadRequestError).status).toBe(400);
    }
    expect(parseCookie(`ok=${"y".repeat(8192)}`)["ok"]?.length).toBe(8192);
  });
});

describe("alpha: serializeCookie", () => {
  it("round-trips special chars through parseCookie", () => {
    const value = "a b/c+d=%;ü";
    const s = serializeCookie("sess", value, { path: "/" });
    const back = parseCookie(s.split(";")[0] as string);
    expect(back["sess"]).toBe(value);
  });

  it("emits attributes", () => {
    const s = serializeCookie("id", "7", {
      path: "/",
      domain: "example.com",
      maxAge: 60,
      expires: new Date("2030-01-01T00:00:00.000Z"),
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    });
    for (const frag of [
      "id=7",
      "Path=/",
      "Domain=example.com",
      "Max-Age=60",
      "Expires=Tue, 01 Jan 2030",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
    ]) {
      expect(s).toContain(frag);
    }
    expect(serializeCookie("p", "1", { partitioned: true })).toContain("Partitioned");
    // partitioned implies Secure for browser acceptance
    expect(serializeCookie("p", "1", { partitioned: true })).toContain("Secure");
  });

  it("rejects bad names and options with 400", () => {
    for (const bad of ["", "a;b", "a\x01b", "a\x7fb"]) {
      expect(() => serializeCookie(bad, "v")).toThrowError(BadRequestError);
    }
    expect(() => serializeCookie("ok", "v", { maxAge: -1 })).toThrowError(BadRequestError);
    expect(() => serializeCookie("ok", "v", { sameSite: "X" as never })).toThrowError(
      BadRequestError,
    );
  });
});

describe("alpha: signed cookies", () => {
  it("sign/unsign round-trips", async () => {
    const signed = await signCookie("hello.world", "top-secret");
    expect(signed.startsWith("hello.world.")).toBe(true);
    await expect(unsignCookie(signed, "top-secret")).resolves.toBe("hello.world");
  });

  it("rejects tampered values, forged sigs, wrong secrets, malformed input", async () => {
    const signed = await signCookie("abc", "s1");
    const [val, sig] = signed.split(".") as [string, string];
    await expect(unsignCookie(`${val}x.${sig}`, "s1")).resolves.toBeNull();
    await expect(unsignCookie(`${val}.${sig}x`, "s1")).resolves.toBeNull();
    await expect(unsignCookie(signed, "other")).resolves.toBeNull();
    await expect(unsignCookie("no-dot-here", "s1")).resolves.toBeNull();
    await expect(unsignCookie("a.", "s1")).resolves.toBeNull();
  });

  it("createCookieSigner binds one secret", async () => {
    const signer = createCookieSigner("k");
    const signed = await signer.sign("v");
    await expect(signer.unsign(signed)).resolves.toBe("v");
    await expect(signer.unsign(signed + "tamper")).resolves.toBeNull();
  });
});

describe("alpha: getCookie/setCookie over Mino", () => {
  it("setCookie appends two cookies instead of overwriting", async () => {
    const app = new Mino();
    app.get("/", (c) => {
      setCookie(c, "a", "1", { path: "/" });
      setCookie(c, "b", "2", { path: "/" });
      return c.text("ok");
    });
    const res = await fetchVia(app, "/");
    expect(res.status).toBe(200);
    const set = getSetCookies(res.headers);
    expect(set.length).toBe(2);
    expect(set[0]).toContain("a=1");
    expect(set[1]).toContain("b=2");
  });

  it("setCookie also works with raw Response returns", async () => {
    const app = new Mino();
    app.get("/", (c) => {
      setCookie(c, "a", "1", { path: "/" });
      return new Response("hi");
    });
    const res = await fetchVia(app, "/");
    expect(getSetCookies(res.headers).length).toBe(1);
  });

  it("getCookie reads the request cookie", async () => {
    const app = new Mino();
    app.get("/", (c) => c.text(getCookie(c, "theme") ?? "none"));
    const res = await fetchVia(app, "/", { headers: { cookie: "theme=dark; other=1" } });
    expect(await res.text()).toBe("dark");
    const missing = await fetchVia(app, "/");
    expect(await missing.text()).toBe("none");
  });

  it("appendSetCookie util appends on plain Headers", () => {
    const h = new Headers();
    appendSetCookie(h, "a=1; Path=/");
    appendSetCookie(h, "b=2; Path=/");
    expect(getSetCookies(h)).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("skips empty segments and nameless pairs", () => {
    expect(parseCookie("a=1;;=noname; ;b=2")).toEqual({ a: "1", b: "2" });
  });

  it("rejects bad Domain/Path/Expires", () => {
    expect(() => serializeCookie("x", "v", { domain: "a;b" })).toThrowError(BadRequestError);
    expect(() => serializeCookie("x", "v", { domain: "" })).toThrowError(BadRequestError);
    expect(() => serializeCookie("x", "v", { path: "/a\r\nb" })).toThrowError(BadRequestError);
    expect(() => serializeCookie("x", "v", { expires: new Date("nope") })).toThrowError(
      BadRequestError,
    );
  });

  it("getSetCookies falls back without getSetCookie()", () => {
    const stub = (v: string | null) => ({ get: (_n: string) => v }) as unknown as Headers;
    expect(getSetCookies(stub(null))).toEqual([]);
    expect(getSetCookies(stub("a=1"))).toEqual(["a=1"]);
  });

  it("setCookie appends after next() when middleware returns the response", async () => {
    const app = new Mino();
    app.use(async (c, next) => {
      await next();
      setCookie(c, "late", "1", { path: "/" });
      const res = c.res;
      if (res) return res;
    });
    app.get("/", (c) => {
      setCookie(c, "early", "1", { path: "/" });
      return c.text("ok");
    });
    const res = await fetchVia(app, "/");
    const set = getSetCookies(res.headers);
    expect(set.length).toBe(2);
    expect(set[0]).toContain("early=1");
    expect(set[1]).toContain("late=1");
  });

  it("rejects signatures with non-base64url chars", async () => {
    await expect(unsignCookie("v.!!!", "s")).resolves.toBeNull();
  });

  it("supports Uint8Array secrets and dotted values", async () => {
    const sec = new TextEncoder().encode("u8-secret");
    const signed = await signCookie("dotted.value.here", sec);
    await expect(unsignCookie(signed, sec)).resolves.toBe("dotted.value.here");
  });
});

// ─────────────────────────────────────────────────────────────────
// jwt
// ─────────────────────────────────────────────────────────────────

describe("alpha: jwt HS256", () => {
  it("sign/verify round-trips the payload", async () => {
    const token = await sign({ sub: "u1", role: "admin" }, "s3cret");
    const payload = await verify(token, "s3cret");
    expect(payload["sub"]).toBe("u1");
    expect(payload["role"]).toBe("admin");
  });

  it("rejects tampered tokens with 401", async () => {
    const token = await sign({ sub: "u1" }, "s3cret");
    const parts = token.split(".");
    const badPayload = `${parts[0]}X.${parts[1]}.${parts[2]}`;
    await expect(verify(badPayload, "s3cret")).rejects.toBeInstanceOf(UnauthorizedError);
    const badSig = `${parts[0]}.${parts[1]}.AAAA`;
    await expect(verify(badSig, "s3cret")).rejects.toMatchObject({ status: 401 });
    await expect(verify(token, "wrong")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(verify("not.a", "s3cret")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects expired tokens, accepts fresh ones", async () => {
    const expired = await sign({ sub: "u1" }, "s3cret", { expiresInSec: -10 });
    await expect(verify(expired, "s3cret")).rejects.toThrowError(/expired/i);
    const fresh = await sign({ sub: "u1" }, "s3cret", { expiresInSec: 3600 });
    await expect(verify(fresh, "s3cret")).resolves.toMatchObject({ sub: "u1" });
  });

  it("honors clock tolerance, nbf, issuer and audience", async () => {
    const skewed = await sign({ sub: "u1" }, "s3cret", { expiresInSec: -5 });
    await expect(verify(skewed, "s3cret", { clockToleranceSec: 30 })).resolves.toMatchObject({
      sub: "u1",
    });
    const future = await sign({ sub: "u1", nbf: Math.floor(Date.now() / 1000) + 3600 }, "s3cret");
    await expect(verify(future, "s3cret")).rejects.toBeInstanceOf(UnauthorizedError);
    const scoped = await sign({ sub: "u1", iss: "mino", aud: "api" }, "s3cret");
    await expect(
      verify(scoped, "s3cret", { issuer: "mino", audience: "api" }),
    ).resolves.toMatchObject({ sub: "u1" });
    await expect(verify(scoped, "s3cret", { issuer: "other" })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(verify(scoped, "s3cret", { audience: "web" })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});

describe("alpha: jwt RS256/ES256", () => {
  it("RS256 round-trips via generated keys", async () => {
    const subtle = globalThis.crypto.subtle;
    const { publicKey, privateKey } = (await subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const token = await sign({ sub: "rsa-user" }, privateKey, { alg: "RS256" });
    await expect(verify(token, publicKey)).resolves.toMatchObject({ sub: "rsa-user" });
    // raw secrets must not verify RS256 tokens (alg confusion guard)
    await expect(verify(token, "s3cret")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("ES256 round-trips via generated keys", async () => {
    const subtle = globalThis.crypto.subtle;
    const { publicKey, privateKey } = (await subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const token = await sign({ sub: "ec-user" }, privateKey, { alg: "ES256" });
    await expect(verify(token, publicKey)).resolves.toMatchObject({ sub: "ec-user" });
  });

  it("decode returns header+payload without verifying", async () => {
    const token = await sign({ sub: "u9" }, "s3cret");
    const { header, payload } = decode(token);
    expect(header.alg).toBe("HS256");
    expect(payload["sub"]).toBe("u9");
    // tampered signature still decodes (no verification performed)
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.AAAA`;
    expect(decode(tampered).payload["sub"]).toBe("u9");
    expect(() => decode("bogus")).toThrowError();
  });
});

describe("alpha: jwt middleware", () => {
  it("returns 401 JSON on missing/malformed/bad tokens without reaching handlers", async () => {
    let reached = 0;
    const app = appWith(jwt({ secret: "s3cret" }));
    app.get("/me", (c) => {
      reached++;
      return c.text("ok");
    });
    for (const headers of [
      undefined,
      { authorization: "Bearer garbage" },
      { authorization: "Token abc" },
    ]) {
      const res = await fetchVia(app, "/me", headers ? { headers } : undefined);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ status: 401, code: "unauthorized" });
    }
    expect(reached).toBe(0);
  });

  it("sets jwtPayload on good tokens", async () => {
    const app = appWith(jwt({ secret: "s3cret" }));
    app.get("/me", (c) => c.json({ sub: (c.get("jwtPayload") as { sub: string }).sub }));
    const token = await sign({ sub: "u1" }, "s3cret", { expiresInSec: 3600 });
    const res = await fetchVia(app, "/me", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: "u1" });
  });

  it("reads the token from a cookie when configured", async () => {
    const app = appWith(jwt({ secret: "s3cret", cookie: "token" }));
    app.get("/me", (c) => c.json({ sub: (c.get("jwtPayload") as { sub: string }).sub }));
    const token = await sign({ sub: "cookie-user" }, "s3cret");
    const res = await fetchVia(app, "/me", { headers: { cookie: `token=${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: "cookie-user" });
    // cookie present but name missing, no header fallback → 401
    const miss = await fetchVia(app, "/me", { headers: { cookie: "other=1" } });
    expect(miss.status).toBe(401);
    // poisoned cookie header (over caps) → 401, never reaches handlers
    const evil = Array.from({ length: 101 }, (_, i) => `c${i}=v`).join("; ");
    const bad = await fetchVia(app, "/me", { headers: { cookie: evil } });
    expect(bad.status).toBe(401);
  });

  it("matches JWKS keys by kid", async () => {
    const subtle = globalThis.crypto.subtle;
    const { publicKey, privateKey } = (await subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pubJwk = (await subtle.exportKey("jwk", publicKey)) as unknown as JwtJwk;
    const app = appWith(jwt({ jwks: { keys: [{ ...pubJwk, kid: "k1" }] }, alg: "RS256" }));
    app.get("/me", (c) => c.json({ sub: (c.get("jwtPayload") as { sub: string }).sub }));
    const good = await sign({ sub: "jwks-user" }, privateKey, { alg: "RS256", kid: "k1" });
    const okRes = await fetchVia(app, "/me", { headers: { authorization: `Bearer ${good}` } });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ sub: "jwks-user" });
    const wrongKid = await sign({ sub: "x" }, privateKey, { alg: "RS256", kid: "nope" });
    const badRes = await fetchVia(app, "/me", {
      headers: { authorization: `Bearer ${wrongKid}` },
    });
    expect(badRes.status).toBe(401);
    // undecodable token never reaches verify
    const garbage = await fetchVia(app, "/me", { headers: { authorization: "Bearer garbage" } });
    expect(garbage.status).toBe(401);
  });

  it("uses the single JWKS key when the token has no kid", async () => {
    const subtle = globalThis.crypto.subtle;
    const { publicKey, privateKey } = (await subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pubJwk = (await subtle.exportKey("jwk", publicKey)) as unknown as JwtJwk;
    const single = appWith(jwt({ jwks: { keys: [pubJwk] } }));
    single.get("/me", (c) => c.json({ sub: (c.get("jwtPayload") as { sub: string }).sub }));
    const token = await sign({ sub: "kidless" }, privateKey, { alg: "RS256" });
    const okRes = await fetchVia(single, "/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(okRes.status).toBe(200);
    // several keys and no kid → cannot choose → 401
    const multi = appWith(jwt({ jwks: { keys: [pubJwk, { ...pubJwk }] } }));
    multi.get("/me", (c) => c.text("ok"));
    const amb = await fetchVia(multi, "/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(amb.status).toBe(401);
  });

  it("rejects non-P-256 EC keys and honors middleware alg pins", async () => {
    const subtle = globalThis.crypto.subtle;
    const { privateKey } = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const token = await sign({ sub: "ec" }, privateKey, { alg: "ES256" });
    const badCurve = appWith(jwt({ key: { kty: "EC", crv: "P-384", x: "x", y: "y" } }));
    badCurve.get("/me", (c) => c.text("ok"));
    expect(
      (await fetchVia(badCurve, "/me", { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
    // middleware alg pin rejects other algorithms
    const rsa = (await subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pinned = appWith(jwt({ key: rsa.publicKey, alg: "HS256" }));
    pinned.get("/me", (c) => c.text("ok"));
    const rsaToken = await sign({ sub: "x" }, rsa.privateKey, { alg: "RS256" });
    expect(
      (await fetchVia(pinned, "/me", { headers: { authorization: `Bearer ${rsaToken}` } })).status,
    ).toBe(401);
  });
});

describe("alpha: jwt edges", () => {
  const b64u = (s: string): string =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  it("sign validates its inputs", async () => {
    await expect(sign(null as never, "s")).rejects.toThrowError(/object/);
    await expect(sign([1] as never, "s")).rejects.toThrowError(/object/);
    await expect(sign({ sub: "x" }, "s", { expiresInSec: NaN })).rejects.toThrowError(/finite/);
    await expect(sign({ sub: "x" }, "rawsecret", { alg: "RS256" })).rejects.toThrowError(
      /requires a CryptoKey or JWK/,
    );
  });

  it("verify rejects malformed structure and algorithms", async () => {
    const good = await sign({ sub: "u1" }, "s3cret");
    const [h, p] = good.split(".") as [string, string];
    // non-object header / array payload / null parts
    await expect(verify(`${b64u('"str"')}.${p}.x`, "s3cret")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(verify(`${h}.${b64u("[1,2]")}.x`, "s3cret")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(verify(`${b64u("null")}.${p}.x`, "s3cret")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(verify(`${h}.${b64u("null")}.x`, "s3cret")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    // undecodable JSON and bad signature encoding
    await expect(verify("aaaa.bbbb.cccc", "s3cret")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(verify(`${h}.${p}.!!!`, "s3cret")).rejects.toBeInstanceOf(UnauthorizedError);
    // alg allow-list and 'none'
    await expect(verify(good, "s3cret", { algorithms: ["RS256"] })).rejects.toThrowError(
      /Unexpected algorithm/,
    );
    await expect(verify(good, "s3cret", { algorithms: ["HS256"] })).resolves.toMatchObject({
      sub: "u1",
    });
    await expect(verify(`${b64u('{"alg":"none"}')}.${p}.x`, "s3cret")).rejects.toThrowError(
      /Unsupported algorithm/,
    );
    // unusable key object surfaces as invalid signature
    await expect(verify(good, {} as unknown as never)).rejects.toThrowError(/Invalid signature/);
  });

  it("verify enforces JWK key-type match", async () => {
    const subtle = globalThis.crypto.subtle;
    const { publicKey } = (await subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const rsaJwk = (await subtle.exportKey("jwk", publicKey)) as unknown as JwtJwk;
    const hs = await sign({ sub: "u1" }, "s3cret");
    await expect(verify(hs, rsaJwk)).rejects.toThrowError(/Key type mismatch/);
  });

  it("verify validates claim shapes", async () => {
    await expect(verify(await sign({ exp: "tomorrow" }, "s3cret"), "s3cret")).rejects.toThrowError(
      /Invalid exp/,
    );
    await expect(verify(await sign({ nbf: "soon" }, "s3cret"), "s3cret")).rejects.toThrowError(
      /Invalid nbf/,
    );
    await expect(verify(await sign({ iat: "x" }, "s3cret"), "s3cret")).rejects.toThrowError(
      /Invalid iat/,
    );
    const futureIat = await sign({ iat: Math.floor(Date.now() / 1000) + 3600 }, "s3cret");
    await expect(verify(futureIat, "s3cret")).rejects.toThrowError(/Invalid iat/);
  });

  it("supports issuer/audience arrays and Uint8Array secrets", async () => {
    const scoped = await sign({ sub: "u1", iss: "mino", aud: ["api", "web"] }, "s3cret");
    await expect(
      verify(scoped, "s3cret", { issuer: ["other", "mino"], audience: "web" }),
    ).resolves.toMatchObject({ sub: "u1" });
    const sec = new TextEncoder().encode("u8-secret");
    const token = await sign({ sub: "u8" }, sec);
    await expect(verify(token, sec)).resolves.toMatchObject({ sub: "u8" });
  });

  it("supports oct JWK keys interchangeably with raw secrets", async () => {
    // k = base64url("s3cret")
    const jwk: JwtJwk = { kty: "oct", k: "czNjcmV0" };
    const viaJwk = await sign({ sub: "j" }, jwk);
    await expect(verify(viaJwk, "s3cret")).resolves.toMatchObject({ sub: "j" });
    const viaRaw = await sign({ sub: "r" }, "s3cret");
    await expect(verify(viaRaw, jwk)).resolves.toMatchObject({ sub: "r" });
  });

  it("decode rejects malformed tokens", () => {
    expect(() => decode("aaaa.bbbb.cccc")).toThrowError(/Invalid token format/);
    expect(() => decode(`${b64u("null")}.${b64u("{}")}.x`)).toThrowError(/Invalid token format/);
    expect(() => decode(`${b64u("{}")}.${b64u("null")}.x`)).toThrowError(/Invalid token format/);
  });
});
