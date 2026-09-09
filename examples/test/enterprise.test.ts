import { describe, it, expect } from "vitest";
import {
  app as saas,
  authedFetch,
  kernelCanReadBilling,
  principalFor,
} from "../src/enterprise-saas.js";
import {
  app as versioned,
  document,
  compatReport,
  additiveOnly,
} from "../src/enterprise-versioned-api.js";
import {
  resilientGet,
  upstreamCalls,
  breaker,
  app as proxyApp,
} from "../src/enterprise-resilient-upstream.js";
import { signup, sentEmails, auditEvents } from "../src/enterprise-background.js";
import { config, redacted, findUser, dbReads } from "../src/enterprise-config-cache.js";

describe("enterprise examples", () => {
  it("saas: tenant isolation over HTTP and Kernel guards", async () => {
    expect((await authedFetch("acme-key", "/billing")).status).toBe(200);
    expect((await authedFetch("globex-key", "/billing")).status).toBe(403);
    expect((await authedFetch("nope", "/billing")).status).toBe(401);
    expect(await kernelCanReadBilling(principalFor("acme-key"))).toBe(true);
    expect(await kernelCanReadBilling(principalFor("globex-key"))).toBe(false);
    expect(await kernelCanReadBilling(undefined)).toBe(false);
    void saas;
  });

  it("versioned-api: coexistence, sunset, docs, compat", async () => {
    const v1 = await versioned.fetch(new Request("http://localhost/v1/users"));
    expect(v1.status).toBe(200);
    expect(v1.headers.get("sunset")).toBe("2027-01-01");
    expect(v1.headers.get("link")).toBe('</v2/users>; rel="successor-version"');
    expect((await versioned.fetch(new Request("http://localhost/v2/users"))).status).toBe(200);
    expect(document.paths["/v1/users"]?.get?.deprecated).toBe(true);
    expect(compatReport.additive).toContain("added GET /v2/users");
    expect(additiveOnly).toContain("added GET /v2/users");
  });

  it("resilient-upstream: retry then success; proxy allowlist holds", async () => {
    const res = await resilientGet("https://upstream.example.com/users");
    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(3);
    expect(breaker.getState()).toBe("closed");
    const proxied = await proxyApp.fetch(new Request("http://localhost/upstream/a"));
    expect(proxied.status).toBe(200);
  });

  it("background: event → job → audit", async () => {
    await signup("1", "ada@example.com");
    expect(sentEmails).toEqual(["ada@example.com"]);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({ type: "job.completed", job: "welcome-email" });
  });

  it("config-cache: validated config, masked secrets, cache-aside", async () => {
    expect(config.port).toBe(3000);
    expect(redacted.dbUrl).toBe("***");
    expect(JSON.stringify(redacted)).not.toContain("s3cret");
    const before = dbReads;
    expect(await findUser("1")).toEqual({ id: "1", name: "Ada" });
    expect(await findUser("1")).toEqual({ id: "1", name: "Ada" });
    expect(dbReads).toBe(before + 1);
  });
});
