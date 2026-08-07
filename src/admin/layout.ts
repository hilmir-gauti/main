/**
 * Admin console shell: chrome, design system and small UI primitives.
 *
 * Server-rendered HTML with no client framework. The console is used by one
 * person on a laptop; a build pipeline would cost more than it returns, and
 * plain forms keep every action working without JavaScript.
 *
 * The stylesheet below is the whole design system — one place to change how the
 * product looks. It is written against CSS custom properties so light and dark
 * are the same code path, and it ships inline because a single request that
 * always arrives beats a second request that sometimes does not.
 */

import { html, raw, type SafeHtml } from '../core/html.ts';
import { formatISK } from '../core/iceland.ts';
import { formatDateTimeIs } from '../core/time.ts';
import { config } from '../config.ts';
import type { OperatorSession } from '../http/context.ts';

export interface PageOptions {
  title: string;
  session: OperatorSession | null;
  /** Highlights the matching nav item. */
  active?: string;
  breadcrumb?: Array<{ label: string; href?: string }>;
  flash?: { kind: 'gott' | 'villa' | 'upplysing'; text: string } | null;
  wide?: boolean;
  /** Renders without the page chrome — login and first-run setup. */
  bare?: boolean;
}

const NAV = [
  { key: 'stjornbord', label: 'Yfirlit', href: '/stjornbord', icon: 'M3 12h4l3-8 4 16 3-8h4' },
  { key: 'vidskiptavinir', label: 'Viðskiptavinir', href: '/vidskiptavinir', icon: 'M4 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8' },
  { key: 'bokanir', label: 'Bókanir', href: '/bokanir', icon: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4' },
  { key: 'samskipti', label: 'Samskipti', href: '/samskipti', icon: 'M3 6h18v12H3zM3 7l9 6 9-6' },
  { key: 'stillingar', label: 'Stillingar', href: '/stillingar', icon: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-4l-.4 2.4a7 7 0 0 0-1.7 1l-2.3-1-2 3.4L6 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 2.4h4l.4-2.4a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5c.06-.33.1-.66.1-1' },
];

const STYLES = `
/* ---------------------------------------------------------------------------
   Design tokens
--------------------------------------------------------------------------- */
:root{
  --bg:#f6f7fb;
  --bg-grad:radial-gradient(1200px 600px at 100% -10%, #e8eeff 0%, transparent 60%);
  --panel:#ffffff;
  --panel-2:#fbfcfe;
  --ink:#0d1526;
  --ink-2:#334155;
  --muted:#6b7688;
  --border:#e6e9f0;
  --border-2:#eef1f6;

  --brand:#2f56e8;
  --brand-2:#1a3bc4;
  --brand-soft:#eef2ff;
  --brand-ring:rgba(47,86,232,.22);

  --ok:#0b7a5a;      --ok-soft:#e7f7f1;
  --warn:#9a5b06;    --warn-soft:#fdf3e3;
  --bad:#b3261e;     --bad-soft:#fdedec;

  --r-sm:8px; --r:12px; --r-lg:16px; --r-xl:22px;
  --shadow-1:0 1px 2px rgba(13,21,38,.05), 0 1px 3px rgba(13,21,38,.04);
  --shadow-2:0 4px 14px rgba(13,21,38,.07), 0 1px 3px rgba(13,21,38,.05);
  --shadow-3:0 18px 44px rgba(13,21,38,.14);
  --ease:cubic-bezier(.4,0,.2,1);
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#070b14;
    --bg-grad:radial-gradient(1200px 600px at 100% -10%, #12203f 0%, transparent 60%);
    --panel:#0f1626;
    --panel-2:#131c30;
    --ink:#e9eefb;
    --ink-2:#c3cbdd;
    --muted:#8c97ad;
    --border:#1d273c;
    --border-2:#182134;

    --brand:#7ea2ff;
    --brand-2:#a5bcff;
    --brand-soft:#16203a;
    --brand-ring:rgba(126,162,255,.25);

    --ok:#4ade9f;   --ok-soft:#0e2b22;
    --warn:#f5bf5a; --warn-soft:#2b2210;
    --bad:#ff8b83;  --bad-soft:#2e1614;

    --shadow-1:0 1px 2px rgba(0,0,0,.4);
    --shadow-2:0 6px 18px rgba(0,0,0,.45);
    --shadow-3:0 22px 50px rgba(0,0,0,.6);
  }
}

/* ---------------------------------------------------------------------------
   Base
--------------------------------------------------------------------------- */
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);background-image:var(--bg-grad);background-attachment:fixed;
  color:var(--ink);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
a{color:var(--brand);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3{margin:0 0 .4rem;letter-spacing:-.021em;line-height:1.22;font-weight:650}
h1{font-size:1.75rem}
h2{font-size:1.16rem}
h3{font-size:1rem}
p{margin:0 0 .85rem}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px;border-radius:4px}

/* ---------------------------------------------------------------------------
   Top bar
--------------------------------------------------------------------------- */
.topbar{
  position:sticky;top:0;z-index:30;
  background:color-mix(in srgb, var(--panel) 86%, transparent);
  backdrop-filter:saturate(180%) blur(14px);
  border-bottom:1px solid var(--border);
}
.topbar-inner{max-width:1240px;margin-inline:auto;padding:.7rem 1.25rem;display:flex;align-items:center;gap:1.25rem;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:.6rem;font-weight:750;letter-spacing:-.03em;color:inherit;white-space:nowrap}
.brand:hover{text-decoration:none}
.brand-mark{
  width:30px;height:30px;border-radius:9px;display:grid;place-items:center;
  background:linear-gradient(140deg,var(--brand),var(--brand-2));
  color:#fff;font-size:.72rem;font-weight:800;letter-spacing:.02em;
  box-shadow:0 2px 8px var(--brand-ring);
}
.nav{display:flex;gap:.2rem;flex:1;flex-wrap:wrap}
.nav a{
  display:flex;align-items:center;gap:.45rem;
  padding:.44rem .78rem;border-radius:9px;color:var(--muted);font-weight:550;font-size:.93rem;
  transition:background .16s var(--ease), color .16s var(--ease);
}
.nav a svg{width:16px;height:16px;opacity:.75}
.nav a:hover{background:var(--brand-soft);color:var(--brand);text-decoration:none}
.nav a.is-active{background:var(--brand);color:#fff;box-shadow:0 2px 8px var(--brand-ring)}
.nav a.is-active svg{opacity:1}
.who{display:flex;align-items:center;gap:.7rem;color:var(--muted);font-size:.86rem}
.who form{margin:0}
.avatar{
  width:28px;height:28px;border-radius:50%;display:grid;place-items:center;
  background:var(--brand-soft);color:var(--brand);font-weight:700;font-size:.75rem;
}

/* ---------------------------------------------------------------------------
   Page
--------------------------------------------------------------------------- */
.page{max-width:1240px;margin-inline:auto;padding:1.9rem 1.25rem 5rem}
.page.wide{max-width:1480px}
.crumb{font-size:.84rem;color:var(--muted);margin-bottom:.7rem;display:flex;gap:.4rem;flex-wrap:wrap;align-items:center}
.crumb a{color:var(--muted)}
.crumb a:hover{color:var(--brand)}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:1.25rem;flex-wrap:wrap;margin-bottom:1.6rem}
.head .sub{color:var(--muted);margin:.15rem 0 0;font-size:.94rem}

/* ---------------------------------------------------------------------------
   Surfaces
--------------------------------------------------------------------------- */
.panel{
  background:var(--panel);border:1px solid var(--border);border-radius:var(--r-lg);
  padding:1.3rem;box-shadow:var(--shadow-1);
}
.panel+.panel{margin-top:1rem}
.panel > h2:first-child, .panel > h3:first-child{margin-top:0}
.panel-flush{padding:0;overflow:hidden}
.panel-head{padding:1.05rem 1.3rem;border-bottom:1px solid var(--border-2);display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap}
.panel-head h2,.panel-head h3{margin:0}

.grid{display:grid;gap:1rem}
.grid-2{grid-template-columns:repeat(auto-fit,minmax(330px,1fr))}
.grid-3{grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
.grid-4{grid-template-columns:repeat(auto-fit,minmax(195px,1fr))}

/* Stat cards ------------------------------------------------------------- */
.stat{
  position:relative;background:var(--panel);border:1px solid var(--border);
  border-radius:var(--r-lg);padding:1.15rem 1.2rem;box-shadow:var(--shadow-1);overflow:hidden;
}
.stat::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--brand);opacity:.85}
.stat .value{font-size:1.95rem;font-weight:700;line-height:1.05;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.stat .label{color:var(--muted);font-size:.85rem;margin-top:.3rem;font-weight:500}
.stat .hint{color:var(--muted);font-size:.78rem;margin-top:.45rem;opacity:.85}

/* ---------------------------------------------------------------------------
   Tables
--------------------------------------------------------------------------- */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:.93rem}
th{
  text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);
  padding:.6rem .65rem;border-bottom:1px solid var(--border);font-weight:650;white-space:nowrap;
}
td{padding:.78rem .65rem;border-bottom:1px solid var(--border-2);vertical-align:top}
tbody tr{transition:background .12s var(--ease)}
tbody tr:hover{background:var(--panel-2)}
tbody tr:last-child td{border-bottom:0}
td.num{font-variant-numeric:tabular-nums}

/* ---------------------------------------------------------------------------
   Tags
--------------------------------------------------------------------------- */
.tag{
  display:inline-flex;align-items:center;gap:.32rem;padding:.2rem .58rem;border-radius:999px;
  font-size:.75rem;font-weight:650;letter-spacing:.005em;white-space:nowrap;
  background:var(--brand-soft);color:var(--brand);
}
.tag::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.75}
.tag-ok{background:var(--ok-soft);color:var(--ok)}
.tag-warn{background:var(--warn-soft);color:var(--warn)}
.tag-bad{background:var(--bad-soft);color:var(--bad)}
.tag-muted{background:transparent;color:var(--muted);border:1px solid var(--border)}
.tag-plain::before{display:none}

/* ---------------------------------------------------------------------------
   Buttons
--------------------------------------------------------------------------- */
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:.45rem;
  padding:.58rem 1.05rem;border-radius:10px;border:1px solid transparent;
  font:inherit;font-weight:600;font-size:.92rem;cursor:pointer;white-space:nowrap;
  transition:transform .12s var(--ease), box-shadow .16s var(--ease), background .16s var(--ease), border-color .16s var(--ease), color .16s var(--ease);
}
.btn:hover{text-decoration:none}
.btn:active{transform:translateY(1px)}
.btn-primary{background:var(--brand);color:#fff;box-shadow:0 1px 2px var(--brand-ring)}
.btn-primary:hover{background:var(--brand-2);box-shadow:0 4px 14px var(--brand-ring)}
.btn-ghost{background:var(--panel);border-color:var(--border);color:var(--ink-2)}
.btn-ghost:hover{border-color:var(--brand);color:var(--brand);background:var(--brand-soft)}
.btn-danger{background:var(--bad);color:#fff}
.btn-danger:hover{filter:brightness(1.06)}
.btn-sm{padding:.34rem .68rem;font-size:.84rem;border-radius:8px}
.btn-block{width:100%}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.btn-row{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}

/* ---------------------------------------------------------------------------
   Forms
--------------------------------------------------------------------------- */
label{display:block;font-weight:600;margin-bottom:.35rem;font-size:.9rem}
.field{margin-bottom:1.05rem}
.field .help{color:var(--muted);font-size:.83rem;margin:.32rem 0 0;line-height:1.5}
input[type=text],input[type=email],input[type=tel],input[type=password],input[type=number],
input[type=date],input[type=time],input[type=url],select,textarea{
  width:100%;padding:.6rem .78rem;border:1px solid var(--border);border-radius:10px;
  font:inherit;font-size:.94rem;background:var(--panel);color:inherit;
  transition:border-color .14s var(--ease), box-shadow .14s var(--ease);
}
input:hover,select:hover,textarea:hover{border-color:color-mix(in srgb,var(--brand) 35%, var(--border))}
input:focus,select:focus,textarea:focus{
  outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-ring);
}
textarea{resize:vertical;min-height:5rem;line-height:1.6}
select{appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);
  background-position:calc(100% - 17px) calc(50% + 1px),calc(100% - 12px) calc(50% + 1px);
  background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:2.2rem}

.checks{display:grid;gap:.55rem}
.check{
  display:flex;gap:.8rem;align-items:flex-start;padding:.85rem 1rem;
  border:1px solid var(--border);border-radius:var(--r);cursor:pointer;background:var(--panel);
  transition:border-color .14s var(--ease), background .14s var(--ease), box-shadow .14s var(--ease);
}
.check:hover{border-color:var(--brand);background:var(--brand-soft)}
.check:has(input:checked){border-color:var(--brand);box-shadow:inset 0 0 0 1px var(--brand)}
.check input{margin-top:.2rem;width:1.05rem;height:1.05rem;flex-shrink:0;accent-color:var(--brand)}
.check strong{display:block;font-size:.94rem}
.check span span{color:var(--muted);font-size:.85rem;display:block;margin-top:.12rem;line-height:1.5}

/* ---------------------------------------------------------------------------
   Feedback
--------------------------------------------------------------------------- */
.flash{
  display:flex;gap:.7rem;align-items:flex-start;
  padding:.85rem 1.1rem;border-radius:var(--r);margin-bottom:1.4rem;font-weight:500;font-size:.93rem;
  border:1px solid transparent;box-shadow:var(--shadow-1);
}
.flash-gott{background:var(--ok-soft);color:var(--ok);border-color:color-mix(in srgb,var(--ok) 22%,transparent)}
.flash-villa{background:var(--bad-soft);color:var(--bad);border-color:color-mix(in srgb,var(--bad) 22%,transparent)}
.flash-upplysing{background:var(--brand-soft);color:var(--brand);border-color:color-mix(in srgb,var(--brand) 22%,transparent)}
.error-text{color:var(--bad);font-size:.84rem;margin:.32rem 0 0;font-weight:500}

.empty{text-align:center;padding:3rem 1rem;color:var(--muted)}
.empty-mark{
  width:46px;height:46px;border-radius:14px;margin:0 auto .9rem;display:grid;place-items:center;
  background:var(--brand-soft);color:var(--brand);
}
.empty p{margin-bottom:1.1rem}

.progress{height:7px;background:var(--border);border-radius:999px;overflow:hidden}
.progress i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--brand),var(--brand-2));transition:width .5s var(--ease)}

/* ---------------------------------------------------------------------------
   Tabs
--------------------------------------------------------------------------- */
.tabs{display:flex;gap:.1rem;border-bottom:1px solid var(--border);margin-bottom:1.6rem;overflow-x:auto}
.tabs a{
  padding:.62rem .95rem;color:var(--muted);border-bottom:2px solid transparent;
  white-space:nowrap;font-weight:550;font-size:.93rem;transition:color .14s var(--ease), border-color .14s var(--ease);
}
.tabs a:hover{color:var(--ink);text-decoration:none}
.tabs a.is-active{color:var(--brand);border-bottom-color:var(--brand)}

/* ---------------------------------------------------------------------------
   Website variant previews
--------------------------------------------------------------------------- */
.variant{
  background:var(--panel);border:1px solid var(--border);border-radius:var(--r-lg);
  padding:1.1rem;box-shadow:var(--shadow-1);
  transition:transform .18s var(--ease), box-shadow .18s var(--ease), border-color .18s var(--ease);
}
.variant:hover{transform:translateY(-3px);box-shadow:var(--shadow-2)}
.variant.is-chosen{border-color:var(--brand);box-shadow:0 0 0 1px var(--brand), var(--shadow-2)}
.variant-frame{
  position:relative;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;
  background:#fff;height:330px;
}
.variant-frame iframe{width:200%;height:200%;border:0;transform:scale(.5);transform-origin:0 0}
.variant-frame::after{content:'';position:absolute;inset:0;box-shadow:inset 0 -30px 30px -30px rgba(0,0,0,.16);pointer-events:none}

/* ---------------------------------------------------------------------------
   Auth screens (login and first-run)
--------------------------------------------------------------------------- */
.auth-shell{
  min-height:100vh;display:grid;grid-template-columns:1.05fr .95fr;align-items:center;gap:3rem;
  max-width:1080px;margin-inline:auto;padding:2.5rem 1.5rem;
}
.auth-brand{max-width:26rem}
.auth-mark{
  width:52px;height:52px;border-radius:15px;display:grid;place-items:center;margin-bottom:1.4rem;
  background:linear-gradient(140deg,var(--brand),var(--brand-2));color:#fff;
  font-weight:800;font-size:1.05rem;letter-spacing:.02em;box-shadow:0 8px 24px var(--brand-ring);
}
.auth-brand h1{font-size:2.05rem;margin-bottom:.7rem}
.auth-brand > p{color:var(--muted);font-size:1.02rem;line-height:1.65}
.auth-points{list-style:none;padding:0;margin:1.7rem 0 0;display:grid;gap:.62rem}
.auth-points li{display:flex;gap:.6rem;align-items:baseline;color:var(--muted);font-size:.93rem}
.auth-points li::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--brand);flex-shrink:0}
.auth-points strong{color:var(--ink);font-weight:600}
.auth-card{
  background:var(--panel);border:1px solid var(--border);border-radius:var(--r-xl);
  padding:2rem;box-shadow:var(--shadow-3);
}
.auth-card h2{font-size:1.3rem}
.auth-card > .muted{margin-bottom:1.5rem;font-size:.92rem}
.auth-card .btn{margin-top:.35rem}
.auth-foot{margin:1.4rem 0 0;font-size:.82rem;color:var(--muted);line-height:1.6}
@media (max-width:880px){
  .auth-shell{grid-template-columns:1fr;gap:2rem;padding-top:3rem;align-items:start}
  .auth-brand{max-width:none}
  .auth-points{display:none}
}

/* ---------------------------------------------------------------------------
   Utilities
--------------------------------------------------------------------------- */
.muted{color:var(--muted)}
.small{font-size:.85rem}
.mono{font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;font-size:.84rem}
.split{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.stack{display:grid;gap:.3rem}
.copy{
  background:var(--panel-2);border:1px solid var(--border);border-radius:var(--r-sm);
  padding:.5rem .7rem;word-break:break-all;
}
details summary{cursor:pointer;user-select:none}
details summary:hover{color:var(--brand)}
hr{border:0;border-top:1px solid var(--border);margin:1.25rem 0}

@media (prefers-reduced-motion:reduce){
  *{animation:none !important;transition:none !important}
}
@media print{
  .topbar,.btn,.tabs{display:none}
  body{background:#fff}
  .panel{box-shadow:none;border-color:#ddd}
}
`;

function initials(session: OperatorSession): string {
  const source = session.name?.trim() || session.email;
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'RÞ';
}

const FLASH_ICONS: Record<string, string> = {
  gott: 'M20 6 9 17l-5-5',
  villa: 'M12 8v5M12 16.5v.5M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z',
  upplysing: 'M12 16v-5M12 8.5v.5M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z',
};

function icon(path: string, size = 16): SafeHtml {
  return raw(
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<path d="${path}"/></svg>`,
  );
}

export function page(options: PageOptions, content: SafeHtml): SafeHtml {
  return html`<!doctype html>
<html lang="is">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${options.title} — Rafræn Þjónusta</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='15' fill='%232f56e8'/%3E%3Ctext x='32' y='44' font-size='30' font-weight='800' text-anchor='middle' fill='white' font-family='system-ui,sans-serif'%3ERÞ%3C/text%3E%3C/svg%3E">
<style>${raw(STYLES)}</style>
</head>
<body>
${options.session && !options.bare
  ? html`
    <nav class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="/stjornbord">
          <span class="brand-mark">RÞ</span>
          <span>Rafræn Þjónusta</span>
        </a>
        <div class="nav">
          ${NAV.map(
            (item) => html`
              <a href="${item.href}" class="${options.active === item.key ? 'is-active' : ''}">
                ${icon(item.icon)}${item.label}
              </a>`,
          )}
        </div>
        <div class="who">
          <span class="avatar" title="${options.session.email}">${initials(options.session)}</span>
          <form method="post" action="/utskraning">
            <input type="hidden" name="_csrf" value="${options.session.csrfToken}">
            <button class="btn btn-ghost btn-sm" type="submit">Útskrá</button>
          </form>
        </div>
      </div>
    </nav>`
  : ''}

${options.bare
  ? content
  : html`
    <main class="page ${options.wide ? 'wide' : ''}">
      ${options.breadcrumb && options.breadcrumb.length > 0
        ? html`<div class="crumb">
            ${options.breadcrumb.map((crumb, index) =>
              html`${index > 0 ? raw('<span aria-hidden="true">›</span>') : ''}${crumb.href ? html`<a href="${crumb.href}">${crumb.label}</a>` : html`<span>${crumb.label}</span>`}`,
            )}
          </div>`
        : ''}
      ${options.flash
        ? html`<div class="flash flash-${options.flash.kind}">
            ${icon(FLASH_ICONS[options.flash.kind] ?? FLASH_ICONS.upplysing!, 18)}
            <span>${options.flash.text}</span>
          </div>`
        : ''}
      ${content}
    </main>`}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

export function statCard(value: string | number, label: string, hint = ''): SafeHtml {
  return html`
    <div class="stat">
      <div class="value">${value}</div>
      <div class="label">${label}</div>
      ${hint ? html`<div class="hint">${hint}</div>` : ''}
    </div>`;
}

const STATUS_TAGS: Record<string, { cls: string; label: string }> = {
  undirbuningur: { cls: 'tag-warn', label: 'Í uppsetningu' },
  virkur: { cls: 'tag-ok', label: 'Virkur' },
  i_bid: { cls: 'tag-muted', label: 'Í bið' },
  haett: { cls: 'tag-bad', label: 'Hætt' },
  bidur: { cls: 'tag-muted', label: 'Bíður' },
  i_vinnslu: { cls: 'tag-warn', label: 'Í vinnslu' },
  lokid: { cls: 'tag-ok', label: 'Lokið' },
  stopp: { cls: 'tag-bad', label: 'Stopp' },
  sleppt: { cls: 'tag-muted', label: 'Sleppt' },
  stadfest: { cls: 'tag-ok', label: 'Staðfest' },
  beidni: { cls: 'tag-warn', label: 'Beiðni' },
  maett: { cls: 'tag-ok', label: 'Mætt' },
  afbokad: { cls: 'tag-bad', label: 'Afbókað' },
  ekki_maett: { cls: 'tag-bad', label: 'Mætti ekki' },
  sent: { cls: 'tag-ok', label: 'Sent' },
  villa: { cls: 'tag-bad', label: 'Villa' },
  thurrkeyrsla: { cls: 'tag-muted', label: 'Þurrkeyrsla' },
};

export function statusTag(status: string): SafeHtml {
  const entry = STATUS_TAGS[status] ?? { cls: '', label: status };
  return html`<span class="tag ${entry.cls}">${entry.label}</span>`;
}

export function emptyState(message: string, action?: { label: string; href: string }): SafeHtml {
  return html`
    <div class="empty">
      <div class="empty-mark">${icon('M4 6h16v14H4zM4 10h16M9 3v4M15 3v4', 22)}</div>
      <p>${message}</p>
      ${action ? html`<a class="btn btn-primary" href="${action.href}">${action.label}</a>` : ''}
    </div>`;
}

export function csrfField(session: OperatorSession | null): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${session?.csrfToken ?? ''}">`;
}

export function money(amount: number): string {
  return formatISK(amount);
}

export function when(instant: number, timezone = config.defaults.timezone): string {
  return formatDateTimeIs(instant, timezone, { year: true });
}

export { icon };
