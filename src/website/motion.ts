/**
 * The moving parts of a generated site: entrance animation, scroll reveals,
 * a header that reacts to scrolling, and a per-trade backdrop.
 *
 * Three constraints shape all of it.
 *
 * **It has to stay one file.** These sites are published to a CDN as a single
 * self-contained HTML document, so there is no animation library and no web
 * font — everything here is CSS keyframes plus about forty lines of script.
 *
 * **It has to stay cheap.** Only `transform` and `opacity` are animated, which
 * the compositor can run without laying the page out again. A salon's site
 * gets opened on a four-year-old phone over 4G.
 *
 * **It has to be possible to turn off.** Every animation is wrapped in
 * `prefers-reduced-motion: no-preference`, so a visitor who has asked their
 * system for less movement gets a still page — not a degraded one. Content is
 * visible by default and animation only ever moves something that is already
 * there, so the page is complete even if the script never runs.
 */

import type { Palette } from './theme.ts';

/**
 * A decorative backdrop for the hero, chosen by trade.
 *
 * Generated sites have no photography — the operator has none to give — so the
 * hero would otherwise be a coloured rectangle. These are abstract enough to
 * never look like clip art and specific enough that a garage does not open
 * with the same flourish as a nail salon.
 */
export function heroMotif(template: string, palette: Palette): string {
  const brand = palette.brand;

  switch (template) {
    // Flowing strands — hair, beauty, nails.
    case 'stofa':
      return `<svg class="motif" viewBox="0 0 600 400" fill="none" aria-hidden="true" focusable="false">
        <g stroke="${brand}" stroke-width="1.5" opacity=".5">
          ${Array.from({ length: 9 }, (_, i) => {
            const offset = i * 34;
            return `<path d="M${-40 + offset} 420 C ${120 + offset} 300, ${40 + offset} 160, ${200 + offset} -20"/>`;
          }).join('')}
        </g>
      </svg>`;

    // Concentric rings, like a wheel or a bearing.
    case 'verkstaedi':
      return `<svg class="motif" viewBox="0 0 600 400" fill="none" aria-hidden="true" focusable="false">
        <g stroke="${brand}" opacity=".45">
          ${[60, 105, 150, 195, 240].map((r, i) =>
            `<circle cx="430" cy="200" r="${r}" stroke-width="${i % 2 === 0 ? 2 : 1}"/>`).join('')}
        </g>
        <g stroke="${brand}" stroke-width="2" opacity=".3">
          ${Array.from({ length: 12 }, (_, i) => {
            const angle = (i * Math.PI) / 6;
            const x1 = 430 + Math.cos(angle) * 60;
            const y1 = 200 + Math.sin(angle) * 60;
            const x2 = 430 + Math.cos(angle) * 240;
            const y2 = 200 + Math.sin(angle) * 240;
            return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}"/>`;
          }).join('')}
        </g>
      </svg>`;

    // Right-angled runs, like pipe or conduit.
    case 'idnadarmadur':
      return `<svg class="motif" viewBox="0 0 600 400" fill="none" aria-hidden="true" focusable="false">
        <g stroke="${brand}" stroke-width="3" opacity=".4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M60 340 H200 V180 H340 V300 H520"/>
          <path d="M120 400 V260 H260 V60 H460 V200 H600"/>
          <path d="M0 120 H140 V40"/>
        </g>
        <g fill="${brand}" opacity=".5">
          ${[[200, 180], [340, 180], [340, 300], [260, 260], [260, 60], [460, 60], [460, 200], [140, 120]]
            .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5"/>`).join('')}
        </g>
      </svg>`;

    // A calm pulse line.
    case 'heilsa':
      return `<svg class="motif" viewBox="0 0 600 400" fill="none" aria-hidden="true" focusable="false">
        <path d="M-20 220 H150 l30 -70 30 140 30 -110 25 40 H600"
              stroke="${brand}" stroke-width="3" opacity=".55" stroke-linecap="round" stroke-linejoin="round"/>
        <g stroke="${brand}" stroke-width="1" opacity=".25">
          ${[120, 170, 270, 320].map((y) => `<path d="M-20 ${y} H600"/>`).join('')}
        </g>
      </svg>`;

    default:
      return `<svg class="motif" viewBox="0 0 600 400" fill="none" aria-hidden="true" focusable="false">
        <g stroke="${brand}" opacity=".35">
          ${Array.from({ length: 7 }, (_, i) =>
            `<rect x="${330 + i * 12}" y="${70 + i * 12}" width="200" height="200" rx="28" stroke-width="1.5"/>`).join('')}
        </g>
      </svg>`;
  }
}

/**
 * Film grain.
 *
 * A single SVG turbulence tile, inlined as a data URI and tiled over the page
 * at very low opacity. This is the cheapest trick in the file and the one that
 * does the most work: large flat gradients read as "template" because real
 * printed and photographed surfaces are never perfectly smooth, and a few
 * percent of noise is enough to break that.
 */
const GRAIN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='.42'/%3E%3C/svg%3E")`;

/**
 * Shared motion and layout CSS, appended after the variant's own rules so a
 * variant can still override anything here.
 */
export function motionStyles(palette: Palette): string {
  return `
/* --- Display typography ----------------------------------------------
   No web fonts are loaded, so character has to come from how the system
   stack is set rather than from which font it is: heavy weights, tight
   tracking, and a line height under 1 at display sizes. */
.hero h1{font-size:clamp(2.6rem,7.5vw,5.5rem);font-weight:850;letter-spacing:-.045em;
  line-height:.95;text-wrap:balance}
.hero .lead{font-size:clamp(1.1rem,1.9vw,1.4rem);max-width:36ch;line-height:1.45;text-wrap:pretty}
h2{letter-spacing:-.035em;font-weight:800;font-size:clamp(1.9rem,4.2vw,3rem);text-wrap:balance}
.eyebrow{font-size:.72rem;letter-spacing:.18em}

/* The headline is filled with a gradient where that is supported. The colour
   is set first so an unsupporting browser shows solid ink rather than
   nothing: color:transparent with no background-clip is invisible text. */
.hero h1{color:inherit}
@supports ((-webkit-background-clip:text) or (background-clip:text)){
  .hero-midja h1,.hero-mynd h1{
    background:linear-gradient(115deg,var(--ink) 0%,var(--ink) 25%,var(--brand) 78%,var(--brand-dark) 100%);
    -webkit-background-clip:text;background-clip:text;color:transparent}
  .hero-skipt h1{
    background:linear-gradient(115deg,#fff 0%,#fff 40%,color-mix(in srgb,var(--brand) 60%,#fff) 100%);
    -webkit-background-clip:text;background-clip:text;color:transparent}
}

/* --- Grain ------------------------------------------------------------ */
.grain{position:fixed;inset:0;z-index:60;pointer-events:none;opacity:.035;
  background-image:${GRAIN};background-size:140px 140px;mix-blend-mode:overlay}
@media (prefers-color-scheme:dark){.grain{opacity:.055}}

/* --- Reading progress ------------------------------------------------- */
.progress{position:fixed;top:0;left:0;height:2px;width:0;z-index:70;
  background:linear-gradient(90deg,var(--brand),var(--brand-dark));
  box-shadow:0 0 12px color-mix(in srgb,var(--brand) 70%,transparent)}

/* --- Layered hero backdrop ------------------------------------------- */
.hero{position:relative;isolation:isolate}
/* A mesh of off-centre radial gradients reads as depth in a way a linear
   gradient never does. */
.hero::before{content:'';position:absolute;inset:0;z-index:0;pointer-events:none;
  background:
    radial-gradient(60% 50% at 12% 18%,color-mix(in srgb,var(--brand) 26%,transparent),transparent 70%),
    radial-gradient(45% 45% at 88% 12%,color-mix(in srgb,var(--brand-dark) 22%,transparent),transparent 70%),
    radial-gradient(55% 60% at 70% 92%,color-mix(in srgb,var(--brand) 18%,transparent),transparent 70%)}
/* The aura sits above the hero's own background but below its copy, so it is
   visible on the dark split hero as well as on the light ones. */
.hero-aura{position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.hero-aura span{position:absolute;display:block;border-radius:50%;filter:blur(70px);opacity:.34}
.hero-aura span:nth-child(1){width:44vw;height:44vw;min-width:300px;min-height:300px;
  left:-12vw;top:-20vw;background:${palette.brand}}
.hero-aura span:nth-child(2){width:32vw;height:32vw;min-width:220px;min-height:220px;
  right:-10vw;bottom:-18vw;background:${palette.brandDark};opacity:.26}
.hero-aura span:nth-child(3){width:24vw;height:24vw;min-width:170px;min-height:170px;
  right:24vw;top:-10vw;background:${palette.brand};opacity:.16}
.motif{position:absolute;right:0;top:50%;translate:0 -50%;width:min(58%,620px);
  z-index:0;pointer-events:none;opacity:.55}
/* The split hero's right half is a solid panel, so the motif moves left. */
.hero-skipt .motif{right:auto;left:-3%;width:min(50%,540px);opacity:.3}
.hero .wrap,.hero-grid,.hero-copy,.hero-inner{position:relative;z-index:1}

.btn-sm{padding:.55rem 1.05rem;font-size:.92rem}

/* A phone number is never worth breaking across lines; below that the two
   hero buttons stack full width rather than squeezing side by side. */
.hero-actions .btn{white-space:nowrap}
@media (max-width:560px){
  .hero-actions{flex-direction:column;align-items:stretch}
  .hero-actions .btn{width:100%}
}

/* Anchor targets must clear the sticky header, or a nav click lands with the
   heading hidden underneath it. */
.section[id],#top{scroll-margin-top:5.5rem}

/* --- Sticky header ---------------------------------------------------- */
.sitenav{position:sticky;top:0;z-index:40;transition:box-shadow .25s ease,background-color .25s ease}
.sitenav-inner{display:flex;align-items:center;gap:1.25rem;
  padding-block:.85rem;transition:padding-block .25s ease}
.sitenav.is-stuck{background:color-mix(in srgb,var(--surface) 82%,transparent);
  backdrop-filter:saturate(1.6) blur(14px);-webkit-backdrop-filter:saturate(1.6) blur(14px);
  box-shadow:0 1px 0 var(--border),0 10px 30px -18px rgba(2,6,23,.45)}
.sitenav.is-stuck .sitenav-inner{padding-block:.6rem}
.brandmark{display:flex;align-items:center;gap:.6rem;font-weight:800;letter-spacing:-.02em;
  text-decoration:none;color:inherit;font-size:1.02rem}
.brandmark .dot{width:11px;height:11px;border-radius:50%;background:var(--brand);flex:none;
  box-shadow:0 0 0 4px color-mix(in srgb,var(--brand) 22%,transparent)}
.navlinks{display:flex;gap:1.4rem;margin-left:auto;list-style:none;padding:0;margin-block:0}
.navlinks a{color:var(--muted);text-decoration:none;font-size:.94rem;font-weight:500;
  position:relative;padding-block:.2rem}
.navlinks a::after{content:'';position:absolute;left:0;right:100%;bottom:0;height:2px;
  background:var(--brand);border-radius:2px;transition:right .25s ease}
.navlinks a:hover{color:var(--ink)}
.navlinks a:hover::after{right:0}
.nav-cta{flex:none}
@media (max-width:860px){.navlinks{display:none}}

/* --- Buttons ---------------------------------------------------------- */
.btn{position:relative;overflow:hidden;transition:transform .18s cubic-bezier(.34,1.4,.64,1),
  box-shadow .18s ease,background-color .18s ease}
.btn-primary{box-shadow:0 8px 22px -10px color-mix(in srgb,var(--brand) 85%,transparent)}
.btn:hover{transform:translateY(-2px)}
.btn:active{transform:translateY(0)}
.btn-primary::after{content:'';position:absolute;inset:0;background:linear-gradient(120deg,
  transparent 20%,rgba(255,255,255,.28) 50%,transparent 80%);translate:-120% 0}

/* --- Scroll reveal ---------------------------------------------------- */
.reveal{opacity:1}

/* --- Section rhythm ---------------------------------------------------
   Every section being the same white block is what makes a generated page
   read as a template. One full-bleed dark section breaks the run and gives
   the booking step — the thing the page exists for — its own weight. */
.section-dark{background:var(--ink);color:#fff;border-top:0;position:relative;overflow:hidden}
.section-dark::before{content:'';position:absolute;inset:0;pointer-events:none;
  background:
    radial-gradient(50% 60% at 15% 0%,color-mix(in srgb,var(--brand) 40%,transparent),transparent 70%),
    radial-gradient(45% 70% at 95% 100%,color-mix(in srgb,var(--brand-dark) 35%,transparent),transparent 70%)}
.section-dark>*{position:relative;z-index:1}
.section-dark h2{color:#fff}
.section-dark .section-title p{color:rgba(255,255,255,.66)}
/* The booking widget brings its own light palette and inherits text colour in
   places, so it gets a light card rather than the section's white-on-dark
   context — otherwise its option labels come out white on white. */
.section-dark .booking-shell{background:var(--surface);color:var(--ink);
  border-color:transparent;box-shadow:0 40px 80px -40px rgba(2,6,23,.8)}

/* --- Marquee ----------------------------------------------------------
   A full-bleed band of what the business actually does. It carries no
   information the page does not already have; its job is to interrupt the
   column of centred sections with something horizontal. */
.marquee{overflow:hidden;border-block:1px solid var(--border);
  background:var(--surface-alt);padding-block:1.05rem;
  -webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);
  mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent)}
.marquee-track{display:flex;width:max-content}
.marquee-run{display:flex;align-items:center}
.marquee-run span{display:inline-flex;align-items:center;gap:2.4rem;white-space:nowrap;
  padding-right:2.4rem;font-size:clamp(1rem,1.8vw,1.35rem);font-weight:750;
  letter-spacing:-.025em;color:var(--muted)}
.marquee-run span::after{content:'';width:7px;height:7px;border-radius:50%;
  background:var(--brand);flex:none}

/* --- Cards and rows --------------------------------------------------- */
.service-card,.service-item{position:relative;transition:transform .22s ease,box-shadow .22s ease,
  border-color .22s ease;overflow:hidden}
.service-card:hover,.service-item:hover{border-color:color-mix(in srgb,var(--brand) 45%,var(--border))}

/* A soft light that follows the pointer. Purely decorative, and it costs one
   custom property per card rather than a repaint. */
.service-card::before{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  opacity:0;transition:opacity .3s ease;
  background:radial-gradient(260px circle at var(--mx,50%) var(--my,50%),
    color-mix(in srgb,var(--brand) 18%,transparent),transparent 68%)}
.service-card:hover::before{opacity:1}

/* Numbering gives the list a spine and fills the space a photograph would. */
.service-card{padding-top:2.9rem}
.service-card .num{position:absolute;top:1.15rem;left:1.5rem;font-size:.78rem;font-weight:800;
  letter-spacing:.1em;color:color-mix(in srgb,var(--brand) 75%,transparent);font-variant-numeric:tabular-nums}
.service-card .price{font-size:1.35rem;letter-spacing:-.02em}

.stat-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
  background:var(--border);border:1px solid var(--border);border-radius:var(--corner);overflow:hidden}
.stat{background:var(--surface);padding:1.4rem 1.25rem;text-align:center}
.stat strong{display:block;font-size:clamp(1.7rem,3.2vw,2.4rem);letter-spacing:-.04em;line-height:1;
  font-weight:850;font-variant-numeric:tabular-nums}
.stat span{font-size:.82rem;color:var(--muted);display:block;margin-top:.3rem}
.stat-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
  background:var(--border);border:1px solid var(--border);border-radius:var(--corner);overflow:hidden}
.stat{background:var(--surface);padding:1.15rem 1.25rem;text-align:center}
.stat strong{display:block;font-size:1.5rem;letter-spacing:-.02em;line-height:1.15}
.stat span{font-size:.84rem;color:var(--muted)}

/* --- FAQ -------------------------------------------------------------- */
.faq details{border:1px solid var(--border);border-radius:var(--corner);
  padding:.35rem 1.15rem;background:var(--surface);margin-bottom:.6rem;transition:border-color .2s ease}
.faq details[open]{border-color:color-mix(in srgb,var(--brand) 40%,var(--border))}
.faq summary{cursor:pointer;font-weight:650;padding-block:.85rem;list-style:none;
  display:flex;align-items:center;gap:.75rem}
.faq summary::-webkit-details-marker{display:none}
.faq summary::before{content:'';width:9px;height:9px;border-right:2px solid var(--brand);
  border-bottom:2px solid var(--brand);rotate:-45deg;translate:0 -2px;flex:none;transition:rotate .22s ease}
.faq details[open] summary::before{rotate:45deg;translate:0 -3px}
.faq p{margin:0 0 .95rem;color:var(--muted)}

/* --- Sticky call-to-action on phones ---------------------------------- */
.cta-bar{position:fixed;left:0;right:0;bottom:0;z-index:50;display:none;gap:.6rem;padding:.7rem
  max(.7rem,env(safe-area-inset-left)) max(.7rem,env(safe-area-inset-bottom));
  background:color-mix(in srgb,var(--surface) 92%,transparent);
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  border-top:1px solid var(--border);translate:0 110%}
.cta-bar .btn{flex:1;text-align:center;padding-block:.75rem}
@media (max-width:720px){
  .cta-bar{display:flex}
  body{padding-bottom:4.5rem}
}

/* --- Focus ------------------------------------------------------------ */
a:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible{
  outline:3px solid color-mix(in srgb,var(--brand) 60%,transparent);outline-offset:2px;border-radius:6px}

html{scroll-behavior:auto}

/* ======================================================================
   Everything above is static. Motion is added only for visitors who have
   not asked their system for less of it.
   ====================================================================== */
@media (prefers-reduced-motion: no-preference){
  html{scroll-behavior:smooth}

  .hero-aura span{animation:drift 22s ease-in-out infinite alternate}
  .hero-aura span:nth-child(2){animation-duration:28s;animation-delay:-6s}
  .hero-aura span:nth-child(3){animation-duration:19s;animation-delay:-11s}
  @keyframes drift{
    from{transform:translate3d(0,0,0) scale(1)}
    to{transform:translate3d(4%,6%,0) scale(1.12)}
  }

  .motif{animation:motif-in 1.5s .25s cubic-bezier(.22,1,.36,1) both}
  @keyframes motif-in{from{opacity:0;transform:translateX(28px)}to{opacity:.6;transform:none}}

  /* Hero copy arrives in sequence rather than all at once. */
  .hero-copy>*,.hero-inner>*,.hero .wrap>*{animation:rise .8s cubic-bezier(.22,1,.36,1) both}
  .hero-copy>*:nth-child(1),.hero-inner>*:nth-child(1),.hero .wrap>*:nth-child(1){animation-delay:.05s}
  .hero-copy>*:nth-child(2),.hero-inner>*:nth-child(2),.hero .wrap>*:nth-child(2){animation-delay:.14s}
  .hero-copy>*:nth-child(3),.hero-inner>*:nth-child(3),.hero .wrap>*:nth-child(3){animation-delay:.23s}
  .hero-copy>*:nth-child(4),.hero-inner>*:nth-child(4),.hero .wrap>*:nth-child(4){animation-delay:.32s}
  .hero-copy>*:nth-child(5),.hero-inner>*:nth-child(5),.hero .wrap>*:nth-child(5){animation-delay:.41s}
  @keyframes rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}

  /* Reveals are opt-in: the class is only added once the observer runs, so
     a page whose script fails still shows everything. */
  .js-reveal .reveal{opacity:0;transform:translateY(22px);
    transition:opacity .7s cubic-bezier(.22,1,.36,1),transform .7s cubic-bezier(.22,1,.36,1)}
  .js-reveal .reveal.is-in{opacity:1;transform:none}
  .js-reveal .reveal-stagger>*{opacity:0;transform:translateY(20px);
    transition:opacity .6s cubic-bezier(.22,1,.36,1),transform .6s cubic-bezier(.22,1,.36,1)}
  .js-reveal .reveal-stagger.is-in>*{opacity:1;transform:none}
  ${[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    `.js-reveal .reveal-stagger.is-in>*:nth-child(${n}){transition-delay:${(n - 1) * 70}ms}`).join('')}

  .service-card:hover,.service-item:hover{transform:translateY(-4px);
    box-shadow:0 22px 42px -24px rgba(2,6,23,.5)}

  .btn-primary:hover::after{animation:sheen .7s ease}
  @keyframes sheen{to{translate:120% 0}}

  .cta-bar{transition:translate .35s cubic-bezier(.22,1,.36,1)}
  .cta-bar.is-in{translate:0 0}

  /* The track holds two identical copies, so translating by exactly half its
     width lands back on an identical frame and the loop is seamless. */
  .marquee-track{animation:marquee 34s linear infinite}
  .marquee:hover .marquee-track{animation-play-state:paused}
  @keyframes marquee{to{transform:translateX(-50%)}}

  /* Parallax on the motif, driven by a custom property the script sets. */
  .motif{translate:0 calc(-50% + var(--par,0px))}
}

@media (prefers-reduced-motion: reduce){
  .cta-bar{translate:0 0}
  /* Without animation the track would still be twice as wide as it needs to
     be, so the duplicate is dropped rather than left hanging off-screen. */
  .marquee-track>.marquee-run:nth-child(2){display:none}
}
`;
}

/**
 * The script that drives the reveals.
 *
 * It adds `js-reveal` to the document itself before observing anything: the
 * hiding rules are scoped to that class, so if this never runs — script
 * blocked, parse error, ancient browser — nothing is hidden and the page is
 * simply static.
 */
export function motionScript(): string {
  return `
(function () {
  var root = document.documentElement;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var nav = document.querySelector('.sitenav');
  var progress = document.querySelector('.progress');
  var motif = document.querySelector('.motif');

  // One scroll listener for everything, and all the writing happens inside a
  // single animation frame so a fast scroll cannot queue up layout thrash.
  var ticking = false;
  var onScroll = function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      var y = window.scrollY;
      if (nav) nav.classList.toggle('is-stuck', y > 8);
      if (progress) {
        var max = document.documentElement.scrollHeight - innerHeight;
        progress.style.width = (max > 0 ? Math.min(y / max, 1) * 100 : 0) + '%';
      }
      if (motif && !reduced && y < innerHeight) motif.style.setProperty('--par', (y * 0.12) + 'px');
      ticking = false;
    });
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  var bar = document.querySelector('.cta-bar');
  if (bar) {
    var hero = document.querySelector('.hero');
    if (hero && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          bar.classList.toggle('is-in', !entry.isIntersecting);
        });
      }, { rootMargin: '-60px 0px 0px 0px' }).observe(hero);
    } else {
      bar.classList.add('is-in');
    }
  }

  if (reduced || !('IntersectionObserver' in window)) return;

  root.classList.add('js-reveal');

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-in');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

  document.querySelectorAll('.reveal, .reveal-stagger').forEach(function (node) {
    observer.observe(node);
  });

  // Pointer-following highlight. Coordinates go into custom properties so the
  // gradient moves without touching layout.
  document.querySelectorAll('.service-card').forEach(function (card) {
    card.addEventListener('pointermove', function (event) {
      var rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', (event.clientX - rect.left) + 'px');
      card.style.setProperty('--my', (event.clientY - rect.top) + 'px');
    });
  });

  // Counting up the stats. Only whole numbers are animated — "Strax" is a word
  // and counting to it would be nonsense.
  var counters = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      counters.unobserve(entry.target);

      var node = entry.target;
      var target = parseInt(node.textContent, 10);
      if (!isFinite(target) || String(target) !== node.textContent.trim()) return;

      var started = null;
      var step = function (now) {
        if (started === null) started = now;
        var t = Math.min((now - started) / 900, 1);
        // Ease out, so it decelerates into the final number.
        node.textContent = String(Math.round(target * (1 - Math.pow(1 - t, 3))));
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }, { threshold: 0.6 });

  document.querySelectorAll('.stat strong').forEach(function (node) {
    counters.observe(node);
  });
})();
`;
}
