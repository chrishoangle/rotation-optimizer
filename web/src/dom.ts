// A few DOM helpers so the app can build pages without a framework.

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "className") el.className = String(v);
    else if (k === "value" && "value" in el) (el as HTMLInputElement).value = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function replace(el: HTMLElement, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** Text with **bold** runs, for short guide paragraphs. */
export function rich(text: string): Child[] {
  return text.split(/(\*\*[^*]+\*\*)/).map((part) => (part.startsWith("**") ? h("strong", {}, part.slice(2, -2)) : part));
}

export function download(name: string, data: string | Uint8Array, type: string): void {
  const blob = new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name }) as HTMLAnchorElement;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Open a printout in a new tab, where the coordinator prints it. */
export function openPage(html: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const w = window.open(url, "_blank");
  if (!w) download("printout.html", html, "text/html");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function readFile(file: File): Promise<string> {
  return file.text().then((t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t));
}
