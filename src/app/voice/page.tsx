import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { forbidden, redirect } from "next/navigation";

import { VoiceClient } from "@/components/voice/voice-client";
import { AuthGuardError } from "@/server/auth/errors";
import { requirePermission } from "@/server/auth/guards";
import { getContainer } from "@/server/container";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ICOS — Voix" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

/** Same gate as the voice WebSocket and POST /api/conversation. */
export default async function VoicePage() {
  const container = await getContainer();
  try {
    await requirePermission(container, await headers(), "tasks.write");
  } catch (error) {
    if (!(error instanceof AuthGuardError) || error.code === "forbidden") forbidden();
    redirect("/login?next=%2Fvoice");
  }
  return <VoiceClient />;
}
