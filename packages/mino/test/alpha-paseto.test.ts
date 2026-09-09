import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { token } from "../src/jwt.js";
import { sign as jwtSign } from "../src/jwt.js";
import {
  blake2b,
  pae,
  bytesToBase64Url,
  base64UrlToBytes,
  encrypt,
  decrypt,
  sign,
  verify,
  generateLocalKey,
  generatePublicKeypair,
  paseto,
  xchacha20,
} from "../src/paseto.js";

const SYM_KEY = "707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f";
const ZERO_NONCE = new Uint8Array(32);
const FIXED_NONCE = "df654812bac492663825520ba2f6e67cf5ca5bdc13d4e7507a98cc4c2fcc3ad8";
const KID_FOOTER = '{"kid":"zVhMiPBP9fRf2snEcT7gFTioeA9COcNy9DfgL1W60haN"}';
const ED_SECRET =
  "b4cbfb43df4ce210727d953e4a713307fa19bb7d9f85041438d9e11b942a37741eb9dbbbbc047c03fd70604e0071f0987e16b28b757225c11f00415d0e20b1a2";
const ED_PUBLIC = "1eb9dbbbbc047c03fd70604e0071f0987e16b28b757225c11f00415d0e20b1a2";

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const dec = new TextDecoder();

describe("paseto: primitives", () => {
  it("BLAKE2b('abc') matches the reference digest", () => {
    const d = blake2b(new TextEncoder().encode("abc")).subarray(0, 32);
    expect(Buffer.from(d).toString("hex")).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1",
    );
  });

  it("PAE encodes count + length-prefixed pieces", () => {
    const out = pae([new TextEncoder().encode("a"), new TextEncoder().encode("bc")]);
    const dv = new DataView(out.buffer);
    expect(dv.getBigUint64(0, true)).toBe(2n);
    expect(dv.getBigUint64(8, true)).toBe(1n);
    expect(dec.decode(out.subarray(16, 17))).toBe("a");
    expect(dv.getBigUint64(17, true)).toBe(2n);
    expect(dec.decode(out.subarray(25, 27))).toBe("bc");
  });

  it("base64url rejects padding and garbage", () => {
    expect(() => base64UrlToBytes("ab==")).toThrow();
    expect(() => base64UrlToBytes("a")).toThrow();
    expect(bytesToBase64Url(new Uint8Array([251, 255]))).toBe(
      "+_8".replace("+", "-").replace("/", "_"),
    );
  });
});

