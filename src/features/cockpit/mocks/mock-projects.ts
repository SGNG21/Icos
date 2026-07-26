// MOCK — replace with real API data when endpoint exists
// WARNING: Pure visual mock. Project ≠ Workspace ≠ Client ≠ Tenant.
// These are frontend-only display values — no business logic inferred from names.

import type { ProjectInfo } from "@/features/cockpit/types";

export const mockProjects: ProjectInfo[] = [
  {
    id: "icos",
    displayName: "ICOS",
    active: true,
  },
  {
    id: "polivia",
    displayName: "Polivia",
    active: false,
  },
  {
    id: "clients",
    displayName: "Clients",
    active: false,
  },
];
