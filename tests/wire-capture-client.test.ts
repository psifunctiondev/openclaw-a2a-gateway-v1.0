/**
 * A2A v1.0 client-side wire-capture test
 *
 * Purpose: prove that `skill/scripts/a2a-send.mjs` produces a v1.0-compliant
 * outbound wire body when given a text message. Specifically:
 *   1. `parts[0]` is non-empty and carries a `text` field (NOT an empty `{}`)
 *   2. `role` is encoded as the v1.0 numeric enum (1 = ROLE_USER), not a string
 *   3. `messageId` passes through as a UUID
 *
 * Why this test exists (the bug it pins):
 *   Pre-fix, `a2a-send.mjs` constructed outbound parts using the v0.3 SDK
 *   shape `{ kind: "text", text: message }`. The v1.0 SDK encoder silently
 *   dropped this shape and produced `parts: [{}]` on the wire — making
 *   outbound messages appear as empty to the receiver. Same root cause hit
 *   `role: "user"` (string) → `role: "UNRECOGNIZED"`. The fix switches to
 *   the v1.0 SDK shape `{ content: { $case: "text", value }, mediaType }`
 *   and `Role.ROLE_USER`.
 *
 * Approach: spawn `a2a-send.mjs` as a subprocess against a local A2A
 * server that, in addition to running the EchoExecutor, captures the
 * outbound SendMessage body via Express middleware. We assert on the
 * captured body. This exercises the full outbound pipeline including
 * `ClientFactory.createFromUrl`, the auth fetch wrapper, and the
 * `JsonRpcTransport` serialization — not just a unit-tested helper.
 *
 * Companion: tests/wire-v1.0.test.ts covers the server-side contract.
 *
 * Reference: @a2a-js/sdk v1.0.1 dist/a2a-4AAMnZHp.d.ts:125-149 (Part type).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { spawn } from "node:child_process";
import express, { type Express } from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AddressInfo } from "node:net";

import {
  A2A_PROTOCOL_VERSION,
  type AgentCard,
  type AgentExecutor,
  type Message,
  type Part,
  type Task,
  type TaskState,
} from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  ExecutionEventBus,
  InMemoryTaskStore,
  RequestContext,
  TaskStore,
  AgentEvent,
} from "@a2a-js/sdk/server";
import {
  jsonRpcHandler,
  agentCardHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Wire capture. We use `express.json({ verify: ... })` registered BEFORE the
// SDK's `jsonRpcHandler`. The verify callback receives the raw buffer BEFORE
// body-parser sets `req.body`, so we can stash it without consuming the
// request stream. The SDK's subsequent `express.json()` call sees
// `req.body` already populated and skips re-parsing.
//
// Why not a plain middleware that does `req.on("data", ...)`? Because the
// SDK's `jsonRpcHandler` mounts its own `express.json()` internally, which
// reads the stream. A teed stream is consumed by the first reader and the
// second reader fails with "stream is not readable". The `verify` callback
// is the right hook — it fires once per request, with the full buffer,
// before any downstream parser runs.
// ---------------------------------------------------------------------------

const capturedBodies: any[] = [];

function isJsonRpcSend(url: string | undefined): boolean {
  if (!url) return false;
  // Agent-card GETs and the SDK's internal /agent-card.json fetches are not
  // SendMessage; only the POST body of /a2a/jsonrpc (and any other RPC
  // mount) carries SendMessage. We capture all POST bodies and filter in
  // the assertions, which is simpler than threading the path through.
  return true;
}


// ---------------------------------------------------------------------------
// Test fixture: minimal EchoExecutor (same shape as wire-v1.0.test.ts).
// ---------------------------------------------------------------------------

const FIXTURE_CARD: AgentCard = {
  name: "wire-capture-echo",
  description: "Echo agent for A2A v1.0 client wire-capture test",
  version: "1.0.0",
  provider: {
    organization: "psifunctiondev/openclaw-a2a-gateway-v1.0",
    url: "http://localhost",
  },
  supportedInterfaces: [
    {
      url: "http://localhost/a2a/jsonrpc",
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: A2A_PROTOCOL_VERSION,
    },
  ],
  capabilities: {
    streaming: false,
    pushNotifications: false,
    extensions: [],
    extendedAgentCard: false,
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "echo",
      name: "echo",
      description: "Echoes the user's text back",
      tags: ["test"],
      examples: [],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      securityRequirements: [],
    },
  ],
  documentationUrl: undefined,
  signatures: [],
};

function extractText(message: Message): string {
  for (const part of message.parts ?? []) {
    if (part.content?.$case === "text") return part.content.value;
  }
  return "";
}

class EchoExecutor implements AgentExecutor {
  cancelTask = async (_taskId: string, _eventBus: ExecutionEventBus): Promise<void> => {
    /* no-op */
  };

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userMessage = requestContext.userMessage;
    const inputText = extractText(userMessage) || "(empty)";

    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;

    const taskSnapshot: Task = requestContext.task ?? {
      id: taskId,
      contextId,
      status: {
        state: 1 as TaskState,
        timestamp: new Date().toISOString(),
        message: undefined,
      },
      artifacts: [],
      history: [userMessage],
      metadata: userMessage.metadata,
    };
    eventBus.publish(AgentEvent.task(taskSnapshot));
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: 3 as TaskState,
          timestamp: new Date().toISOString(),
          message: {
            messageId: uuidv4(),
            role: 2 as Part["role"],
            parts: [
              {
                content: { $case: "text" as const, value: `echo: ${inputText}` },
                metadata: undefined,
                filename: "",
                mediaType: "text/plain",
              },
            ],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          },
        },
        metadata: undefined,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  port: number;
  baseUrl: string;
  server: import("node:http").Server;
}

