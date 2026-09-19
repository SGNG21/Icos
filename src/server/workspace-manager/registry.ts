import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { WorkspaceError, type Workspace } from "./types";

export interface RegistryState {
  workspaces: Workspace[];
}

/**
 * Registre durable des workspaces. Toutes les mutations passent par `transaction`
 * (exclusion mutuelle + tout-ou-rien) : c'est là que les invariants d'unicité sont vérifiés.
 * ponytail: fichier JSON hors dépôt ; un port PostgreSQL suffira si l'état doit être partagé entre machines.
 */
export interface WorkspaceRegistry {
  read(): Promise<Workspace[]>;
  transaction<T>(fn: (state: RegistryState) => T | Promise<T>): Promise<T>;
}

export class InMemoryWorkspaceRegistry implements WorkspaceRegistry {
  private state: RegistryState = { workspaces: [] };
  private tail: Promise<unknown> = Promise.resolve();

  async read(): Promise<Workspace[]> {
    return structuredClone(this.state.workspaces);
  }

  transaction<T>(fn: (state: RegistryState) => T | Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      this.state = draft;
      return result;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}

export interface FileRegistryOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export class FileWorkspaceRegistry implements WorkspaceRegistry {
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    options: FileRegistryOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.staleLockMs = options.staleLockMs ?? 60_000;
  }

  async read(): Promise<Workspace[]> {
    return (await this.load()).workspaces;
  }

  transaction<T>(fn: (state: RegistryState) => T | Promise<T>): Promise<T> {
    // File d'attente locale (même processus) puis verrou fichier (entre processus).
    const run = this.tail.then(async () => {
      const release = await this.lock();
      try {
        const state = await this.load();
        const result = await fn(state);
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(state, null, 2));
        await rename(tmp, this.file);
        return result;
      } finally {
        await release();
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<RegistryState> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as RegistryState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { workspaces: [] };
      throw error;
    }
  }

  private async lock(): Promise<() => Promise<void>> {
    const lockPath = `${this.file}.lock`;
    await mkdir(path.dirname(this.file), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(String(process.pid));
        await handle.close();
        return () => unlink(lockPath).catch(() => undefined);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const age = await stat(lockPath).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age >= this.staleLockMs) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline)
        throw new WorkspaceError("REGISTRY_LOCKED", `verrou ${lockPath} tenu`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}
