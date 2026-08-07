/**
 * Where a brand colour comes from now that nobody types one.
 *
 * Asking an operator to pick a hex code was the wrong question: they are
 * onboarding someone else's business, they rarely know its colour, and the
 * field's real effect was that most sites came out in the default blue.
 *
 * Two better answers, in order:
 *   1. The company's existing website, if it has one — its own colour is by
 *      definition the right one, and `website/import.ts` extracts it.
 *   2. The trade. A nail salon and a plumber should not open in the same
 *      shade, and each of these is picked to sit well with its industry's
 *      photography and to pass contrast against white and near-black.
 */

const BY_INDUSTRY: Record<string, string> = {
  hargreidslustofa: '#8b5cf6',
  snyrtistofa: '#db2777',
  naglastofa: '#e11d48',
  nudd: '#0d9488',
  sjukrathjalfun: '#0284c7',
  bilaverkstaedi: '#ea580c',
  dekkjaverkstaedi: '#b45309',
  pipulagnir: '#0369a1',
  rafvirki: '#ca8a04',
  annad: '#4f46e5',
};

export const FALLBACK_BRAND = '#4f46e5';

export function brandColorForIndustry(industry: string): string {
  return BY_INDUSTRY[industry] ?? FALLBACK_BRAND;
}

/** Whether a stored value is a usable colour rather than a leftover blank. */
export function isBrandColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

/**
 * The colour a site should actually render in: whatever was captured from the
 * company's own site if it is valid, otherwise the trade's.
 */
export function resolveBrandColor(stored: string, industry: string): string {
  return isBrandColor(stored) ? stored.trim().toLowerCase() : brandColorForIndustry(industry);
}
