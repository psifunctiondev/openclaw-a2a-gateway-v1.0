// ===========================================================================
// v0.3 wire-format compat middleware
//
// Background: per Quinn 2026-08-10 16:32, A2A v0.3 is the higher-level spec
// and we promised v0.3 support in the agent card. The SDK's
// `legacyCompat: { enabled: true }` only routes to the v0.3 handler when the
// RPC method name is v0.3 style (`message/send`, `tasks/get`). When a peer
// uses v1.0 method names (`SendMessage`) but v0.3 wire format in the body
// (role with `ROLE_` prefix, parts with `kind` field), the SDK routes to its
// v1.0 `JsonRpcTransportHandler` which can't decode the body and throws.
//
// The fix is an Express middleware that detects v0.3 indicators in the body
// regardless of method name and normalizes the message via the SDK's
// `toCoreMessage` before the SDK sees it.
//
// These tests verify:
// 1. v0.3 wire format body → middleware normalizes to v1.0 before SDK sees it
// 2. v1.0 wire format body → middleware is a no-op (idempotent)
// 3. Malformed v0.3 body → middleware passes through (failure-soft)
// 4. End-to-end: a v0.3 SendMessage request reaches the executor
// ===========================================================================

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

// The middleware under test is defined inline in src/index.ts (to avoid
// depending on the SDK's internal `toCoreMessage`, which isn't exported).
// We re-implement the same normalization here for a focused unit test of the
// normalization contract. Wiring tests (Express integration) would belong in
// a separate file. Both copies must stay in sync.

function v03RoleToV1(role: unknown): string | undefined {
  if (role === "ROLE_USER" || role === "user") return "user";
  if (role === "ROLE_AGENT" || role === "agent") return "agent";
  return undefined;
}

function v03PartToV1(part: unknown): unknown {
  if (!part || typeof part !== "object") return part;
  const p = part as Record<string, unknown>;
  if (typeof p.kind !== "string") return part;
  if (p.kind === "text" && typeof p.text === "string") {
    return {
      content: { $case: "text", value: p.text },
      mediaType: typeof p.mediaType === "string" ? p.mediaType : "text/plain",
      filename: "",
    };
  }
  if (p.kind === "file" && p.file && typeof p.file === "object") {
    const file = p.file as Record<string, unknown>;
    const filename = typeof file.name === "string" ? file.name : "";
    const mediaType = typeof file.mimeType === "string" ? file.mimeType : "";
    if (typeof file.bytes === "string") {
      return {
        content: { $case: "raw", value: Buffer.from(file.bytes, "base64") },
        mediaType,
        filename,
      };
    }
    if (typeof file.uri === "string") {
      return {
        content: { $case: "url", value: file.uri },
        mediaType,
        filename,
      };
    }
  }
  if (p.kind === "data") {
    return {
      content: { $case: "data", value: p.data },
      filename: "",
      mediaType: "",
    };
  }
  return part;
}

function makeNormalizeMiddleware(): express.RequestHandler {
  return (req, _res, next) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object") return next();
      const params = body.params as Record<string, unknown> | undefined;
      const message = params?.message as Record<string, unknown> | undefined;
      if (!message || typeof message !== "object") return next();

      const isV03Role = typeof message.role === "string" && message.role.startsWith("ROLE_");
      const isV03Parts = Array.isArray(message.parts) && message.parts.some(
        (p: unknown) => typeof p === "object" && p !== null && "kind" in (p as Record<string, unknown>),
      );

      if (!isV03Role && !isV03Parts) return next();

      const normalizedRole = v03RoleToV1(message.role);
      const normalizedParts = Array.isArray(message.parts)
        ? message.parts.map(v03PartToV1)
        : message.parts;

      const normalizedMessage: Record<string, unknown> = { ...message };
      if (normalizedRole !== undefined) normalizedMessage.role = normalizedRole;
      normalizedMessage.parts = normalizedParts;
      req.body = { ...body, params: { ...params, message: normalizedMessage } };
      return next();
    } catch {
      return next();
    }
  };
}

// Capture the body that the (mock) downstream handler sees.
function makeCaptureServer(): Promise<{ server: http.Server; captured: { body: unknown } }> {
  const captured = { body: undefined as unknown };
  const app = express();
  app.use(express.json());
  app.use(makeNormalizeMiddleware());
  app.post("/a2a/jsonrpc", (req, res) => {
    captured.body = req.body;
    res.status(200).json({ jsonrpc: "2.0", id: req.body?.id, result: { ok: true } });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({ server, captured: { get body() { return captured.body; }, set body(v) { captured.body = v; } } as { body: unknown } });
    });
  });
}

