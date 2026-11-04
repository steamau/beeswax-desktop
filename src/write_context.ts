import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Every write tool takes `reasoning` (stored in the server's audit log) and
// `external_ref` (idempotency). Rather than repeat them in 45 tool definitions,
// registerTool is wrapped once: a write tool's schema gains the two fields, and
// the handler runs inside a context that api() reads to send them as headers:
//   Idempotency-Key  — external_ref, or a per-call UUID so api()'s own retries
//                      of a write after a 502/530 can never apply it twice
//   X-Reasoning      — URI-encoded reasoning, recorded on the AuditLog entry
interface WriteContext {
  idempotencyKey: string;
  reasoning?: string;
}

const storage = new AsyncLocalStorage<WriteContext>();

export function currentWriteContext(): WriteContext | undefined {
  return storage.getStore();
}

const reasoningField = z
  .string()
  .max(2000)
  .optional()
  .describe("Why you are making this change — recorded on the audit log entry for this write");
const externalRefField = z
  .string()
  .max(200)
  .optional()
  .describe(
    "Your stable ID for this write (e.g. a statement line or document reference). Repeating a call with the " +
      "same external_ref replays the first result instead of writing twice."
  );

type AnyRecord = Record<string, unknown>;

export function withWriteContext(server: McpServer): McpServer {
  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (
    name: string,
    config: AnyRecord & { annotations?: { readOnlyHint?: boolean }; inputSchema?: AnyRecord },
    handler: (args: AnyRecord, extra: unknown) => unknown
  ) => {
    if (config.annotations?.readOnlyHint !== false) return original(name, config, handler);

    const inputSchema = { ...(config.inputSchema ?? {}) };
    if (!("reasoning" in inputSchema)) inputSchema.reasoning = reasoningField;
    if (!("external_ref" in inputSchema)) inputSchema.external_ref = externalRefField;

    const wrapped = (args: AnyRecord, extra: unknown) => {
      const ref = typeof args?.external_ref === "string" && args.external_ref ? args.external_ref : undefined;
      const reasoning = typeof args?.reasoning === "string" && args.reasoning ? args.reasoning : undefined;
      const ctx: WriteContext = { idempotencyKey: ref ? `${name}:${ref}` : `${name}:${randomUUID()}`, reasoning };
      return storage.run(ctx, () => handler(args, extra));
    };
    return original(name, { ...config, inputSchema }, wrapped);
  };
  return server;
}
