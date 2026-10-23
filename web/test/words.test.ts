import { describe, expect, it } from "vitest";
import { closeWords } from "../src/words";

describe("close words", () => {
  it("let an alum in medicine match a biology or pre-med fam", () => {
    expect(closeWords(["medicine"]).map(([w]) => w)).toEqual(["biology", "pre-med"]);
    expect(closeWords(["medicine"])[0]).toEqual(["biology", "medicine"]);
  });

  it("add nothing an alum already has, and nothing for words it does not know", () => {
    expect(closeWords(["medicine", "biology", "pre-med"])).toEqual([]);
    expect(closeWords(["film"])).toEqual([]);
  });
});
