import { describe, expect, it } from "vitest";

import { currentAttribution, runWithAttribution } from "./attribution-context";

/**
 * Ce qui est prouvé ici : l'absence reste une absence, la portée survit aux `await`, deux
 * portées simultanées ne se mélangent pas. Rien d'autre — ce module n'a pas d'autre rôle.
 */

describe("attribution-context", () => {
  it("rend null hors de toute portée : jamais une imputation fabriquée", () => {
    expect(currentAttribution()).toBeNull();
  });

  it("rend l'imputation courante dans la portée", () => {
    const seen = runWithAttribution({ goalId: "g1" }, () => currentAttribution());
    expect(seen).toEqual({ goalId: "g1" });
  });

  it("survit aux await et aux promesses créées dans la portée", async () => {
    const seen = await runWithAttribution({ goalId: "g1" }, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentAttribution();
    });
    expect(seen).toEqual({ goalId: "g1" });
  });

  it("rétablit l'extérieur à la sortie, y compris sur une erreur", () => {
    expect(() =>
      runWithAttribution({ goalId: "g1" }, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(currentAttribution()).toBeNull();
  });

  it("n'imbrique pas deux missions l'une dans l'autre : la portée interne gagne", () => {
    const seen = runWithAttribution({ goalId: "outer" }, () => ({
      inner: runWithAttribution({ goalId: "inner" }, () => currentAttribution()),
      after: currentAttribution(),
    }));
    expect(seen.inner).toEqual({ goalId: "inner" });
    expect(seen.after).toEqual({ goalId: "outer" });
  });

  it("isole deux portées réellement simultanées", async () => {
    const run = (goalId: string) =>
      runWithAttribution({ goalId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, goalId === "a" ? 5 : 1));
        return currentAttribution();
      });
    expect(await Promise.all([run("a"), run("b")])).toEqual([{ goalId: "a" }, { goalId: "b" }]);
  });
});
