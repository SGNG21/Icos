import { describe, expect, it, vi } from "vitest";

const protectRoute = vi.fn();
const getContainer = vi.fn();

vi.mock("@/server/http/protect-route", () => ({ protectRoute }));
vi.mock("@/server/container", () => ({ getContainer }));

const { GET } = await import("./route");

describe("GET /api/supervisor/objectives", () => {
  it("refuses before reading anything when the session fails the gate", async () => {
    const container = { goalRepository: { list: vi.fn() } };
    getContainer.mockResolvedValue(container);
    protectRoute.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });

    const res = await GET(new Request("http://localhost/api/supervisor/objectives"));

    expect(res.status).toBe(403);
    expect(container.goalRepository.list).not.toHaveBeenCalled();
  });

  it("requires cockpit.read", async () => {
    getContainer.mockResolvedValue({ goalRepository: { list: vi.fn(async () => []) } });
    protectRoute.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });

    await GET(new Request("http://localhost/api/supervisor/objectives"));

    expect(protectRoute).toHaveBeenCalledWith(
      expect.objectContaining({ permission: "cockpit.read", route: "api.supervisor.objectives" }),
    );
  });

  it("exposes no write verb", async () => {
    const mod = await import("./route");
    expect(mod).not.toHaveProperty("POST");
    expect(mod).not.toHaveProperty("PUT");
    expect(mod).not.toHaveProperty("PATCH");
    expect(mod).not.toHaveProperty("DELETE");
  });
});