async function bootHarness(): Promise<Harness> {
  const probe = express();
  const probeServer = probe.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => probeServer.on("listening", () => resolve()));
  const port = (probeServer.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve) => probeServer.close(() => resolve()));

  const card: AgentCard = {
    ...FIXTURE_CARD,
    provider: { ...FIXTURE_CARD.provider, url: baseUrl },
    supportedInterfaces: FIXTURE_CARD.supportedInterfaces.map((iface) => ({
      ...iface,
      url: `${baseUrl}/a2a/jsonrpc`,
    })),
  };

  const executor: AgentExecutor = new EchoExecutor();
  const taskStore: TaskStore = new InMemoryTaskStore();
  const requestHandler = new DefaultRequestHandler(card, taskStore, executor);

  const app: Express = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        if (req.method !== "POST") return;
        if (!isJsonRpcSend(req.url)) return;
        try {
          capturedBodies.push(JSON.parse(buf.toString()));
        } catch {
          capturedBodies.push({ _raw: buf.toString(), _parseError: true });
        }
      },
    }),
  );

  app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: requestHandler }));
  app.use("/.well-known/agent.json", agentCardHandler({ agentCardProvider: requestHandler }));

  app.use(
    "/a2a/jsonrpc",
    jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
  );

  const server = app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));

  return { port, baseUrl, server };
}

// ---------------------------------------------------------------------------
// Helper: run a2a-send.mjs as a subprocess against the local harness.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, "..", "skill", "scripts", "a2a-send.mjs");

async function runA2aSend(baseUrl: string, messageText: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [
        SCRIPT_PATH,
        "--peer-url", baseUrl,
        "--message", messageText,
        "--timeout-ms", "5000",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("A2A v1.0 client outbound wire shape (a2a-send.mjs)", () => {
  let harness: Harness;

  before(async () => {
    harness = await bootHarness();
  });

  after(async () => {
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  });

  it("produces a non-empty parts[0] with text on the wire", async () => {
    capturedBodies.length = 0;
    const messageText = "wire-capture-test-message-1";

    const result = await runA2aSend(harness.baseUrl, messageText);
    assert.equal(result.code, 0, `a2a-send.mjs should exit 0. stderr=${result.stderr}`);

    // Find the SendMessage body (skip the agent-card GET body, which is
    // empty/null since it's a GET).
    const sendMessage = capturedBodies.find(
      (b) => b?.method === "SendMessage" && b?.params?.message,
    );
    assert.ok(sendMessage, `expected a SendMessage body in: ${JSON.stringify(capturedBodies)}`);

    const parts = sendMessage.params.message.parts;
    assert.ok(Array.isArray(parts), "parts must be an array");
    assert.ok(parts.length >= 1, "parts must be non-empty");
    assert.notDeepEqual(parts[0], {}, "parts[0] must NOT be empty (the pre-fix bug)");

    const text = parts[0].text;
    assert.equal(typeof text, "string", "parts[0].text must be a string");
    assert.ok(text.length > 0, "parts[0].text must be non-empty");
    assert.equal(text, messageText, "parts[0].text must match the input message");
  });

  it("encodes role as a v1.0 ROLE_USER marker (numeric 1 OR enum-prefixed string), not the pre-fix bug", async () => {
    capturedBodies.length = 0;
    const result = await runA2aSend(harness.baseUrl, "role-enum-check");
    assert.equal(result.code, 0, `a2a-send.mjs should exit 0. stderr=${result.stderr}`);

    const sendMessage = capturedBodies.find(
      (b) => b?.method === "SendMessage" && b?.params?.message,
    );
    assert.ok(sendMessage, "expected a SendMessage body");

    const role = sendMessage.params.message.role;

    // v1.0 of the SDK accepts BOTH serializations for enum values:
    //   - numeric: 1 (ROLE_USER)
    //   - string (enum-prefixed): "ROLE_USER"  (per commit 5d62738 in this fork)
    // The wire-capture test must accept either, but unconditionally reject
    // the pre-fix bug shapes. The pre-fix bug produced `role: "user"`
    // (lowercase string) which the SDK protobuf encoder can decode but
    // treats as unknown, sometimes surfacing as `"UNRECOGNIZED"`.
    const isNumeric = typeof role === "number" && role === 1;
    const isEnumPrefixedString = typeof role === "string" && role === "ROLE_USER";
    assert.ok(
      isNumeric || isEnumPrefixedString,
      `role must be 1 (numeric) or "ROLE_USER" (enum-prefixed string). Got: ${JSON.stringify(role)} (typeof ${typeof role}). ` +
      `Pre-fix bug shapes to reject: "user" (lowercase), "UNRECOGNIZED", undefined, or any other value.`,
    );
    assert.notEqual(role, "user", "role must NOT be the lowercase string 'user' (the pre-fix bug)");
    assert.notEqual(role, "UNRECOGNIZED", "role must NOT be 'UNRECOGNIZED' (the pre-fix bug)");
    assert.notEqual(role, undefined, "role must NOT be undefined (the pre-fix bug)");
  });

  it("passes messageId through as a UUID v4 string", async () => {
    capturedBodies.length = 0;
    const result = await runA2aSend(harness.baseUrl, "messageid-check");
    assert.equal(result.code, 0, `a2a-send.mjs should exit 0. stderr=${result.stderr}`);

    const sendMessage = capturedBodies.find(
      (b) => b?.method === "SendMessage" && b?.params?.message,
    );
    assert.ok(sendMessage, "expected a SendMessage body");

    const messageId = sendMessage.params.message.messageId;
    assert.equal(typeof messageId, "string", "messageId must be a string");
    assert.match(
      messageId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      `messageId must be a UUID v4, got: ${messageId}`,
    );
  });
});
