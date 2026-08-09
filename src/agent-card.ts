import type { AgentCard, AgentSkill } from "@a2a-js/sdk";

import type { GatewayConfig } from "./types.js";

function toSkill(entry: string | { id?: string; name: string; description?: string }, index: number): AgentSkill {
  const base: AgentSkill = {
    id: "",
    name: "",
    description: "",
    tags: [],
    examples: [],
    inputModes: [],
    outputModes: [],
    securityRequirements: [],
  };
  if (typeof entry === "string") {
    return {
      ...base,
      id: `skill-${index + 1}`,
      name: entry,
      description: entry,
    };
  }

  return {
    ...base,
    id: entry.id || `skill-${index + 1}`,
    name: entry.name,
    description: entry.description || entry.name,
  };
}

export function buildAgentCard(config: GatewayConfig): AgentCard {
  const agentCard = config.agentCard || ({} as GatewayConfig["agentCard"]);
  const server = config.server || { host: "0.0.0.0", port: 18800 };
  const configuredUrl = agentCard.url;

  const fallbackHost = server.host === "0.0.0.0" ? "localhost" : server.host;
  const fallbackUrl = `http://${fallbackHost}:${server.port}/a2a/jsonrpc`;

  const securitySchemes: AgentCard["securitySchemes"] = {};
  const securityRequirements: AgentCard["securityRequirements"] = [];

  const security_ = config.security || { inboundAuth: "none", token: "" };
  if (security_.inboundAuth === "bearer") {
    // v1.0 SecurityScheme uses a `scheme` oneof field with `$case` discriminator
    // (httpAuthSecurityScheme, apiKeySecurityScheme, oauth2SecurityScheme, etc.).
    // v0.3 had flat `{ type, scheme }` — that shape is no longer valid.
    securitySchemes["bearer"] = {
      scheme: {
        $case: "httpAuthSecurityScheme",
        value: {
          description: "Bearer token authentication",
          scheme: "bearer",
          bearerFormat: "",
        },
      },
    };
    // v1.0 SecurityRequirement uses `schemes: { [name]: StringList }` (the
    // v0.3 `{ bearer: [] }` shorthand maps to `{ schemes: { bearer: { list: [] } } }`).
    securityRequirements.push({ schemes: { bearer: { list: [] } } });
  }

  const grpcPort = server.port + 1;
  const grpcHost = server.host === "0.0.0.0"
    ? (configuredUrl ? new URL(configuredUrl).hostname : "localhost")
    : server.host;
  const useDerivedGrpcUrl = agentCard.grpcProxy === true;
  const grpcUrl = useDerivedGrpcUrl
    ? `${new URL(configuredUrl || fallbackUrl).origin}`
    : `${grpcHost}:${grpcPort}`;
  const restUrl = `${new URL(configuredUrl || fallbackUrl).origin}/a2a/rest`;

  const jsonRpcUrl = configuredUrl || fallbackUrl;

  return {
    version: "1.0.0",
    name: agentCard.name || "OpenClaw A2A Gateway",
    description: agentCard.description || "A2A bridge for OpenClaw agents",
    skills: (agentCard.skills || []).map((entry, index) => toSkill(entry, index)),
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      // v1.0: replaces v0.3's top-level `supportsAuthenticatedExtendedCard`.
      // We don't serve a separate extended card, so this is false.
      extendedAgentCard: false,
    },
    securitySchemes,
    securityRequirements,
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    // v1.0 protocol — advertised interfaces. Order matters: first
    // entry is the preferred one. Top-level `url`, `protocolVersion`,
    // and `additionalInterfaces` were intentionally removed in v1.0
    // — peers consume `supportedInterfaces[]` directly. We advertise
    // four entries: preferred JSON-RPC v1.0, legacy JSON-RPC v0.3
    // (for old peers that walk the card and pick by protocolVersion),
    // plus REST and gRPC v1.0 for transport-level fallback. See
    // a2a-v1-migration-brief §3 for the upstream rationale.
    supportedInterfaces: [
      {
        url: jsonRpcUrl,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: "1.0",
      },
      {
        url: jsonRpcUrl,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: "0.3",
      },
      {
        url: restUrl,
        protocolBinding: "HTTP+JSON",
        tenant: "",
        protocolVersion: "1.0",
      },
      {
        url: grpcUrl,
        protocolBinding: "GRPC",
        tenant: "",
        protocolVersion: "1.0",
      },
    ],
    // v1.0 requires signatures[]. We don't sign our card yet, so empty.
    signatures: [],
  } as unknown as AgentCard;
}
