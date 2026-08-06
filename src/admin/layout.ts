/**
 * Admin console shell: shared chrome, styles and small UI primitives.
 *
 * Server-rendered HTML with no client framework. The console is used by one
 * person on a laptop; a build pipeline would cost more than it returns, and
 * plain forms keep every action working without JavaScript.
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
  /** Breadcrumb shown above the page heading. */
  breadcrumb?: Array<{ label: string; href?: string }>;
  /** Flash message from a redirect. */
  flash?: { kind: 'gott' | 'villa' | 'upplysing'; text: string } | null;
  wide?: boolean;
}

const NAV = [
  { key: 'stjornbord', label: 'Yfirlit', href: '/stjornbord' },
  { key: 'vidskiptavinir', label: 'Viðskiptavinir', href: '/vidskiptavinir' },
  { key: 'bokanir', label: 'Bókanir', href: '/bokanir' },
  { key: 'samskipti', label: 'Samskipti', href: '/samskipti' },
  { key: 'stillingar', label: 'Stillingar', href: '/stillingar' },
];

const STYLES = `
:root{
  --bg:#f5f7fb; --panel:#ffffff; --ink:#0f172a; --muted:#64748b; --border:#e2e8f0;
  --brand:#1d4ed8; --brand-soft:#eff4ff; --ok:#047857; --ok-soft:#ecfdf5;
  --warn:#b45309; --warn-soft:#fffbeb; --bad:#b91c1c; --bad-soft:#fef2f2;
  --radius:12px; color-scheme:light dark;
}
@media (prefers-color-scheme:dark){
  :root{ --bg:#080d19; --panel:#111a2c; --ink:#e6ecf8; --muted:#94a3b8; --border:#1e293b;
         --brand:#6ea8fe; --brand-soft:#16233c; --ok:#34d399; --ok-soft:#0f2a22;
         --warn:#fbbf24; --warn-soft:#2a2110; --bad:#f87171; --bad-soft:#2c1416; }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
     font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
a{color:var(--brand)}
h1{font-size:1.65rem;margin:0 0 .35rem}
h2{font-size:1.2rem;margin:0 0 .75rem}
h3{font-size:1rem;margin:0 0 .5rem}
p{margin:0 0 .85rem}

.topbar{background:var(--panel);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:20}
.topbar-inner{max-width:1200px;margin-inline:auto;padding:.75rem 1.25rem;display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap}
.brand{font-weight:800;letter-spacing:-.02em;text-decoration:none;color:inherit;white-space:nowrap}
.brand span{color:var(--brand)}
.nav{display:flex;gap:.35rem;flex:1;flex-wrap:wrap}
.nav a{padding:.45rem .8rem;border-radius:8px;text-decoration:none;color:var(--muted);font-weight:500}
.nav a:hover{background:var(--brand-soft);color:var(--brand)}
.nav a.is-active{background:var(--brand);color:#fff}
.topbar form{margin:0}
.who{color:var(--muted);font-size:.85rem;display:flex;align-items:center;gap:.75rem}

.page{max-width:1200px;margin-inline:auto;padding:1.75rem 1.25rem 4rem}
.page.wide{max-width:1440px}
.crumb{font-size:.85rem;color:var(--muted);margin-bottom:.75rem}
.crumb a{color:var(--muted)}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem}
.head .sub{color:var(--muted);margin:0}

.panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem}
.panel+.panel{margin-top:1rem}
.grid{display:grid;gap:1rem}
.grid-2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.grid-3{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.grid-4{grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}

.stat{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:1.1rem}
.stat .value{font-size:1.9rem;font-weight:700;line-height:1.1}
.stat .label{color:var(--muted);font-size:.85rem;margin-top:.2rem}
.stat .hint{color:var(--muted);font-size:.78rem;margin-top:.4rem}

table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
   padding:.55rem .6rem;border-bottom:1px solid var(--border);font-weight:600}
td{padding:.7rem .6rem;border-bottom:1px solid var(--border);vertical-align:top}
tr:last-child td{border-bottom:0}
.table-wrap{overflow-x:auto}

.tag{display:inline-block;padding:.18rem .55rem;border-radius:999px;font-size:.75rem;font-weight:600;
     background:var(--brand-soft);color:var(--brand);white-space:nowrap}
.tag-ok{background:var(--ok-soft);color:var(--ok)}
.tag-warn{background:var(--warn-soft);color:var(--warn)}
.tag-bad{background:var(--bad-soft);color:var(--bad)}
.tag-muted{background:transparent;color:var(--muted);border:1px solid var(--border)}

.btn{display:inline-block;padding:.6rem 1.1rem;border-radius:9px;border:1px solid transparent;font:inherit;
     font-weight:600;cursor:pointer;text-decoration:none;text-align:center}
.btn-primary{background:var(--brand);color:#fff}
.btn-primary:hover{filter:brightness(.93)}
.btn-ghost{background:transparent;border-color:var(--border);color:inherit}
.btn-ghost:hover{border-color:var(--brand);color:var(--brand)}
.btn-danger{background:var(--bad);color:#fff}
.btn-sm{padding:.35rem .7rem;font-size:.85rem}
.btn-row{display:flex;gap:.6rem;flex-wrap:wrap}

label{display:block;font-weight:600;margin-bottom:.35rem;font-size:.92rem}
.field{margin-bottom:1.1rem}
.field .help{color:var(--muted);font-size:.85rem;margin:.3rem 0 0}
input[type=text],input[type=email],input[type=tel],input[type=password],input[type=number],input[type=date],
input[type=time],input[type=url],select,textarea{
  width:100%;padding:.6rem .75rem;border:1px solid var(--border);border-radius:9px;font:inherit;
  background:var(--panel);color:inherit}
input:focus,select:focus,textarea:focus{outline:2px solid var(--brand);outline-offset:1px;border-color:var(--brand)}
textarea{resize:vertical;min-height:5rem}
.checks{display:grid;gap:.6rem}
.check{display:flex;gap:.75rem;align-items:flex-start;padding:.85rem 1rem;border:1px solid var(--border);
       border-radius:10px;cursor:pointer;background:var(--panel)}
.check:hover{border-color:var(--brand)}
.check input{margin-top:.25rem;width:1.05rem;height:1.05rem;flex-shrink:0}
.check strong{display:block}
.check span{color:var(--muted);font-size:.87rem}

.flash{padding:.85rem 1.1rem;border-radius:10px;margin-bottom:1.25rem;font-weight:500}
.flash-gott{background:var(--ok-soft);color:var(--ok)}
.flash-villa{background:var(--bad-soft);color:var(--bad)}
.flash-upplysing{background:var(--brand-soft);color:var(--brand)}
.error-text{color:var(--bad);font-size:.85rem;margin-top:.3rem}

.muted{color:var(--muted)}
.small{font-size:.85rem}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85rem}
.empty{text-align:center;padding:2.5rem 1rem;color:var(--muted)}
.progress{height:8px;background:var(--border);border-radius:999px;overflow:hidden}
.progress i{display:block;height:100%;background:var(--brand)}
.tabs{display:flex;gap:.3rem;border-bottom:1px solid var(--border);margin-bottom:1.5rem;overflow-x:auto}
.tabs a{padding:.6rem .95rem;text-decoration:none;color:var(--muted);border-bottom:2px solid transparent;
        white-space:nowrap;font-weight:500}
.tabs a.is-active{color:var(--brand);border-bottom-color:var(--brand)}
.split{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.copy{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:.5rem .7rem;
      word-break:break-all}
`;