describe("paseto: official v4.local vectors", () => {
  const payload = '{"data":"this is a secret message","exp":"2022-01-01T00:00:00+00:00"}';

  it("4-E-1 zero-nonce encrypt reproduces the token", async () => {
    expect(await encrypt(hex(SYM_KEY), payload, { nonce: ZERO_NONCE })).toBe(
      "v4.local.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAr68PS4AXe7If_ZgesdkUMvSwscFlAl1pk5HC0e8kApeaqMfGo_7OpBnwJOAbY9V7WU6abu74MmcUE8YWAiaArVI8XJ5hOb_4v9RmDkneN0S92dx0OW4pgy7omxgf3S8c3LlQg",
    );
  });

  it("4-E-3 fixed-nonce encrypt reproduces the token", async () => {
    expect(await encrypt(hex(SYM_KEY), payload, { nonce: hex(FIXED_NONCE) })).toBe(
      "v4.local.32VIErrEkmY4JVILovbmfPXKW9wT1OdQepjMTC_MOtjA4kiqw7_tcaOM5GNEcnTxl60WkwMsYXw6FSNb_UdJPXjpzm0KW9ojM5f4O2mRvE2IcweP-PRdoHjd5-RHCiExR1IK6t6-tyebyWG6Ov7kKvBdkrrAJ837lKP3iDag2hzUPHuMKA",
    );
  });

  it("4-E-5 footer vector reproduces", async () => {
    expect(
      await encrypt(hex(SYM_KEY), payload, { nonce: hex(FIXED_NONCE), footer: KID_FOOTER }),
    ).toBe(
      "v4.local.32VIErrEkmY4JVILovbmfPXKW9wT1OdQepjMTC_MOtjA4kiqw7_tcaOM5GNEcnTxl60WkwMsYXw6FSNb_UdJPXjpzm0KW9ojM5f4O2mRvE2IcweP-PRdoHjd5-RHCiExR1IK6t4x-RMNXtQNbz7FvFZ_G-lFpk5RG3EOrwDL6CgDqcerSQ.eyJraWQiOiJ6VmhNaVBCUDlmUmYyc25FY1Q3Z0ZUaW9lQTlDT2NOeTlEZmdMMVc2MGhhTiJ9",
    );
  });

  it("4-E-7 footer + assertion vector reproduces", async () => {
    const tok = await encrypt(hex(SYM_KEY), payload, {
      nonce: hex(FIXED_NONCE),
      footer: KID_FOOTER,
      assertion: '{"test-vector":"4-E-7"}',
    });
    expect(tok).toBe(
      "v4.local.32VIErrEkmY4JVILovbmfPXKW9wT1OdQepjMTC_MOtjA4kiqw7_tcaOM5GNEcnTxl60WkwMsYXw6FSNb_UdJPXjpzm0KW9ojM5f4O2mRvE2IcweP-PRdoHjd5-RHCiExR1IK6t40KCCWLA7GYL9KFHzKlwY9_RnIfRrMQpueydLEAZGGcA.eyJraWQiOiJ6VmhNaVBCUDlmUmYyc25FY1Q3Z0ZUaW9lQTlDT2NOeTlEZmdMMVc2MGhhTiJ9",
    );
  });

  it("4-E-9 non-JSON footer + assertion decrypts", async () => {
    const tok =
      "v4.local.32VIErrEkmY4JVILovbmfPXKW9wT1OdQepjMTC_MOtjA4kiqw7_tcaOM5GNEcnTxl60WiA8rd3wgFSNb_UdJPXjpzm0KW9ojM5f4O2mRvE2IcweP-PRdoHjd5-RHCiExR1IK6t6tybdlmnMwcDMw0YxA_gFSE_IUWl78aMtOepFYSWYfQA.YXJiaXRyYXJ5LXN0cmluZy10aGF0LWlzbid0LWpzb24";
    const raw = await decrypt(hex(SYM_KEY), tok, {
      footer: "arbitrary-string-that-isn't-json",
      assertion: '{"test-vector":"4-E-9"}',
    });
    expect(dec.decode(raw)).toContain("hidden message");
  });

  it("4-E vectors decrypt back to payload", async () => {
    const raw = await decrypt(
      hex(SYM_KEY),
      "v4.local.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAr68PS4AXe7If_ZgesdkUMvSwscFlAl1pk5HC0e8kApeaqMfGo_7OpBnwJOAbY9V7WU6abu74MmcUE8YWAiaArVI8XJ5hOb_4v9RmDkneN0S92dx0OW4pgy7omxgf3S8c3LlQg",
    );
    expect(dec.decode(raw)).toBe(payload);
  });
});

