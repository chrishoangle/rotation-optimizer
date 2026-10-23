// A read-only view of the schedule for volunteers, carried entirely in a
// link: the snapshot is compressed into the part of the URL after "#", which
// browsers never send to the server. No accounts and no server; a new
// snapshot (and QR code) is needed after each re-plan. Student names are
// never included.

import qrcode from "qrcode-generator";
import { tableNumbers } from "./export";
import type { EventPlan } from "./planning";

export interface Snapshot {
  v: 1;
  t: string; // event name
  at: string; // when it was made, "8:31 PM"
  r: number; // rounds
  c: number; // the round under way or next, when it was made
  f: [number, string, string][]; // table, fam name, location
  h: [string, string, number[]][]; // host table, alum, fam index per round (-1 for none)
}

export function snapshot(p: EventPlan, title: string, at: string, current: number, locations: Record<string, string>): Snapshot {
  const tables = tableNumbers(p);
  const fams = [...p.fams].sort((a, b) => tables[a.groupId] - tables[b.groupId]);
  const index = new Map(fams.map((f, i) => [f.groupId, i]));
  return {
    v: 1, t: title, at, r: p.rounds, c: current,
    f: fams.map((f) => [tables[f.groupId], f.name, locations[f.groupId] ?? ""]),
    h: p.hosts.map((h) => [h.name, h.person, Array.from({ length: p.rounds }, (_, k) => {
      const a = p.assignments.find((x) => x.round === k + 1 && x.hostId === h.hostId);
      return a ? index.get(a.groupId)! : -1;
    })]),
  };
}

const b64url = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeSnapshot(s: Snapshot): Promise<string> {
  return b64url(await pipe(new TextEncoder().encode(JSON.stringify(s)), new CompressionStream("deflate-raw")));
}

export async function decodeSnapshot(text: string): Promise<Snapshot | null> {
  try {
    const s = JSON.parse(new TextDecoder().decode(await pipe(fromB64url(text), new DecompressionStream("deflate-raw"))));
    return s && s.v === 1 && Array.isArray(s.f) && Array.isArray(s.h) ? s : null;
  } catch {
    return null;
  }
}

/** An SVG QR code for a link, sized for a phone camera at arm's length. */
export function qrSvg(link: string): string {
  const q = qrcode(0, "L");
  q.addData(link);
  q.make();
  return q.createSvgTag({ cellSize: 3, margin: 2, scalable: true } as never);
}
