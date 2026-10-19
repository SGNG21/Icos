import type { Sql } from "postgres";

/**
 * Sonde de disponibilité PostgreSQL sur le pool EXISTANT du container (aucune
 * connexion dédiée, aucune écriture). `SELECT 1` annulé côté serveur si le
 * délai est dépassé. Ne lève jamais ; ne relaie jamais le message d'erreur
 * du driver (il peut contenir hôte, base ou utilisateur).
 */
export type DatabasePing =
  { ok: true; latencyMs: number } | { ok: false; latencyMs: number; error: "timeout" | "error" };

export interface DatabaseHealthPort {
  ping(timeoutMs: number): Promise<DatabasePing>;
}

export function createDatabaseHealth(sql: Sql, now: () => number = Date.now): DatabaseHealthPort {
  return {
    async ping(timeoutMs) {
      const started = now();
      const query = sql`select 1 as ok`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      try {
        const outcome = await Promise.race([query.then(() => "ok" as const), timeout]);
        if (outcome === "timeout") {
          query.cancel();
          query.catch(() => {}); // l'annulation rejette la requête : rejet attendu
          return { ok: false, latencyMs: now() - started, error: "timeout" };
        }
        return { ok: true, latencyMs: now() - started };
      } catch {
        return { ok: false, latencyMs: now() - started, error: "error" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
