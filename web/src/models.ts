// The same data model as src/rotation_optimizer/models.py and the default
// scorer from scoring.py. Tags are kept as sorted arrays of unique,
// lowercase strings, which is how Python's frozensets print when sorted.

import { pyRound, pySorted } from "./py";

export interface Host {
  hostId: string;
  name: string;
  theme: string;
  tags: string[];
  person: string;
}

export interface GuestGroup {
  groupId: string;
  name: string;
  interests: string[];
  size: number;
  tableNumber: number | null;
  members: string[];
}

export interface Assignment {
  round: number;
  hostId: string;
  groupId: string;
  score: number;
}

function tagSet(tags: Iterable<string>): string[] {
  return pySorted(new Set([...tags].map((t) => t.trim().toLowerCase()).filter((t) => t)));
}

export function makeHost(hostId: string, name: string, theme: string, tags: Iterable<string>, person = ""): Host {
  return { hostId, name, theme, tags: tagSet(tags), person };
}

export function makeGroup(
  groupId: string, name: string, interests: Iterable<string>,
  opts: { size?: number; tableNumber?: number | null; members?: Iterable<string> } = {},
): GuestGroup {
  return {
    groupId, name, interests: tagSet(interests), size: opts.size ?? 0, tableNumber: opts.tableNumber ?? null,
    members: [...(opts.members ?? [])].map((m) => m.trim()).filter((m) => m),
  };
}

/** round(100 * |T ∩ I| / |T ∪ I|), 0 when either side is empty. Matches tag_overlap_score. */
export function tagOverlapScore(host: Host, group: GuestGroup): number {
  if (!host.tags.length || !group.interests.length) return 0;
  const interests = new Set(group.interests);
  const shared = host.tags.filter((t) => interests.has(t)).length;
  const union = new Set([...host.tags, ...group.interests]).size;
  return pyRound((shared / union) * 100);
}

export function scoreMatrix(hosts: Host[], groups: GuestGroup[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const h of hosts) for (const g of groups) out.set(h.hostId + "\u0000" + g.groupId, tagOverlapScore(h, g));
  return out;
}

export const pairKey = (h: string, g: string) => h + "\u0000" + g;