export function page(options: PageOptions, content: SafeHtml): SafeHtml {
  return html`<!doctype html>
<html lang="is">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${options.title} — Rafræn Þjónusta</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231d4ed8'/%3E%3Ctext x='32' y='45' font-size='34' font-weight='700' text-anchor='middle' fill='white' font-family='sans-serif'%3ER%3C/text%3E%3C/svg%3E">
<style>${raw(STYLES)}</style>
</head>
<body>
${options.session
  ? html`
    <nav class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="/stjornbord">Rafræn <span>Þjónusta</span></a>
        <div class="nav">
          ${NAV.map(
            (item) => html`<a href="${item.href}" class="${options.active === item.key ? 'is-active' : ''}">${item.label}</a>`,
          )}
        </div>
        <div class="who">
          <span>${options.session.email}</span>
          <form method="post" action="/utskraning">
            <input type="hidden" name="_csrf" value="${options.session.csrfToken}">
            <button class="btn btn-ghost btn-sm" type="submit">Útskrá</button>
          </form>
        </div>
      </div>
    </nav>`
  : ''}
<main class="page ${options.wide ? 'wide' : ''}">
  ${options.breadcrumb && options.breadcrumb.length > 0
    ? html`<div class="crumb">
        ${options.breadcrumb.map((crumb, index) =>
          html`${index > 0 ? raw(' &rsaquo; ') : ''}${crumb.href ? html`<a href="${crumb.href}">${crumb.label}</a>` : crumb.label}`,
        )}
      </div>`
    : ''}
  ${options.flash ? html`<div class="flash flash-${options.flash.kind}">${options.flash.text}</div>` : ''}
  ${content}
</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Small view helpers
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
