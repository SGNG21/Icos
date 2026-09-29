import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { connectorDefinitionSchema, type ConnectorInstance } from "@/core/tool-gateway/model";

import type { Connector, ConnectorOutcome } from "../ports";
import { act } from "./catalog";

const MAX_BYTES = 1_000_000;
const pathInput = { type: "object", required: ["path"], properties: { path: { type: "string" } } };

export const LOCAL_FILES_DEFINITION = connectorDefinitionSchema.parse({
  connectorId: "local-files",
  category: "FILES",
  availability: "CONNECTED",
  supportsCancel: false,
  supportsReconcile: false,
  tools: [
    {
      toolId: "files",
      version: "1.0.0",
      category: "FILES",
      description: "Files under the instance's configured root directory",
      capabilities: ["files.read", "files.search", "files.write", "files.delete"],
      actions: [
        act("READ", "LOW", "none", "Read a UTF-8 file", { inputSchema: pathInput }),
        act("SEARCH", "LOW", "none", "List files whose relative path contains `query`", {
          inputSchema: {
            type: "object",
            required: ["query"],
            properties: { query: { type: "string" } },
          },
        }),
        act("WRITE", "MEDIUM", "internal", "Create or overwrite a UTF-8 file", {
          inputSchema: {
            type: "object",
            required: ["path", "content"],
            properties: { path: { type: "string" }, content: { type: "string" } },
          },
        }),
        act("DELETE", "HIGH", "internal", "Delete a file", { inputSchema: pathInput }),
      ],
      timeoutMs: 10_000,
      auditPolicy: { persistResult: "summary" },
    },
  ],
});

class ToolInputError extends Error {}

/** Resolve `rel` inside `root`, following symlinks, refusing any escape. */
async function confine(root: string, rel: unknown): Promise<string> {
  if (typeof rel !== "string" || rel.length === 0 || path.isAbsolute(rel) || rel.includes("\0")) {
    throw new ToolInputError("path must be a non-empty relative path");
  }
  const realRoot = await realpath(root);
  const target = path.resolve(realRoot, rel);
  // The nearest existing ancestor must itself resolve inside the root (symlink escape).
  let probe = target;
  for (;;) {
    try {
      probe = await realpath(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);
  if (!inside(target) || !inside(probe)) throw new ToolInputError("path escapes the root");
  return target;
}

const rootOf = (i: ConnectorInstance) => {
  const root = i.config.root;
  if (typeof root !== "string" || !path.isAbsolute(root))
    throw new ToolInputError("instance root not configured");
  return root;
};

async function walk(dir: string, base: string, out: string[], limit: number): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= limit) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, out, limit);
    else if (e.isFile()) out.push(path.relative(base, full));
  }
}

export const localFilesConnector: Connector = {
  definition: LOCAL_FILES_DEFINITION,

  async health({ instance }) {
    try {
      await realpath(rootOf(instance));
      return "HEALTHY";
    } catch {
      return "DEGRADED";
    }
  },

  async execute(_toolId, action, input, { instance }): Promise<ConnectorOutcome> {
    try {
      const root = rootOf(instance);
      switch (action) {
        case "READ": {
          const content = await readFile(await confine(root, input.path), "utf8");
          if (Buffer.byteLength(content) > MAX_BYTES) throw new ToolInputError("file too large");
          return { ok: true, output: { content }, summary: { bytes: Buffer.byteLength(content) } };
        }
        case "SEARCH": {
          if (typeof input.query !== "string") throw new ToolInputError("query must be a string");
          const all: string[] = [];
          const realRoot = await realpath(root);
          await walk(realRoot, realRoot, all, 5_000);
          const matches = all.filter((f) => f.includes(input.query as string)).slice(0, 200);
          return { ok: true, output: { matches }, summary: { count: matches.length } };
        }
        case "WRITE": {
          if (typeof input.content !== "string" || Buffer.byteLength(input.content) > MAX_BYTES) {
            throw new ToolInputError("content must be a string under 1 MB");
          }
          const target = await confine(root, input.path);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, input.content, "utf8");
          return {
            ok: true,
            output: { written: true },
            summary: { bytes: Buffer.byteLength(input.content) },
          };
        }
        case "DELETE": {
          await rm(await confine(root, input.path));
          return { ok: true, output: { deleted: true }, summary: { deleted: true } };
        }
        default:
          return {
            ok: false,
            failureClass: "INVALID_INPUT",
            settlement: "NOT_APPLIED",
            message: `unsupported action ${action}`,
          };
      }
    } catch (e) {
      if (e instanceof ToolInputError) {
        return {
          ok: false,
          failureClass: "INVALID_INPUT",
          settlement: "NOT_APPLIED",
          message: e.message,
        };
      }
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT")
        return {
          ok: false,
          failureClass: "NOT_FOUND",
          settlement: "NOT_APPLIED",
          message: "not found",
        };
      if (code === "EACCES" || code === "EPERM") {
        return {
          ok: false,
          failureClass: "PERMISSION_DENIED",
          settlement: "NOT_APPLIED",
          message: "access denied by filesystem",
        };
      }
      if (code === "EISDIR")
        return {
          ok: false,
          failureClass: "INVALID_INPUT",
          settlement: "NOT_APPLIED",
          message: "is a directory",
        };
      return {
        ok: false,
        failureClass: "UNKNOWN",
        settlement: "UNKNOWN",
        message: code ?? "filesystem error",
      };
    }
  },
};