describe("paseto: official v4.public vectors", () => {
  const payload = '{"data":"this is a signed message","exp":"2022-01-01T00:00:00+00:00"}';

  it("4-S-1 sign reproduces the token", async () => {
    expect(await sign(hex(ED_SECRET), payload)).toBe(
      "v4.public.eyJkYXRhIjoidGhpcyBpcyBhIHNpZ25lZCBtZXNzYWdlIiwiZXhwIjoiMjAyMi0wMS0wMVQwMDowMDowMCswMDowMCJ9bg_XBBzds8lTZShVlwwKSgeKpLT3yukTw6JUz3W4h_ExsQV-P0V54zemZDcAxFaSeef1QlXEFtkqxT1ciiQEDA",
    );
  });

  it("4-S-2 footer sign reproduces the token", async () => {
    expect(await sign(hex(ED_SECRET), payload, { footer: KID_FOOTER })).toBe(
      "v4.public.eyJkYXRhIjoidGhpcyBpcyBhIHNpZ25lZCBtZXNzYWdlIiwiZXhwIjoiMjAyMi0wMS0wMVQwMDowMDowMCswMDowMCJ9v3Jt8mx_TdM2ceTGoqwrh4yDFn0XsHvvV_D0DtwQxVrJEBMl0F2caAdgnpKlt4p7xBnx1HcO-SPo8FPp214HDw.eyJraWQiOiJ6VmhNaVBCUDlmUmYyc25FY1Q3Z0ZUaW9lQTlDT2NOeTlEZmdMMVc2MGhhTiJ9",
    );
  });

  it("4-S-3 footer + assertion sign reproduces the token", async () => {
    expect(
      await sign(hex(ED_SECRET), payload, {
        footer: KID_FOOTER,
        assertion: '{"test-vector":"4-S-3"}',
      }),
    ).toBe(
      "v4.public.eyJkYXRhIjoidGhpcyBpcyBhIHNpZ25lZCBtZXNzYWdlIiwiZXhwIjoiMjAyMi0wMS0wMVQwMDowMDowMCswMDowMCJ9NPWciuD3d0o5eXJXG5pJy-DiVEoyPYWs1YSTwWHNJq6DZD3je5gf-0M4JR9ipdUSJbIovzmBECeaWmaqcaP0DQ.eyJraWQiOiJ6VmhNaVBCUDlmUmYyc25FY1Q3Z0ZUaW9lQTlDT2NOeTlEZmdMMVc2MGhhTiJ9",
    );
  });

  it("4-S vectors verify back to payload", async () => {
    const raw = await verify(
      hex(ED_PUBLIC),
      "v4.public.eyJkYXRhIjoidGhpcyBpcyBhIHNpZ25lZCBtZXNzYWdlIiwiZXhwIjoiMjAyMi0wMS0wMVQwMDowMDowMCswMDowMCJ9bg_XBBzds8lTZShVlwwKSgeKpLT3yukTw6JUz3W4h_ExsQV-P0V54zemZDcAxFaSeef1QlXEFtkqxT1ciiQEDA",
    );
    expect(dec.decode(raw)).toBe(payload);
  });
});

