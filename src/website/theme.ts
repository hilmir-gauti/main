/**
 * Website design variants.
 *
 * The wizard generates every variant from the same content and shows them side
 * by side, so the operator picks a finished page rather than describing one.
 * Each variant is a complete design decision — typography, layout, colour
 * treatment — not a colour swap, because a hairdresser and a garage should not
 * end up with the same page in different shades.
 *
 * Colours are derived from the tenant's brand colour so a variant still looks
 * like *their* business.
 */

export type VariantKey = 'klassiskt' | 'nutima' | 'hlyleg';

export interface Variant {
  key: VariantKey;
  label: string;
  description: string;
  /** Which industries this design suits best, used to order the previews. */
  suits: string[];
  fonts: {
    heading: string;
    body: string;
  };
  layout: {
    /** Hero treatment. */
    hero: 'midja' | 'skipt' | 'mynd';
    /** Service list presentation. */
    services: 'spjold' | 'listi' | 'verdskra';
    corner: string;
    /** Maximum content width. */
    width: string;
  };
  /** Extra CSS appended after the shared base. */
  css: (palette: Palette) => string;
}

export interface Palette {
  brand: string;
  brandDark: string;
  brandLight: string;
  ink: string;
  muted: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  onBrand: string;
}

// ---------------------------------------------------------------------------
// Colour derivation
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return [
    Number.parseInt(full.slice(0, 2), 16) || 0,
    Number.parseInt(full.slice(2, 4), 16) || 0,
    Number.parseInt(full.slice(4, 6), 16) || 0,
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function mix(hex: string, target: string, amount: number): string {
  const [r1, g1, b1] = hexToRgb(hex);
  const [r2, g2, b2] = hexToRgb(target);
  return rgbToHex(r1 + (r2 - r1) * amount, g1 + (g2 - g1) * amount, b1 + (b2 - b1) * amount);
}

/**
 * Relative luminance, used to decide whether text on the brand colour should
 * be white or near-black. A yellow brand colour with white text is unreadable,
 * and small businesses pick yellow more often than you would think.
 */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function buildPalette(brandColor: string, dark = false): Palette {
  const brand = /^#[0-9a-fA-F]{6}$/.test(brandColor) ? brandColor : '#1d4ed8';
  const onBrand = luminance(brand) > 0.55 ? '#111827' : '#ffffff';

  if (dark) {
    return {
      brand,
      brandDark: mix(brand, '#000000', 0.35),
      brandLight: mix(brand, '#ffffff', 0.25),
      ink: '#f8fafc',
      muted: '#94a3b8',
      surface: '#0b1120',
      surfaceAlt: '#141c2e',
      border: '#1f2a3d',
      onBrand,
    };
  }

  return {
    brand,
    brandDark: mix(brand, '#000000', 0.25),
    brandLight: mix(brand, '#ffffff', 0.85),
    ink: '#0f172a',
    muted: '#64748b',
    surface: '#ffffff',
    surfaceAlt: '#f7f8fb',
    border: '#e5e9f0',
    onBrand,
  };
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

const SYSTEM_SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;
const SYSTEM_SERIF = `'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif`;

export const VARIANTS: Variant[] = [
  {
    key: 'klassiskt',
    label: 'Klassískt',
    description: 'Ljós og hrein síða með serif-fyrirsögnum. Traustvekjandi og tímalaus — hentar vel rótgrónum fyrirtækjum.',
    suits: ['sjukrathjalfun', 'pipulagnir', 'rafvirki', 'bilaverkstaedi'],
    fonts: { heading: SYSTEM_SERIF, body: SYSTEM_SANS },
    layout: { hero: 'midja', services: 'verdskra', corner: '6px', width: '1060px' },
    css: (p) => `
      .hero { text-align:center; padding:clamp(3.5rem,9vw,6.5rem) 0 clamp(3rem,7vw,5rem);
              background:linear-gradient(180deg, ${p.brandLight} 0%, ${p.surface} 100%); }
      .hero h1 { font-size:clamp(2.2rem,5.5vw,3.6rem); letter-spacing:-.015em; }
      .hero .lead { max-width:38rem; margin-inline:auto; }
      .hero-actions { justify-content:center; }
      .rule { width:64px; height:3px; background:${p.brand}; margin:1.5rem auto 0; border-radius:2px; }
      .service-row { display:flex; gap:1.25rem; align-items:baseline;
                     padding:1.1rem 0; border-bottom:1px solid ${p.border}; }
      .service-row:last-child { border-bottom:0; }
      .service-row .dots { flex:1; border-bottom:1px dotted ${p.border}; transform:translateY(-.35em); }
      .service-row .price { font-weight:700; white-space:nowrap; }
      .section-title { text-align:center; }
      .section-title p { margin-inline:auto; }
    `,
  },
  {
    key: 'nutima',
    label: 'Nútímalegt',
    description: 'Dökkur og djarfur hluti efst með sterkri leturgerð og skiptri uppsetningu. Sker sig úr og virkar vel á síma.',
    suits: ['hargreidslustofa', 'naglastofa', 'snyrtistofa', 'dekkjaverkstaedi'],
    fonts: { heading: SYSTEM_SANS, body: SYSTEM_SANS },
    layout: { hero: 'skipt', services: 'spjold', corner: '18px', width: '1140px' },
    css: (p) => `
      .hero { padding:0; background:${p.ink}; color:#fff; overflow:hidden; }
      .hero-grid { display:grid; grid-template-columns:1.05fr .95fr; gap:0; align-items:stretch; }
      .hero-copy { padding:clamp(3rem,7vw,5.5rem) clamp(1.25rem,4vw,3.5rem); align-self:center; }
      .hero h1 { font-size:clamp(2.3rem,5.5vw,4rem); font-weight:800; letter-spacing:-.03em; line-height:1.04; }
      .hero .lead { color:#cbd5e1; }
      .hero-panel { background:linear-gradient(145deg, ${p.brand} 0%, ${p.brandDark} 100%);
                    min-height:320px; display:grid; place-items:center; padding:2rem; color:${p.onBrand}; }
      .hero-panel .badge-stack { display:grid; gap:.85rem; }
      .hero-panel .badge-stack div { background:rgba(255,255,255,.14); backdrop-filter:blur(6px);
                                     padding:.7rem 1.15rem; border-radius:999px; font-weight:600; font-size:.95rem; }
      .service-card { border:1px solid ${p.border}; border-radius:18px; padding:1.5rem;
                      background:${p.surface}; transition:transform .18s ease, box-shadow .18s ease; }
      .service-card:hover { transform:translateY(-3px); box-shadow:0 14px 34px rgba(15,23,42,.10); }
      .service-card .price { color:${p.brand}; font-weight:800; font-size:1.15rem; }
      @media (max-width:820px) { .hero-grid { grid-template-columns:1fr; } .hero-panel { min-height:200px; } }
    `,
  },
  {
    key: 'hlyleg',
    label: 'Hlýlegt',
    description: 'Mjúkir litir, rúnnuð form og loftgott útlit. Persónulegt og aðgengilegt — hentar minni stofum vel.',
    suits: ['nudd', 'snyrtistofa', 'naglastofa', 'hargreidslustofa', 'annad'],
    fonts: { heading: SYSTEM_SANS, body: SYSTEM_SANS },
    layout: { hero: 'mynd', services: 'listi', corner: '26px', width: '1000px' },
    css: (p) => `
      body { background:${p.surfaceAlt}; }
      .hero { padding:clamp(2rem,5vw,3.5rem) 0; }
      .hero-inner { background:${p.brandLight}; border-radius:32px;
                    padding:clamp(2.5rem,6vw,4.5rem) clamp(1.5rem,5vw,4rem); position:relative; overflow:hidden; }
      .hero-inner::after { content:''; position:absolute; right:-90px; top:-90px; width:280px; height:280px;
                           border-radius:50%; background:${p.brand}; opacity:.12; }
      .hero h1 { font-size:clamp(2.1rem,5vw,3.3rem); letter-spacing:-.02em; }
      .hero .lead { max-width:34rem; }
      .card, .service-item, .panel { background:${p.surface}; border-radius:26px; border:1px solid ${p.border}; }
      .service-item { display:flex; gap:1.25rem; align-items:center; padding:1.25rem 1.5rem; margin-bottom:.85rem; }
      .service-item .meta { flex:1; }
      .service-item .price { font-weight:700; color:${p.brand}; white-space:nowrap; }
      .section { padding-block:clamp(2.5rem,6vw,4rem); }
    `,
  },
];

export function variantByKey(key: string): Variant {
  return VARIANTS.find((variant) => variant.key === key) ?? VARIANTS[0]!;
}

/** Variants ordered so the best fit for this trade is shown first. */
export function variantsForIndustry(industry: string): Variant[] {
  return [...VARIANTS].sort((a, b) => {
    const aFits = a.suits.includes(industry) ? 0 : 1;
    const bFits = b.suits.includes(industry) ? 0 : 1;
    return aFits - bFits;
  });
}