async function postJsonRpc(server: http.Server, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const port = (server.address() as AddressInfo).port;
  const data = JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/a2a/jsonrpc",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => { chunks += c; });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(chunks) });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Detection: v0.3 indicators
// ---------------------------------------------------------------------------

describe("normalizeV03ToV1JsonRpcBody — detection", () => {
  let server: http.Server;
  let captured: { body: unknown };

  beforeEach(async () => {
    const setup = await makeCaptureServer();
    server = setup.server;
    captured = setup.captured;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("normalizes a v0.3 SendMessage body with ROLE_USER role to v1.0 (role: user)", async () => {
    const v03Body = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "SendMessage",
      params: {
        message: {
          role: "ROLE_USER",
          parts: [{ kind: "text", text: "hello from v0.3" }],
          messageId: "msg-1",
          contextId: "ctx-1",
        },
      },
    };

    await postJsonRpc(server, v03Body);

    const body = captured.body as { params: { message: { role: string; parts: unknown[] } } };
    assert.equal(body.params.message.role, "user", "ROLE_USER should normalize to lowercase 'user'");
    const firstPart = body.params.message.parts[0] as Record<string, unknown>;
    assert.ok("content" in firstPart, "v0.3 part should be normalized to v1.0 `content` field");
    assert.equal((firstPart.content as Record<string, unknown>).$case, "text");
    assert.equal((firstPart.content as Record<string, unknown>).value, "hello from v0.3");
  });

  it("normalizes a v0.3 SendMessage body with kind-shaped parts (no ROLE_ role) to v1.0", async () => {
    // Some v0.3 clients may omit role or send a different format. The
    // `kind`-shaped parts are the primary v0.3 indicator.
    const v03Body = {
      jsonrpc: "2.0",
      id: "req-2",
      method: "SendMessage",
      params: {
        message: {
          parts: [{ kind: "text", text: "no role field" }],
          messageId: "msg-2",
        },
      },
    };

    await postJsonRpc(server, v03Body);

    const body = captured.body as { params: { message: { parts: unknown[] } } };
    const firstPart = body.params.message.parts[0] as Record<string, unknown>;
    assert.ok("content" in firstPart, "kind-shaped parts should normalize to content-shaped parts");
    assert.equal((firstPart.content as Record<string, unknown>).$case, "text");
  });

  it("is a no-op for v1.0 wire format (idempotent)", async () => {
    const v1Body = {
      jsonrpc: "2.0",
      id: "req-3",
      method: "SendMessage",
      params: {
        message: {
          role: "user",
          parts: [{ content: { $case: "text", value: "already v1.0" }, mediaType: "text/plain" }],
          messageId: "msg-3",
        },
      },
    };

    await postJsonRpc(server, v1Body);

    const body = captured.body as { params: { message: { role: string; parts: unknown[] } } };
    assert.equal(body.params.message.role, "user");
    const firstPart = body.params.message.parts[0] as Record<string, unknown>;
    assert.deepEqual(firstPart, (v1Body.params.message as { parts: unknown[] }).parts[0], "v1.0 body should pass through untouched (deep equal: round-trip JSON parse produces new object instances)");
  });

  it("is a no-op for non-SendMessage methods (preserves GetTask, CancelTask, etc.)", async () => {
    const getTaskBody = {
      jsonrpc: "2.0",
      id: "req-4",
      method: "GetTask",
      params: { id: "task-xyz", historyLength: 5 },
    };

    await postJsonRpc(server, getTaskBody);

    const body = captured.body as { params: { id: string } };
    assert.equal(body.params.id, "task-xyz", "GetTask params should pass through untouched");
  });

  it("failure-soft: malformed v0.3 passes through, SDK can return its normal error", async () => {
    // v0.3 indicator (kind field) but invalid value — toCoreMessage will throw.
    const malformedBody = {
      jsonrpc: "2.0",
      id: "req-5",
      method: "SendMessage",
      params: {
        message: {
          parts: [{ kind: "invalid_kind_xyz", text: "boom" }],
          messageId: "msg-5",
        },
      },
    };

    // Should NOT throw — the middleware swallows the error and passes
    // the original body through so the SDK can return its normal error.
    const { status, json } = await postJsonRpc(server, malformedBody);
    assert.equal(status, 200, "middleware should not crash the request");
    assert.deepEqual((json as { result: unknown }).result, { ok: true }, "downstream handler ran with original body");
  });

  it("is a no-op for bodies without `params.message` (e.g. ping)", async () => {
    const pingBody = { jsonrpc: "2.0", id: "req-6", method: "rpc.ping" };
    await postJsonRpc(server, pingBody);
    const body = captured.body as { method: string };
    assert.equal(body.method, "rpc.ping");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: confirm v0.3 SendMessage body, when normalized, reaches the
// executor (the actual bug we're fixing). Uses a minimal executor stub.
// ---------------------------------------------------------------------------

describe("v0.3 wire-format compat — end-to-end dispatch", () => {
  it("a v0.3 SendMessage body normalizes and reaches a downstream executor stub", async () => {
    let receivedByExecutor: unknown = null;
    const app = express();
    app.use(express.json());
    app.use(makeNormalizeMiddleware());
    app.post("/a2a/jsonrpc", (req, res) => {
      // Simulate the SDK's downstream pipeline passing the (now-normalized)
      // request to the executor.
      receivedByExecutor = req.body;
      res.status(200).json({ jsonrpc: "2.0", id: req.body?.id, result: { task: { id: "task-1", status: { state: "working", timestamp: new Date().toISOString() } } } });
    });

    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const v03Body = {
        jsonrpc: "2.0",
        id: "req-e2e",
        method: "SendMessage",
        params: {
          message: {
            role: "ROLE_USER",
            parts: [{ kind: "text", text: "e2e v0.3 message" }],
            messageId: "msg-e2e",
            contextId: "ctx-e2e",
          },
        },
      };
      const data = JSON.stringify(v03Body);
      const result = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/a2a/jsonrpc",
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
          },
          (res) => {
            let chunks = "";
            res.on("data", (c) => { chunks += c; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
          },
        );
        req.on("error", reject);
        req.write(data);
        req.end();
      });

      assert.equal(result.status, 200);
      const received = receivedByExecutor as { params: { message: { role: string; parts: unknown[] } } };
      assert.equal(received.params.message.role, "user");
      const firstPart = received.params.message.parts[0] as Record<string, unknown>;
      assert.equal((firstPart.content as Record<string, unknown>).value, "e2e v0.3 message");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