describe("paseto: official failure vectors", () => {
  it("4-F-1 v4.local token fails under the symmetric key and as public", async () => {
    const tok =
      "v4.local.vngXfCISbnKgiP6VWGuOSlYrFYU300fy9ijW33rznDYgxHNPwWluAY2Bgb0z54CUs6aYYkIJ-bOOOmJHPuX_34Agt_IPlNdGDpRdGNnBz2MpWJvB3cttheEc1uyCEYltj7wBQQYX.YXJiaXRyYXJ5LXN0cmluZy10aGF0LWlzbid0LWpzb24";
    await expect(
      decrypt(hex(SYM_KEY), tok, {
        footer: "arbitrary-string-that-isn't-json",
        assertion: '{"test-vector":"4-F-1"}',
      }),
    ).rejects.toThrow();
    await expect(verify(hex(ED_PUBLIC), tok)).rejects.toThrow();
  });

  it("4-F-2 tampered public token fails", async () => {
    await expect(
      verify(
        hex(ED_PUBLIC),
        "v4.public.eyJpbnZhbGlkIjoidGhpcyBzaG91bGQgbmV2ZXIgZGVjb2RlIn22Sp4gjCaUw0c7EH84ZSm_jN_Qr41MrgLNu5LIBCzUr1pn3Z-Wukg9h3ceplWigpoHaTLcwxj0NsI1vjTh67YB.eyJraWQiOiJ6VmhNaVBCUDlmUmYyc25FY1Q3Z0ZUaW9lQTlDT2NOeTlEZmdMMVc2MGhhTiJ9",
        { footer: KID_FOOTER, assertion: '{"test-vector":"4-F-2"}' },
      ),
    ).rejects.toThrow();
  });

  it("4-F-3 wrong-version token fails", async () => {
    await expect(
      decrypt(
        hex(SYM_KEY),
        "v3.local.23e_2PiqpQBPvRFKzB0zHhjmxK3sKo2grFZRRLM-U7L0a8uHxuF9RlVz3Ic6WmdUUWTxCaYycwWV1yM8gKbZB2JhygDMKvHQ7eBf8GtF0r3K0Q_gF1PXOxcOgztak1eD1dPe9rLVMSgR0nHJXeIGYVuVrVoLWQ.YXJiaXRyYXJ5LXN0cmluZy10aGF0LWlzbid0LWpzb24",
        { footer: "arbitrary-string-that-isn't-json", assertion: '{"test-vector":"4-F-3"}' },
      ),
    ).rejects.toThrow();
  });

  it("4-F-4 truncated token fails", async () => {
    await expect(
      decrypt(
        hex(SYM_KEY),
        "v4.local.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAr68PS4AXe7If_ZgesdkUMvSwscFlAl1pk5HC0e8kApeaqMfGo_7OpBnwJOAbY9V7WU6abu74MmcUE8YWAiaArVI8XJ5hOb_4v9RmDkneN0S92dx0OW4pgy7omxgf3S8c3LlQh",
      ),
    ).rejects.toThrow();
  });

  it("4-F-5 padded-base64 token fails", async () => {
    await expect(
      decrypt(
        hex(SYM_KEY),
        "v4.local.32VIErrEkmY4JVILovbmfPXKW9wT1OdQepjMTC_MOtjA4kiqw7_tcaOM5GNEcnTxl60WkwMsYXw6FSNb_UdJPXjpzm0KW9ojM5f4O2mRvE2IcweP-PRdoHjd5-RHCiExR1IK6t4x-RMNXtQNbz7FvFZ_G-lFpk5RG3EOrwDL6CgDqcerSQ==.eyJraWQiOiJ6VmhNaVBCUDlmUmYyc25FY1Q3Z0ZUaW9lQTlDT2NOeTlEZmdMMVc2MGhhTiJ9",
        { footer: KID_FOOTER, assertion: '{"test-vector":"4-F-5"}' },
      ),
    ).rejects.toThrow();
  });
});

describe("paseto: round-trips and keys", () => {
  it("local encrypt→decrypt round-trips with footer + assertion", async () => {
    const key = generateLocalKey();
    expect(key.length).toBe(32);
    const tok = await encrypt(key, '{"sub":"u1"}', { footer: "f", assertion: "i" });
    expect(tok.startsWith("v4.local.")).toBe(true);
    expect(dec.decode(await decrypt(key, tok, { footer: "f", assertion: "i" }))).toBe(
      '{"sub":"u1"}',
    );
  });

  it("wrong key, tampered token, missing footer all fail", async () => {
    const key = generateLocalKey();
    const tok = await encrypt(key, "hello", { footer: "f" });
    await expect(decrypt(generateLocalKey(), tok, { footer: "f" })).rejects.toThrow();
    await expect(decrypt(key, tok.slice(0, -2) + "xx", { footer: "f" })).rejects.toThrow();
    await expect(decrypt(key, tok)).rejects.toThrow();
    await expect(decrypt(key, tok, { footer: "other" })).rejects.toThrow();
  });

  it("keypair generation signs and verifies", async () => {
    const kp = await generatePublicKeypair();
    expect(kp.secretKey.length).toBe(64);
    expect(kp.publicKey.length).toBe(32);
    const tok = await sign(kp.secretKey, '{"sub":"u2"}');
    expect(tok.startsWith("v4.public.")).toBe(true);
    expect(dec.decode(await verify(kp.publicKey, tok))).toBe('{"sub":"u2"}');
  });

  it("bad key lengths fail closed", async () => {
    await expect(encrypt(new Uint8Array(16), "x")).rejects.toThrow();
    await expect(decrypt(new Uint8Array(16), "v4.local.abc")).rejects.toThrow();
    await expect(sign(new Uint8Array(32), "x")).rejects.toThrow();
    await expect(verify(new Uint8Array(16), "v4.public.abc")).rejects.toThrow();
  });
});

