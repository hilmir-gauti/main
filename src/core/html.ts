/**
 * Escaping-by-default HTML templating.
 *
 * Both the admin console and the generated tenant websites interpolate data
 * that originates outside the platform — business descriptions, customer
 * names, phone-call transcripts. The `html` tagged template escapes every
 * interpolated value unless it is explicitly wrapped in `raw()`, so the unsafe
 * path is the one you have to type out on purpose.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/**
 * Marks a string as already-safe HTML.
 *
 * Written with an explicit field rather than a constructor parameter property,
 * because Node's type-stripping mode (`--experimental-strip-types`, used by the
 * dev server and test runner) rejects parameter properties — they would require
 * emitting code, not just erasing types.
 */
export class SafeHtml {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

/** Trust this string verbatim. Only for markup you generated yourself. */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value === true) return '';
  return escapeHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + (strings[i + 1] ?? '');
  }
  return new SafeHtml(out);
}

/** Escapes a value for use inside a `<script>` JSON block. */
export function jsonScript(value: unknown): SafeHtml {
  const json = JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return new SafeHtml(json);
}

/**
 * Builds a `class` attribute value from conditional parts:
 * `classes('btn', isPrimary && 'btn-primary')`
 */
export function classes(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Escapes text for inclusion in XML (sitemaps, TwiML). */
export function escapeXml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}
