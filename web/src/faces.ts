// Faces for people and colours for tables, shared by the coordinator app
// and the walkthrough: initials in a soft circle, two overlapping for a pair.

import { h } from "./dom";

/** The people at one alumni table: one alum, or a pair written "Sam Rivera & Priya Shah". */
export function peopleIn(name: string): string[] {
  return (name ?? "").split(/\s*&\s*|\s*\+\s*|\s+\/\s+|\s+and\s+/i).map((x) => x.trim()).filter(Boolean);
}

/** Initials in a soft circle, coloured by name so the same person always looks the same. */
export function avatar(name: string): HTMLElement {
  const words = name.trim().split(/\s+/).filter((w) => w && !/^(dr|prof|mr|mrs|ms)\.?$/i.test(w));
  const initials = ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : words[0]?.[1] ?? "")).toUpperCase();
  let hue = 0;
  for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return h("span", { className: "c-avatar", style: `--h: ${hue}`, "aria-hidden": "true" }, initials);
}

/** One avatar for an alum, two overlapping for a pair. */
export function avatars(who: string): HTMLElement {
  const people = peopleIn(who);
  return h("span", { className: `c-avatars ${people.length > 1 ? "pair" : ""}`, "aria-hidden": "true" }, (people.length ? people : [who]).map(avatar));
}

/** A soft colour for each fam table, the same on every screen. */
export const famHue = (n: number) => (n * 47 + 200) % 360;
