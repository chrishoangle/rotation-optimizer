import highsLoader from "highs";
import { beforeAll, describe, expect, it } from "vitest";
import { makeGroup, makeHost } from "../src/models";
import { planEvent } from "../src/planning";
import { backupPacketHtml, coordinatorGuideHtml, planSummaryHtml, privacyNoteHtml, roleCardsHtml } from "../src/printables";
import type { HighsLike } from "../src/solver";

let highs: HighsLike;
beforeAll(async () => { highs = (await highsLoader()) as unknown as HighsLike; });

const JARGON = [/\bundefined\b/, /\bnull\b/, /\bNaN\b/, /\bJSON\b/, /\bslots?\b/, /\(s\)/, /\u2014|\u2013/];
const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ");

describe("pages for the team", () => {
  it("guide, role cards, and privacy note are plain words", () => {
    for (const page of [coordinatorGuideHtml("Transfer Dinner"), roleCardsHtml("Transfer Dinner"), privacyNoteHtml()]) {
      expect(page.startsWith("<!doctype html>")).toBe(true);
      for (const j of JARGON) expect(text(page)).not.toMatch(j);
    }
    expect(text(coordinatorGuideHtml("Transfer Dinner"))).toContain("An alum doesn&#x27;t show up, or has to leave");
    expect(text(roleCardsHtml("X")).match(/Questions: ask the coordinator\./g)).toHaveLength(4);
  });

  it("backup packet and plan summary hold every pairing", () => {
    const hosts = [makeHost("h1", "Law", "Law", ["law"], "Alum A"), makeHost("h2", "Art", "Art", ["art"])];
    const fams = [makeGroup("f1", "Fam <Red>", ["law"], { tableNumber: 1 }), makeGroup("f2", "Fam Blue", ["art"], { tableNumber: 2 }), makeGroup("f3", "Fam Gold", [], { tableNumber: 3 })];
    const p = planEvent(highs, hosts, fams, 2);
    const packet = backupPacketHtml(p, "Dinner", "7:12 PM");
    expect(packet).toContain("Fam &lt;Red&gt;");
    expect(packet).toContain("as printed at 7:12 PM");
    expect((packet.match(/<h2>Round \d<\/h2>/g) ?? []).length).toBe(2);
    const summary = planSummaryHtml(p, "Dinner", ["Law must meet Fam Blue in round 2"], "Table 7 is loud.");
    expect(summary).toContain("pairings share at least one interest");
    expect(summary).toContain("Law must meet Fam Blue in round 2");
    expect(summary).toContain("Table 7 is loud.");
    for (const j of JARGON) expect(text(packet + summary)).not.toMatch(j);
  });
});

describe("print everything", () => {
  it("bundles each printout into its own isolated part", async () => {
    const { printEverythingHtml } = await import("../src/printables");
    const a = "<!doctype html><html><head><style>@page { size: letter; } body { color: red; } .x { color: blue; }</style></head><body><p class=\"x\">One</p></body></html>";
    const b = "<!doctype html><html><head><style>html, body { margin: 0; }</style></head><body><p>Two</p></body></html>";
    const out = printEverythingHtml("Dinner <1>", [["Seating chart", a], ["Host cards", b]]);
    expect(out.match(/<div class="part"/g)).toHaveLength(2);
    expect(out.match(/<template>/g)).toHaveLength(2);
    expect(out).toContain(":host { color: red; }");
    expect(out).toContain(":host { margin: 0; }");
    expect(out).not.toContain("@page { size: letter; }");
    expect(out).toContain("Dinner &lt;1&gt;");
    expect(out).not.toMatch(/\u2014|\u2013/);
  });
});
