import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  PushNotificationStore,
  computeImportance,
} from "../src/push-notifications.js";
import type { PushNotificationConfig, DecayConfig } from "../src/push-notifications.js";

// ---------------------------------------------------------------------------
// Unit tests — PushNotificationStore in-memory lifecycle
// ---------------------------------------------------------------------------

describe("PushNotificationStore", () => {
  let store: PushNotificationStore;

  beforeEach(() => {
    store = new PushNotificationStore();
  });

  it("register + get returns the config", () => {
    const config: PushNotificationConfig = { url: "https://example.com/hook" };
    store.register("task-1", config);
    const result = store.get("task-1");
    assert.ok(result);
    assert.equal(result.url, "https://example.com/hook");
  });

  it("register sets createdAt as ISO 8601 UTC string (A2A v1.0 spec §10)", () => {
    // Per the A2A v1.0 spec, timestamps are explicit ISO 8601 UTC with
    // millisecond precision in the form `YYYY-MM-DDTHH:mm:ss.sssZ`.
    // https://github.com/a2aproject/A2A/blob/main/docs/whats-new-v1.md#timestamps
    const before = Date.now();
    store.register("task-iso", { url: "https://example.com/hook" });
    const after = Date.now();
    const config = store.get("task-iso");
    assert.ok(config?.createdAt, "createdAt should be set on register");
    // Shape check: `YYYY-MM-DDTHH:mm:ss.sssZ` (24 chars).
    assert.match(
      config.createdAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      "createdAt must match ISO 8601 ms-precision UTC format",
    );
    // Round-trip check: Date.parse should yield a valid ms timestamp
    // within the register call window.
    const ms = Date.parse(config.createdAt);
    assert.ok(Number.isFinite(ms), "createdAt must be parseable by Date.parse");
    assert.ok(ms >= before && ms <= after, "createdAt ms must be within register window");
  });

  it("register preserves caller-provided createdAt as ISO 8601 string", () => {
    const ts = "2026-08-09T19:30:00.000Z";
    store.register("task-provided", { url: "https://example.com/hook", createdAt: ts });
    const config = store.get("task-provided");
    assert.equal(config?.createdAt, ts);
  });

  it("has returns true for registered tasks", () => {
    store.register("task-1", { url: "https://example.com/hook" });
    assert.equal(store.has("task-1"), true);
    assert.equal(store.has("task-2"), false);
  });

  it("unregister removes the registration", () => {
    store.register("task-1", { url: "https://example.com/hook" });
    store.unregister("task-1");
    assert.equal(store.has("task-1"), false);
    assert.equal(store.get("task-1"), undefined);
  });

  it("unregister on non-existent task is a no-op", () => {
    store.unregister("nonexistent");
    assert.equal(store.size, 0);
  });

  it("size tracks active registrations", () => {
    assert.equal(store.size, 0);
    store.register("task-1", { url: "https://a.com" });
    store.register("task-2", { url: "https://b.com" });
    assert.equal(store.size, 2);
    store.unregister("task-1");
    assert.equal(store.size, 1);
  });

  it("register overwrites existing config for same taskId", () => {
    store.register("task-1", { url: "https://old.com" });
    store.register("task-1", { url: "https://new.com" });
    assert.equal(store.size, 1);
    assert.equal(store.get("task-1")?.url, "https://new.com");
  });

  it("send returns error when no registration exists", async () => {
    const result = await store.send("unknown-task", "completed", { id: "x" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "no registration");
  });
});

// ---------------------------------------------------------------------------
// Event filtering
// ---------------------------------------------------------------------------

describe("PushNotificationStore event filtering", () => {
  let store: PushNotificationStore;
  let webhookServer: http.Server;
  let webhookPort: number;
  let receivedRequests: Array<{ body: string; headers: http.IncomingHttpHeaders }>;

  beforeEach(async () => {
    store = new PushNotificationStore();
    receivedRequests = [];

    await new Promise<void>((resolve) => {
      webhookServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          receivedRequests.push({ body, headers: req.headers });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      webhookServer.listen(0, "127.0.0.1", () => {
        const addr = webhookServer.address() as { port: number };
        webhookPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      webhookServer.close(() => resolve());
    });
  });

  it("sends notification for matching event", async () => {
    store.register("task-1", {
      url: `http://127.0.0.1:${webhookPort}/hook`,
      events: ["completed"],
    });
    const result = await store.send("task-1", "completed", { id: "task-1", status: "completed" });
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
    assert.equal(receivedRequests.length, 1);
  });

  it("does NOT send notification for non-matching event", async () => {
    store.register("task-2", {
      url: `http://127.0.0.1:${webhookPort}/hook`,
      events: ["completed"],  // Only "completed"
    });
    const result = await store.send("task-2", "failed", { id: "task-2", status: "failed" });
    assert.equal(result.ok, false);
    assert.match(result.error!, /filtered out/);
    assert.equal(receivedRequests.length, 0);
  });

  it("sends for all terminal events when no filter specified", async () => {
    for (const state of ["completed", "failed", "canceled"]) {
      const taskId = `task-${state}`;
      store.register(taskId, {
        url: `http://127.0.0.1:${webhookPort}/hook`,
        // No events filter — default: all terminal states
      });
      const result = await store.send(taskId, state, { id: taskId });
      assert.equal(result.ok, true, `expected ok for ${state}`);
    }
    assert.equal(receivedRequests.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Webhook POST format
// ---------------------------------------------------------------------------

describe("PushNotificationStore webhook POST format", () => {
  let store: PushNotificationStore;
  let webhookServer: http.Server;
  let webhookPort: number;
  let receivedRequests: Array<{ body: string; headers: http.IncomingHttpHeaders }>;

  beforeEach(async () => {
    store = new PushNotificationStore();
    receivedRequests = [];

    await new Promise<void>((resolve) => {
      webhookServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          receivedRequests.push({ body, headers: req.headers });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ received: true }));
        });
      });
      webhookServer.listen(0, "127.0.0.1", () => {
        const addr = webhookServer.address() as { port: number };
        webhookPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      webhookServer.close(() => resolve());
    });
  });

  it("POST body has { taskId, state, task }", async () => {
    const taskData = { id: "task-abc", status: { state: "completed" } };
    store.register("task-abc", { url: `http://127.0.0.1:${webhookPort}/hook` });
    await store.send("task-abc", "completed", taskData);

    assert.equal(receivedRequests.length, 1);
    const parsed = JSON.parse(receivedRequests[0].body);
    assert.equal(parsed.taskId, "task-abc");
    assert.equal(parsed.state, "completed");
    assert.deepEqual(parsed.task, taskData);
  });

  it("Content-Type is application/json", async () => {
    store.register("task-ct", { url: `http://127.0.0.1:${webhookPort}/hook` });
    await store.send("task-ct", "completed", { id: "task-ct" });

    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].headers["content-type"], "application/json");
  });

  it("Authorization header is sent when token is configured", async () => {
    store.register("task-auth", {
      url: `http://127.0.0.1:${webhookPort}/hook`,
      token: "secret-token-123",
    });
    await store.send("task-auth", "completed", { id: "task-auth" });

    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].headers["authorization"], "Bearer secret-token-123");
  });

  it("No Authorization header when token is not configured", async () => {
    store.register("task-noauth", {
      url: `http://127.0.0.1:${webhookPort}/hook`,
    });
    await store.send("task-noauth", "completed", { id: "task-noauth" });

    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].headers["authorization"], undefined);
  });
});