describe("paseto: middleware", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;

  it("local mode decrypts, checks exp, and sets payload", async () => {
    const key = generateLocalKey();
    const app = new Mino();
    app.use(paseto({ secret: key }));
    app.get("/me", (c) => c.json({ sub: (c.get("pasetoPayload") as { sub: string }).sub }));
    const good = await encrypt(key, JSON.stringify({ sub: "u1", exp: future }));
    const res = await app.fetch(
      new Request("http://localhost/me", { headers: { authorization: `Bearer ${good}` } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sub: "u1" });
    const expired = await encrypt(key, JSON.stringify({ sub: "u1", exp: 1 }));
    const r2 = await app.fetch(
      new Request("http://localhost/me", { headers: { authorization: `Bearer ${expired}` } }),
    );
    expect(r2.status).toBe(401);
  });

  it("public mode verifies and rejects foreign keys", async () => {
    const kp = await generatePublicKeypair();
    const other = await generatePublicKeypair();
    const app = new Mino();
    app.use(paseto({ publicKey: kp.publicKey }));
    app.get("/me", (c) => c.text("ok"));
    const good = await sign(kp.secretKey, JSON.stringify({ sub: "u1" }));
    expect(
      (
        await app.fetch(
          new Request("http://localhost/me", { headers: { authorization: `Bearer ${good}` } }),
        )
      ).status,
    ).toBe(200);
    const bad = await sign(other.secretKey, JSON.stringify({ sub: "u1" }));
    expect(
      (
        await app.fetch(
          new Request("http://localhost/me", { headers: { authorization: `Bearer ${bad}` } }),
        )
      ).status,
    ).toBe(401);
    expect((await app.fetch(new Request("http://localhost/me"))).status).toBe(401);
  });
});

describe("token: switchable jwt/paseto middleware", () => {
  const JWT_SECRET = "switch-test-secret-1234567890";

  function buildApp(mode?: "auto" | "jwt" | "paseto", only?: "jwt" | "paseto"): Mino {
    const app = new Mino();
    const key = generateLocalKey();
    (app as unknown as { __k?: Uint8Array }).__k = key;
    app.use(
      token({
        ...(mode !== undefined ? { mode } : {}),
        ...(only !== "paseto" ? { jwt: { secret: JWT_SECRET } } : {}),
        ...(only !== "jwt" ? { paseto: { secret: key } } : {}),
      }),
    );
    app.get("/who", (c) =>
      c.json({
        via: c.get("tokenPayload") === c.get("jwtPayload") ? "jwt" : "paseto",
        sub: (c.get("tokenPayload") as { sub: string }).sub,
      }),
    );
    return app;
  }

  async function keyOf(app: Mino): Promise<Uint8Array> {
    return (app as unknown as { __k: Uint8Array }).__k;
  }

  it("auto routes jwt and paseto tokens to their verifier", async () => {
    const app = buildApp();
    const key = await keyOf(app);
    const jt = await jwtSign({ sub: "j" }, JWT_SECRET);
    const pt = await encrypt(key, JSON.stringify({ sub: "p" }));
    const rj = await app.fetch(
      new Request("http://localhost/who", { headers: { authorization: `Bearer ${jt}` } }),
    );
    expect(rj.status).toBe(200);
    expect(await rj.json()).toMatchObject({ via: "jwt", sub: "j" });
    const rp = await app.fetch(
      new Request("http://localhost/who", { headers: { authorization: `Bearer ${pt}` } }),
    );
    expect(rp.status).toBe(200);
    expect(await rp.json()).toMatchObject({ via: "paseto", sub: "p" });
  });

  it("pinned modes reject the other format; missing side 401s", async () => {
    const appJwt = buildApp("jwt");
    const key = await keyOf(appJwt);
    const pt = await encrypt(key, JSON.stringify({ sub: "p" }));
    expect(
      (
        await appJwt.fetch(
          new Request("http://localhost/who", { headers: { authorization: `Bearer ${pt}` } }),
        )
      ).status,
    ).toBe(401);
    const appPaseto = buildApp("paseto");
    const jt = await jwtSign({ sub: "j" }, JWT_SECRET);
    expect(
      (
        await appPaseto.fetch(
          new Request("http://localhost/who", { headers: { authorization: `Bearer ${jt}` } }),
        )
      ).status,
    ).toBe(401);
    const appOnlyJwt = buildApp("auto", "jwt");
    expect(
      (
        await appOnlyJwt.fetch(
          new Request("http://localhost/who", { headers: { authorization: `Bearer ${pt}` } }),
        )
      ).status,
    ).toBe(401);
    expect((await appOnlyJwt.fetch(new Request("http://localhost/who"))).status).toBe(401);
  });

  it("construction without either side throws", () => {
    expect(() => token({})).toThrow();
  });
});

