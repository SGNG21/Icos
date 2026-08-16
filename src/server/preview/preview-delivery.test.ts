import { describe, expect, it } from "vitest";

import { PreviewDelivery } from "./preview-delivery";

describe("PreviewDelivery", () => {
  const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const BRANCH = "integration/candidate";

  describe("deliver (V1 local only)", () => {
    it("returns LOCAL_RESULT_READY by default", async () => {
      const delivery = new PreviewDelivery();
      const result = await delivery.deliver(SHA, BRANCH);

      expect(result.status).toBe("LOCAL_RESULT_READY");
      expect(result.integrationSha).toBe(SHA);
      expect(result.integrationBranch).toBe(BRANCH);
      expect(result.summary).toContain(SHA.slice(0, 12));
    });

    it("includes the integration branch in the result", async () => {
      const delivery = new PreviewDelivery();
      const result = await delivery.deliver(SHA, BRANCH);

      expect(result.integrationBranch).toBe(BRANCH);
    });

    it("reports WAITING_FOR_HUMAN when external preview requested", async () => {
      const delivery = new PreviewDelivery({ allowExternalPreview: true });
      const result = await delivery.deliver(SHA, BRANCH);

      expect(result.status).toBe("WAITING_FOR_HUMAN");
      expect(result.humanGateReason).toBe("EXTERNAL_PREVIEW_REQUIRES_APPROVAL");
    });

    it("reports duration", async () => {
      const delivery = new PreviewDelivery();
      const result = await delivery.deliver(SHA, BRANCH);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.completedAt).toBeDefined();
    });

    it("never exposes client credentials", async () => {
      const delivery = new PreviewDelivery();
      const result = await delivery.deliver(SHA, BRANCH);

      // V1 ne touche à aucun système externe
      expect(result.status).toBe("LOCAL_RESULT_READY");
      const forbidden = ["credential", "token", "api_key", "secret", "password"];
      for (const term of forbidden) {
        expect(result.summary.toLowerCase()).not.toContain(term);
      }
    });
  });
});
