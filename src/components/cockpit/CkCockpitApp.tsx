"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

import { CkSupervisorSurface } from "@/components/cockpit/CkSupervisorSurface";
import type {
  CockpitHttpClient,
  CockpitJobProjection,
  CockpitJobStatus,
} from "@/features/cockpit/clients";
import {
  CockpitHttpError,
  createCockpitHttpClient,
} from "@/features/cockpit/http-clients";

export type CockpitUiState =
  | "idle"
  | "submitting"
  | "polling"
  | "succeeded"
  | "failed"
  | "blocked"
  | "network-error";

export interface CockpitViewState {
  phase: CockpitUiState;
  snapshot?: CockpitJobProjection;
  error?: string;
  jobId?: string;
}

interface SubmissionAttempt {
  objective: string;
  idempotencyKey: string;
  jobId?: string;
}

interface CockpitControllerOptions {
  createIdempotencyKey?: () => string;
  pollIntervalMs?: number;
}

const TERMINAL_PHASES: Record<
  Extract<CockpitJobStatus, "SUCCEEDED" | "FAILED" | "BLOCKED">,
  CockpitUiState
> = {
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  BLOCKED: "blocked",
};

export class CockpitController {
  private state: CockpitViewState = { phase: "idle" };
  private readonly listeners = new Set<() => void>();
  private readonly createIdempotencyKey: () => string;
  private readonly pollIntervalMs: number;
  private attempt?: SubmissionAttempt;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private disposed = false;

  constructor(
    private readonly client: CockpitHttpClient,
    options: CockpitControllerOptions = {},
  ) {
    this.createIdempotencyKey = options.createIdempotencyKey ?? (() => crypto.randomUUID());
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  getSnapshot = (): CockpitViewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async submit(objective: string): Promise<void> {
    if (objective.trim().length === 0) {
      this.update({
        ...this.state,
        error: "Un objectif non vide est requis.",
      });
      return;
    }
    if (this.state.phase === "submitting" || this.state.phase === "polling") return;

    this.replaceMission();
    this.attempt = {
      objective,
      idempotencyKey: this.createIdempotencyKey(),
    };
    await this.submitAttempt();
  }

  async retry(): Promise<void> {
    if (this.state.phase !== "network-error" || !this.attempt) return;
    if (this.attempt.jobId) {
      this.update({
        phase: "polling",
        snapshot: this.state.snapshot,
        jobId: this.attempt.jobId,
      });
      await this.pollNow(this.generation);
      return;
    }
    await this.submitAttempt();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.clearWork();
    this.listeners.clear();
  }

  private async submitAttempt(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || this.disposed) return;
    const generation = this.generation;
    this.update({ phase: "submitting" });
    const request = new AbortController();
    this.request = request;

    try {
      const job = await this.client.submitJob(
        attempt.objective,
        attempt.idempotencyKey,
        request.signal,
      );
      if (!this.isCurrent(generation, request)) return;
      this.request = undefined;
      attempt.jobId = job.jobId;
      this.update({ phase: "polling", snapshot: job, jobId: job.jobId });
      await this.pollNow(generation);
    } catch (reason) {
      if (!this.isCurrent(generation, request) || isAbortError(reason)) return;
      this.request = undefined;
      this.update({
        phase: "network-error",
        error: toClientError(reason),
      });
    }
  }

  private async pollNow(generation: number): Promise<void> {
    const attempt = this.attempt;
    if (!attempt?.jobId || this.request || !this.isGenerationCurrent(generation)) return;
    const request = new AbortController();
    this.request = request;

    try {
      const job = await this.client.getJob(attempt.jobId, request.signal);
      if (!this.isCurrent(generation, request)) return;
      this.request = undefined;
      const terminalPhase =
        job.status === "SUCCEEDED" || job.status === "FAILED" || job.status === "BLOCKED"
          ? TERMINAL_PHASES[job.status]
          : undefined;
      if (terminalPhase) {
        this.update({ phase: terminalPhase, snapshot: job, jobId: attempt.jobId });
        return;
      }
      this.update({ phase: "polling", snapshot: job, jobId: attempt.jobId });
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.pollNow(generation);
      }, this.pollIntervalMs);
    } catch (reason) {
      if (!this.isCurrent(generation, request) || isAbortError(reason)) return;
      this.request = undefined;
      this.update({
        phase: "network-error",
        snapshot: this.state.snapshot,
        error: toClientError(reason),
        jobId: attempt.jobId,
      });
    }
  }

  private replaceMission(): void {
    this.generation += 1;
    this.clearWork();
  }

  private clearWork(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.request?.abort();
    this.request = undefined;
  }

  private isGenerationCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private isCurrent(generation: number, request: AbortController): boolean {
    return this.isGenerationCurrent(generation) && this.request === request;
  }

  private update(state: CockpitViewState): void {
    if (this.disposed) return;
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

export function CkCockpitApp() {
  const client = useMemo(() => createCockpitHttpClient(), []);
  return <CkCockpitClient client={client} />;
}

export function CkCockpitClient({ client }: { client: CockpitHttpClient }) {
  const controller = useMemo(() => new CockpitController(client), [client]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => () => controller.dispose(), [controller]);

  return (
    <CkSupervisorSurface
      snapshot={state.snapshot}
      uiState={state.phase}
      error={state.error}
      onSubmitObjective={(objective) => controller.submit(objective)}
      onRetry={() => controller.retry()}
    />
  );
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}

function toClientError(reason: unknown): string {
  return reason instanceof CockpitHttpError
    ? reason.message
    : "La communication avec le Cockpit a échoué.";
}
