/**
 * CERTIFICATION DE LA PASSERELLE D'EXÉCUTION (verrous C8 + C9).
 *
 * Lance de VRAIS agents externes à travers le chemin canonique d'ICOS
 * (`runNonInteractive`), sous le bac à sable réel, avec un HOME jetable et des identifiants
 * accordés par capacité — puis imprime l'évidence. `pnpm certify:gateway`.
 *
 * CE QUE CE SCRIPT PROUVE, quand il rend 0 : que la passerelle sait lancer un exécuteur
 * externe CONFINÉ et en obtenir une réponse. Rien d'autre. Ce n'est pas une mission
 * autonome : le prompt est un jeton à répéter, le worker est en lecture seule, et aucun
 * travail n'est produit.
 *
 * POURQUOI UN SCRIPT ET PAS UN TEST : il dépend de binaires installés sur la machine et
 * d'identifiants réels. Dans la suite, il serait soit sauté en silence (le motif qui a déjà
 * fait croire une suite verte pendant une session entière), soit rouge chez quiconque n'a
 * pas Hermes. L'exécuter est une décision, et son résultat est une pièce datée.
 *
 * AUCUNE VALEUR DE SECRET N'EST IMPRIMÉE. Le rapport porte des noms de capacités, des
 * chemins de programme et des codes de sortie.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  brokerCredentials,
  revokeGrants,
  seedHome,
} from "@/server/workers/process/credential-broker";
import { createEphemeralHome } from "@/server/workers/process/ephemeral-home";
import { runNonInteractive } from "@/server/workers/process/run-process";

/** Un jeton à répéter : borné, en lecture seule, et vérifiable sans juger une réponse. */
const PROBE_TOKEN = "PROBE_OK";
const PROMPT = `Reply with exactly this token and nothing else: ${PROBE_TOKEN}`;

interface Target {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Fichiers du vrai HOME déposés dans le HOME jetable. La capacité, rien de plus. */
  readonly credentials: readonly string[];
  /** Chemins du PROGRAMME, en lecture seule. Distincts des identifiants, délibérément. */
  readonly programPaths: readonly string[];
}

const HOME = process.env.HOME ?? "";

const TARGETS: readonly Target[] = [
  {
    id: "hermes->nvidia-nemotron",
    command: "hermes",
    args: ["-z", PROMPT, "--safe-mode"],
    credentials: [".hermes/config.yaml", ".hermes/auth.json"],
    programPaths: [`${HOME}/.local/bin`, `${HOME}/.hermes/hermes-agent`, `${HOME}/.local/share/uv`],
  },
  {
    id: "codex->gpt-5.6-sol@max",
    command: "codex",
    args: [
      "exec",
      "--model",
      "gpt-5.6-sol",
      /* `max`, pas `xhigh` : la valeur la plus haute réellement acceptée. */
      "-c",
      "model_reasoning_effort=max",
      "--skip-git-repo-check",
      PROMPT,
    ],
    credentials: [".codex/auth.json", ".codex/config.toml"],
    programPaths: [`${HOME}/.local/bin`],
  },
];

async function certify(target: Target) {
  const workspace = await mkdtemp(join(tmpdir(), "icos-gateway-cert-"));
  const home = await createEphemeralHome();
  const startedAt = new Date().toISOString();
  try {
    /*
     * LE COURTIER. Chaque identifiant est une capacité nommée, déposée dans le HOME
     * jetable ; le vrai HOME n'est jamais dans le profil du bac à sable. Un identifiant
     * absent est un refus explicite, pas un départ silencieux.
     */
    const capabilities = target.credentials.map((relativePath) => ({
      id: `${target.id}:${relativePath}`,
      kind: "file" as const,
      target: relativePath,
    }));
    const contents = new Map<string, string>();
    for (const relativePath of target.credentials) {
      const value = await readFile(join(HOME, relativePath), "utf8").catch(() => undefined);
      if (value !== undefined) contents.set(relativePath, value);
    }
    const broker = brokerCredentials(capabilities, (c) => contents.get(c.target));
    if (!broker.ok) {
      return {
        target: target.id,
        result: "BLOCKED_MISSING_CREDENTIAL",
        reason: broker.reason,
        missing: broker.missing,
        startedAt,
      };
    }
    await seedHome(home.path, broker.files);

    const run = await runNonInteractive({
      command: target.command,
      args: [...target.args],
      cwd: workspace,
      env: { HOME: home.path, ...broker.env },
      timeoutMs: 300_000,
      sandbox: {
        readWritePaths: [workspace, home.path],
        readOnlyPaths: [...target.programPaths],
        /* Un fournisseur distant exige le réseau ; il n'est donc PAS appliqué ici. */
        allowNetwork: true,
      },
    });

    return {
      target: target.id,
      result: run.exitCode === 0 && run.stdout.includes(PROBE_TOKEN) ? "PROVEN" : "FAILED",
      executable: target.command,
      confinement: run.confinement,
      networkEnforced: run.networkEnforced,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      workspace,
      startedAt,
      endedAt: new Date().toISOString(),
      /* Des NOMS de capacités et des instants, jamais une valeur. */
      credentialGrants: revokeGrants(broker.grants, new Date().toISOString()).map((g) => ({
        capabilityId: g.capabilityId,
        kind: g.kind,
        target: g.target,
        grantedAt: g.grantedAt,
        revokedAt: g.revokedAt,
      })),
      stdout: run.stdout.trim().slice(0, 400),
      stderrTail: run.stderr.trim().slice(-400),
    };
  } finally {
    /* Le HOME jetable part avec ce qu'il contenait : c'est ce qui rend la révocation vraie. */
    await home.dispose();
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const report = [];
  for (const target of TARGETS) report.push(await certify(target));
  console.log(JSON.stringify({ certifiedAt: new Date().toISOString(), report }, null, 2));
  if (report.some((r) => r.result === "FAILED")) process.exitCode = 1;
}

void main();