describe("paseto: edge guards", () => {
  it("primitive guards fail closed", () => {
    expect(() => blake2b(new Uint8Array(1), new Uint8Array(0), 0)).toThrow();
    expect(() => blake2b(new Uint8Array(1), new Uint8Array(0), 65)).toThrow();
    expect(() => blake2b(new Uint8Array(1), new Uint8Array(129))).toThrow();
    expect(() => xchacha20(new Uint8Array(1), new Uint8Array(1), new Uint8Array(32))).toThrow();
    expect(() => xchacha20(new Uint8Array(1), new Uint8Array(24), new Uint8Array(1))).toThrow();
    expect(() => base64UrlToBytes("a b")).toThrow();
    expect(() => base64UrlToBytes("abcd=")).toThrow();
    expect(pae([]).length).toBe(8);
  });

  it("protocol guards fail closed", async () => {
    const key = generateLocalKey();
    await expect(encrypt("nope" as unknown as Uint8Array, "x")).rejects.toThrow();
    await expect(encrypt(key, "x", { nonce: new Uint8Array(1) })).rejects.toThrow();
    await expect(decrypt(key, 42 as unknown as string)).rejects.toThrow();
    await expect(decrypt(key, "v4.local.abc")).rejects.toThrow();
    await expect(decrypt(key, "v4.public.abc")).rejects.toThrow();
    await expect(sign("nope" as unknown as Uint8Array, "x")).rejects.toThrow();
    await expect(verify("nope" as unknown as Uint8Array, "v4.public.abc")).rejects.toThrow();
    await expect(verify(generateLocalKey(), "v4.local.abc")).rejects.toThrow();
    const kp = await generatePublicKeypair();
    const short = await sign(kp.secretKey, "x");
    await expect(verify(kp.publicKey, short.slice(0, 20))).rejects.toThrow();
  });

  it("middleware rejects malformed inputs with 401", async () => {
    const key = generateLocalKey();
    const app = new Mino();
    app.use(paseto({ secret: key, cookie: "tok" }));
    app.get("/m", (c) => c.text("ok"));
    const bad = async (headers: Record<string, string>, cookie?: string): Promise<number> => {
      const h: Record<string, string> = { ...headers };
      if (cookie !== undefined) h["cookie"] = cookie;
      return (await app.fetch(new Request("http://localhost/m", { headers: h }))).status;
    };
    expect(await bad({})).toBe(401);
    expect(await bad({ authorization: "Token abc" })).toBe(401);
    expect(await bad({}, "tok=%zz")).toBe(401);
    expect(await bad({}, "other=1")).toBe(401);
    const nonJson = await encrypt(key, "plain-bytes-not-json");
    expect(await bad({ authorization: `Bearer ${nonJson}` })).toBe(401);
    const arr = await encrypt(key, "[1,2]");
    expect(await bad({ authorization: `Bearer ${arr}` })).toBe(401);
  });

  it("middleware enforces iss/aud and cookie extraction", async () => {
    const key = generateLocalKey();
    const app = new Mino();
    app.use(paseto({ secret: key, cookie: "tok", issuer: "me", audience: "you" }));
    app.get("/m", (c) => c.text("ok"));
    const good = await encrypt(key, JSON.stringify({ sub: "u", iss: "me", aud: "you" }));
    expect(
      (await app.fetch(new Request("http://localhost/m", { headers: { cookie: `tok=${good}` } })))
        .status,
    ).toBe(200);
    const badIss = await encrypt(key, JSON.stringify({ sub: "u", iss: "them", aud: "you" }));
    expect(
      (await app.fetch(new Request("http://localhost/m", { headers: { cookie: `tok=${badIss}` } })))
        .status,
    ).toBe(401);
    const badAud = await encrypt(key, JSON.stringify({ sub: "u", iss: "me", aud: ["them"] }));
    expect(
      (
        await app.fetch(
          new Request("http://localhost/m", { headers: { authorization: `Bearer ${badAud}` } }),
        )
      ).status,
    ).toBe(401);
    const badExp = await encrypt(key, JSON.stringify({ exp: "tomorrow" }));
    expect(
      (
        await app.fetch(
          new Request("http://localhost/m", { headers: { authorization: `Bearer ${badExp}` } }),
        )
      ).status,
    ).toBe(401);
    const futureNbf = await encrypt(
      key,
      JSON.stringify({ nbf: Math.floor(Date.now() / 1000) + 3600 }),
    );
    expect(
      (
        await app.fetch(
          new Request("http://localhost/m", { headers: { authorization: `Bearer ${futureNbf}` } }),
        )
      ).status,
    ).toBe(401);
    const badNbfType = await encrypt(key, JSON.stringify({ nbf: "soon" }));
    expect(
      (
        await app.fetch(
          new Request("http://localhost/m", { headers: { authorization: `Bearer ${badNbfType}` } }),
        )
      ).status,
    ).toBe(401);
    const futureIat = await encrypt(
      key,
      JSON.stringify({ iat: Math.floor(Date.now() / 1000) + 3600 }),
    );
    expect(
      (
        await app.fetch(
          new Request("http://localhost/m", { headers: { authorization: `Bearer ${futureIat}` } }),
        )
      ).status,
    ).toBe(401);
  });

  it("paseto middleware requires a key and accepts array issuers", async () => {
    expect(() => paseto({})).toThrow();
    const key = generateLocalKey();
    const app = new Mino();
    app.use(paseto({ secret: key, issuer: ["me", "them"] }));
    app.get("/m", (c) => c.text("ok"));
    const tok = await encrypt(key, JSON.stringify({ iss: "them" }));
    expect(
      (
        await app.fetch(
          new Request("http://localhost/m", { headers: { authorization: `Bearer ${tok}` } }),
        )
      ).status,
    ).toBe(200);
  });

  it("token() honors header/cookie overrides", async () => {
    const key = generateLocalKey();
    const app = new Mino();
    app.use(token({ paseto: { secret: key }, header: "x-token", cookie: "tok" }));
    app.get("/m", (c) => c.text((c.get("tokenPayload") as { sub: string }).sub));
    const tok = await encrypt(key, JSON.stringify({ sub: "z" }));
    const r1 = await app.fetch(
      new Request("http://localhost/m", { headers: { "x-token": `Bearer ${tok}` } }),
    );
    expect(r1.status).toBe(200);
    expect(await r1.text()).toBe("z");
    const r2 = await app.fetch(
      new Request("http://localhost/m", { headers: { cookie: `tok=${tok}` } }),
    );
    expect(r2.status).toBe(200);
  });
});
