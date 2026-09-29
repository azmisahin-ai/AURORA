/**
 * Text-only DOM builder (ADR 012 §3).
 *
 * The security property of this module is structural: there is **no code path
 * that turns a string into markup**. Every value from the API — agent output,
 * tool observations, and knowledge entries fetched from the open web — is
 * inserted with `textContent`. A payload like `<img src=x onerror=…>` becomes
 * visible characters, which is also the honest thing to show an operator
 * inspecting a suspicious source.
 *
 * A source-guard test asserts that `innerHTML`/`outerHTML`/`insertAdjacentHTML`/
 * `document.write` appear nowhere under `ui/`; a behavioral test can only probe
 * the payloads we thought of, this property is "no such call exists".
 */

/**
 * Create an element. `text` is set with `textContent` — never parsed as HTML.
 * Attributes are applied with `setAttribute`, and a `null`/`undefined` value is
 * skipped rather than stringified to "null".
 */
export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  const { text, class: className, dataset, attrs, on } = options;

  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className !== undefined) node.className = className;
  if (dataset !== undefined) {
    for (const [key, value] of Object.entries(dataset)) {
      if (value !== undefined && value !== null) node.dataset[key] = String(value);
    }
  }
  if (attrs !== undefined) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    }
  }
  if (on !== undefined) {
    for (const [event, handler] of Object.entries(on)) node.addEventListener(event, handler);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Replace a container's contents with the given nodes. */
export function render(container, children) {
  container.replaceChildren();
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    container.append(child);
  }
}

/**
 * A safe external link. Only `http`/`https` become clickable; anything else
 * (notably `javascript:`) is rendered as plain text. This mirrors the
 * `UrlValidator` rule from Phase 3: a source URL from a knowledge entry is data
 * and must not be able to become a clickable script.
 */
export function externalLink(href, label) {
  if (!isSafeHref(href)) return el("span", { text: label ?? href ?? "" });
  return el("a", {
    text: label ?? href,
    attrs: { href, rel: "noopener noreferrer", target: "_blank" },
  });
}

/** True only for absolute http/https URLs. */
export function isSafeHref(href) {
  if (typeof href !== "string") return false;
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

/** Clear a container. */
export function clear(container) {
  container.replaceChildren();
}
