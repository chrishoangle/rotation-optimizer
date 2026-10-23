// A small set of line icons, always shown beside a word and hidden from
// screen readers. 20px, 1.5px stroke, drawn in the current text colour.

const PATHS = {
  check: '<path d="M5 10.5l3.2 3.2L15 7"/>',
  dot: '<circle cx="10" cy="10" r="3.5" fill="currentColor" stroke="none"/>',
  people: '<circle cx="7.5" cy="7" r="2.5"/><path d="M3 16c.5-2.6 2.3-4 4.5-4s4 1.4 4.5 4"/><circle cx="13.5" cy="7.5" r="2"/><path d="M13 12c2 0 3.5 1.2 4 3.5"/>',
  table: '<ellipse cx="10" cy="9" rx="7" ry="3"/><path d="M10 12v5M7 17h6"/>',
  calendar: '<rect x="3.5" y="4.5" width="13" height="12" rx="2"/><path d="M3.5 8.5h13M7 3v3M13 3v3"/>',
  printer: '<path d="M6 8V3.5h8V8"/><rect x="3.5" y="8" width="13" height="6" rx="1.5"/><path d="M6 12.5h8v4H6z"/>',
  clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2"/>',
  swap: '<path d="M4 7h11l-3-3M16 13H5l3 3"/>',
  chevron: '<path d="M8 5l5 5-5 5"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H8l1.5 2h6A1.5 1.5 0 0 1 17 8.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z"/>',
  play: '<circle cx="10" cy="10" r="7"/><path d="M8.5 7.2v5.6L13 10z" fill="currentColor"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  sparkle: '<path d="M10 3.5l1.5 4.5 4.5 1.5-4.5 1.5-1.5 4.5-1.5-4.5L4 9.5l4.5-1.5z"/>',
  bell: '<path d="M6 13.5V9a4 4 0 0 1 8 0v4.5l1.5 1.5h-11z"/><path d="M8.5 17h3"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, className = ""): HTMLElement {
  const span = document.createElement("span");
  span.className = `c-icon ${className}`.trim();
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`;
  return span;
}