// ---------------------------------------------------------------------------
// Timeout handling
// ---------------------------------------------------------------------------

describe("PushNotificationStore timeout handling", () => {
  let store: PushNotificationStore;
  let slowServer: http.Server;
  let slowPort: number;

  beforeEach(async () => {
    store = new PushNotificationStore();

    await new Promise<void>((resolve) => {
      slowServer = http.createServer((_req, _res) => {
        // Never respond — will trigger timeout
      });
      slowServer.listen(0, "127.0.0.1", () => {
        const addr = slowServer.address() as { port: number };
        slowPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      slowServer.close(() => resolve());
    });
  });

  it("returns error on timeout without throwing", async () => {
    store.register("task-slow", {
      url: `http://127.0.0.1:${slowPort}/hook`,
    });

    // The store uses a 10s timeout. We can't easily override it,
    // but we can verify that a connection-refused error returns cleanly.
    // For actual timeout testing we'd need to mock, but we verify the
    // error handling path returns {ok: false} without throwing.
    const result = await store.send("task-slow", "completed", { id: "task-slow" });
    // With a non-responding server, this should eventually timeout/abort
    // The important thing is it doesn't throw — it returns a result
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});

// ---------------------------------------------------------------------------
// Store cleanup after delivery
// ---------------------------------------------------------------------------

describe("PushNotificationStore cleanup after delivery", () => {
  let store: PushNotificationStore;
  let webhookServer: http.Server;
  let webhookPort: number;

  beforeEach(async () => {
    store = new PushNotificationStore();

    await new Promise<void>((resolve) => {
      webhookServer = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
      });
      webhookServer.listen(0, "127.0.0.1", () => {
        const addr = webhookServer.address() as { port: number };
        webhookPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      webhookServer.close(() => resolve());
    });
  });

  it("auto-removes registration after successful delivery", async () => {
    store.register("task-once", { url: `http://127.0.0.1:${webhookPort}/hook` });
    assert.equal(store.has("task-once"), true);

    await store.send("task-once", "completed", { id: "task-once" });
    assert.equal(store.has("task-once"), false);
  });

  it("unregistered tasks do not get notifications", async () => {
    store.register("task-x", { url: `http://127.0.0.1:${webhookPort}/hook` });
    store.unregister("task-x");

    const result = await store.send("task-x", "completed", { id: "task-x" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "no registration");
  });
});

// ---------------------------------------------------------------------------
// HTTP error responses
// ---------------------------------------------------------------------------

describe("PushNotificationStore HTTP error responses", () => {
  let store: PushNotificationStore;
  let errorServer: http.Server;
  let errorPort: number;

  beforeEach(async () => {
    store = new PushNotificationStore();

    await new Promise<void>((resolve) => {
      errorServer = http.createServer((_req, res) => {
        res.writeHead(500);
        res.end("Internal Server Error");
      });
      errorServer.listen(0, "127.0.0.1", () => {
        const addr = errorServer.address() as { port: number };
        errorPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      errorServer.close(() => resolve());
    });
  });

  it("returns {ok: false} for HTTP 500 responses", async () => {
    store.register("task-err", { url: `http://127.0.0.1:${errorPort}/hook` });
    const result = await store.send("task-err", "completed", { id: "task-err" });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 500);
    assert.match(result.error!, /HTTP 500/);
  });

  it("returns {ok: false} for connection refused", async () => {
    store.register("task-refused", { url: "http://127.0.0.1:1/hook" });
    const result = await store.send("task-refused", "completed", { id: "task-refused" });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});

// ===========================================================================
// Signal decay notifications (Phase 1.3 — Bio-inspired)
// ===========================================================================

// ---------------------------------------------------------------------------
// computeImportance — exponential decay (cAMP degradation)
// ---------------------------------------------------------------------------

describe("computeImportance — signal decay math", () => {
  it("importance at t=0 equals initial value", () => {
    assert.equal(computeImportance(1.0, 0, 0.001), 1.0);
    assert.equal(computeImportance(0.8, 0, 0.01), 0.8);
  });

  it("importance decays over time", () => {
    const i0 = computeImportance(1.0, 0, 0.001);
    const i1 = computeImportance(1.0, 5000, 0.001); // 5s later
    const i2 = computeImportance(1.0, 30000, 0.001); // 30s later
    assert.ok(i0 > i1, `t=0 (${i0}) should be > t=5s (${i1})`);
    assert.ok(i1 > i2, `t=5s (${i1}) should be > t=30s (${i2})`);
  });

  it("higher decayRate means faster decay", () => {
    const slow = computeImportance(1.0, 10000, 0.001);
    const fast = computeImportance(1.0, 10000, 0.01);
    assert.ok(slow > fast, `slow decay (${slow}) should be > fast decay (${fast})`);
  });

  it("importance is always in [0, initial]", () => {
    for (const t of [0, 1000, 5000, 30000, 60000]) {
      for (const k of [0.0001, 0.001, 0.01, 0.1]) {
        const imp = computeImportance(1.0, t, k);
        assert.ok(imp >= 0 && imp <= 1.0, `importance(${t}ms, k=${k}) = ${imp}`);
      }
    }
  });

  it("half-life: importance ≈ 0.5 * initial at t = ln(2)/k", () => {
    const k = 0.01;
    const halfLifeMs = (Math.log(2) / k) * 1000; // ~69.3s
    const imp = computeImportance(1.0, halfLifeMs, k);
    assert.ok(Math.abs(imp - 0.5) < 0.01, `Expected ~0.5 at half-life, got ${imp}`);
  });
});

// ---------------------------------------------------------------------------
// sendWithRetry — decay-aware retry
// ---------------------------------------------------------------------------

describe("PushNotificationStore sendWithRetry", () => {
  let store: PushNotificationStore;
  let webhookServer: http.Server;
  let webhookPort: number;
  let requestCount: number;

  beforeEach(async () => {
    store = new PushNotificationStore();
    requestCount = 0;

    await new Promise<void>((resolve) => {
      webhookServer = http.createServer((_req, res) => {
        requestCount++;
        // Fail first 2 requests, succeed on 3rd
        if (requestCount <= 2) {
          res.writeHead(503);
          res.end("Service Unavailable");
        } else {
          res.writeHead(200);
          res.end("ok");
        }
      });
      webhookServer.listen(0, "127.0.0.1", () => {
        const addr = webhookServer.address() as { port: number };
        webhookPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      webhookServer.close(() => resolve());
    });
  });

  it("retries on failure and succeeds eventually", async () => {
    store.register("task-retry", {
      url: `http://127.0.0.1:${webhookPort}/hook`,
    });
    const decay: DecayConfig = {
      decayRate: 0.0001, // very slow decay → importance stays high
      minImportance: 0.1,
      maxRetries: 5,
      retryBaseDelayMs: 50,
    };
    const result = await store.sendWithRetry("task-retry", "completed", { id: "task-retry" }, decay);
    assert.equal(result.ok, true);
    assert.equal(requestCount, 3); // 2 failures + 1 success
  });

  it("abandons when importance decays below threshold", async () => {
    // Register with very old createdAt so importance is already low
    store.register("task-decayed", {
      url: `http://127.0.0.1:${webhookPort}/hook`,
      importance: 0.05, // below default minImportance of 0.1
    });
    const decay: DecayConfig = { minImportance: 0.1 };
    const result = await store.sendWithRetry("task-decayed", "completed", { id: "task-decayed" }, decay);
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("decayed"));
  });

  it("without DecayConfig, send behaves as legacy (no retry)", async () => {
    store.register("task-legacy", {
      url: `http://127.0.0.1:${webhookPort}/hook`,
    });
    // Regular send (no decay) — fails on first try, no retry
    const result = await store.send("task-legacy", "completed", { id: "task-legacy" });
    assert.equal(result.ok, false);
    assert.equal(requestCount, 1);
  });
});

// ---------------------------------------------------------------------------
// cleanup — remove decayed notifications
// ---------------------------------------------------------------------------

describe("PushNotificationStore cleanup", () => {
  it("removes registrations with importance below threshold", () => {
    const store = new PushNotificationStore();
    store.register("task-fresh", { url: "http://a.com", importance: 1.0 });
    store.register("task-stale", { url: "http://b.com", importance: 0.01 });
    store.register("task-medium", { url: "http://c.com", importance: 0.5 });

    const removed = store.cleanup(0.1);
    assert.equal(removed, 1); // only task-stale
    assert.equal(store.has("task-fresh"), true);
    assert.equal(store.has("task-stale"), false);
    assert.equal(store.has("task-medium"), true);
  });

  it("cleanup with no threshold uses default 0.1", () => {
    const store = new PushNotificationStore();
    store.register("task-tiny", { url: "http://a.com", importance: 0.05 });
    store.register("task-ok", { url: "http://b.com", importance: 0.2 });

    const removed = store.cleanup();
    assert.equal(removed, 1);
    assert.equal(store.has("task-ok"), true);
  });
});

// ===========================================================================
// SSRF re-validation + redirect handling (Phase 1.x — §1.1 from v1.0 review)
// ===========================================================================

// ---------------------------------------------------------------------------
// §1.1 — validator runs immediately before fetch
// ---------------------------------------------------------------------------

describe("PushNotificationStore §1.1 SSRF re-validation at delivery time", () => {
  it("calls security.validateUrl before fetch and bails on reject (no fetch happens)", async () => {
    let validateCalls = 0;
    let fetchAttempts = 0;

    const store = new PushNotificationStore({
      security: {
        validateUrl: async (_url) => {
          validateCalls++;
          return false; // SSRF block
        },
      },
    });

    // Register a URL we don't expect fetch() to ever reach. If validate
    // runs first (as it should), the 1-second sleep on this URL means we'd
    // see a delayed fetch had it been issued — but the validator bails
    // synchronously, so the fetch should never fire.
    store.register("task-ssrf", {
      url: "http://127.0.0.1:1/hook", // unused — validator should bail first
    });

    // Wrap global fetch to count attempts (Node 18+ globalThis.fetch).
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init: unknown) => {
      fetchAttempts++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const result = await store.send("task-ssrf", "completed", { id: "task-ssrf" });
      assert.equal(result.ok, false);
      assert.match(result.error!, /SSRF re-validation/);
      assert.equal(validateCalls, 1, "validateUrl must be called exactly once");
      assert.equal(fetchAttempts, 0, "fetch must NOT be called when validator rejects");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes through to fetch when validator approves", async () => {
    let validateCalls = 0;
    let fetchAttempts = 0;

    const store = new PushNotificationStore({
      security: {
        validateUrl: async (_url) => {
          validateCalls++;
          return true;
        },
      },
    });

    store.register("task-ok", { url: "http://placeholder.example/hook" });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      fetchAttempts++;
      const req = init as RequestInit | undefined;
      assert.equal(req?.redirect, "manual", "redirect must be 'manual'");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const result = await store.send("task-ok", "completed", { id: "task-ok" });
      assert.equal(result.ok, true);
      assert.equal(validateCalls, 1);
      assert.equal(fetchAttempts, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("treats 3xx response as failure when redirect: 'manual' is set (no follow)", async () => {
    // Server returns 302 to a private address. With redirect: "manual", the
    // fetch should surface the 302 as the response — NOT follow it. The
    // existing response.ok check then correctly marks it as a failure.
    const redirectServer = http.createServer((_req, res) => {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    await new Promise<void>((resolve) => redirectServer.listen(0, "127.0.0.1", resolve));
    const port = (redirectServer.address() as { port: number }).port;
    try {
      const store = new PushNotificationStore({
        security: { validateUrl: async () => true },
      });
      store.register("task-redirect", {
        url: `http://127.0.0.1:${port}/hook`,
      });
      const result = await store.send("task-redirect", "completed", { id: "task-redirect" });
      assert.equal(result.ok, false, "3xx must be treated as failure");
      assert.equal(result.statusCode, 302, "statusCode should reflect the 302, not a followed destination");
    } finally {
      await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
    }
  });

  it("sendWithRetry re-validates on each attempt — rebinding between attempts is caught", async () => {
    // Honest framing (per Phronesis review): this test does NOT exercise
    // actual DNS rebinding (that would need a hostname that flips resolution,
    // which is test-infra work). What it DOES verify: sendWithRetry calls
    // validateUrl on each attempt, and once an attempt fails validation,
    // no fetch happens for that attempt. The validator counter and the fetch
    // counter are the security-relevant signals here. The short-circuit
    // test below covers the surfaced error string.
    //
    // Simulated scenario: validator returns true on first attempt, false on
    // second (stand-in for the hostname re-pointing to a private IP).
    // First attempt fetches and fails (server returns 503), so sendWithRetry
    // would normally retry. With re-validation, the second attempt's
    // validator rejects before fetch — confirming each attempt is
    // independently re-checked.
    let validateCalls = 0;
    let fetchAttempts = 0;

    const store = new PushNotificationStore({
      security: {
        validateUrl: async (_url) => {
          validateCalls++;
          return validateCalls === 1; // first call OK, second call rejected
        },
      },
    });
    store.register("task-rebind", {
      url: "http://placeholder.example/hook",
      importance: 1.0,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, _init: unknown) => {
      fetchAttempts++;
      // Return 503 so sendWithRetry wants to retry
      return new Response("Service Unavailable", { status: 503 });
    }) as typeof fetch;
    try {
      const decay: DecayConfig = {
        decayRate: 0.0001,
        minImportance: 0.01,
        maxRetries: 1,
        retryBaseDelayMs: 5,
      };
      const result = await store.sendWithRetry(
        "task-rebind",
        "completed",
        { id: "task-rebind" },
        decay
      );
      assert.equal(result.ok, false);
      assert.equal(validateCalls, 2, "validator should run once per send() attempt");
      assert.equal(fetchAttempts, 1, "fetch should only happen on attempt 1; attempt 2 bails on validate");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sendWithRetry short-circuits on SSRF rejection — validateUrl reason surfaces at outer boundary", async () => {
    // Per Phronesis review: without this short-circuit, sendWithRetry masks
    // SSRF rejections as "max retries (N) exceeded" — operators can't tell
    // the URL was blocked at delivery vs. the webhook was simply down.
    // With the short-circuit, the first attempt that fails SSRF returns its
    // error directly. validateUrl's reason (private IP, disallowed scheme,
    // allowlist miss, DNS failure) is preserved at the outer API boundary.
    const store = new PushNotificationStore({
      security: {
        validateUrl: async () => false, // every attempt rejected
      },
    });
    store.register("task-ssrf-retry", { url: "http://placeholder.example/hook" });

    let fetchAttempts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchAttempts++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const decay: DecayConfig = {
        decayRate: 0.0001,
        minImportance: 0.01,
        maxRetries: 3,
        retryBaseDelayMs: 5,
      };
      const result = await store.sendWithRetry(
        "task-ssrf-retry",
        "completed",
        { id: "task-ssrf-retry" },
        decay
      );
      assert.equal(result.ok, false);
      assert.match(
        result.error!,
        /SSRF re-validation/,
        "validateUrl rejection reason must surface, not be masked as 'max retries exceeded'"
      );
      assert.equal(
        fetchAttempts,
        0,
        "no fetch should ever happen when every attempt is SSRF-rejected"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("treats IPv6 redirect target as failure (opaqueredirected or 302)", async () => {
    // Per Phronesis review: when redirect: "manual" + redirect target is in
    // a non-default network family, undici can return the response as
    // Response.type === "opaqueredirect" (status 0) rather than the literal
    // 3xx. Either way the security contract holds: no fetch to the redirect
    // target. Verify ok: false regardless of status code.
    const server = http.createServer((_req, res) => {
      // 302 to an IPv6 literal. The bracket form is required by RFC 3986.
      res.writeHead(302, { Location: "http://[::1]:1/internal" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const store = new PushNotificationStore({
        security: { validateUrl: async () => true },
      });
      store.register("task-v6-redirect", {
        url: `http://127.0.0.1:${port}/hook`,
      });
      const result = await store.send("task-v6-redirect", "completed", { id: "task-v6-redirect" });
      assert.equal(result.ok, false, "redirect must not be followed, even to IPv6 target");
      assert.ok(
        result.statusCode === 302 || result.statusCode === 0,
        `expected 302 (default) or 0 (opaqueredirected), got ${result.statusCode}`
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("treats relative-path redirect (Location: /admin) as failure — no resolve against original URL", async () => {
    // Per Phronesis review: undici resolves relative-path redirects against
    // the original request URL. With redirect: "manual" the redirect must
    // not be followed at all — verify the 302 is surfaced as a response.
    const server = http.createServer((_req, res) => {
      res.writeHead(302, { Location: "/admin" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const store = new PushNotificationStore({
        security: { validateUrl: async () => true },
      });
      store.register("task-relpath", {
        url: `http://127.0.0.1:${port}/hook`,
      });
      const result = await store.send("task-relpath", "completed", { id: "task-relpath" });
      assert.equal(result.ok, false, "relative redirect must not be resolved against original URL");
      assert.equal(result.statusCode, 302);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
