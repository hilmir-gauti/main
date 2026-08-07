/**
 * Admin console routes — the operator's whole interface.
 *
 * Server-rendered pages and plain form posts. Every mutating route is behind
 * `requireOperator` and `csrfProtect`, applied once as router middleware so a
 * new route cannot accidentally ship unprotected.
 */

import { all, get } from '../core/db.ts';
import { ValidationError, isAppError } from '../core/errors.ts';
import { html, jsonScript, raw, type SafeHtml } from '../core/html.ts';
import { formatKennitala, normalizePhone } from '../core/iceland.ts';
import { logger } from '../core/logger.ts';
import {
  addDays,
  formatDateIs,
  formatDateTimeIs,
  formatDurationIs,
  formatTimeIs,
  instantFromWallClock,
  minutesToHhmm,
  plainDateOf,
  relativeIs,
  type PlainDate,
  type Weekday,
} from '../core/time.ts';
import { upcomingHolidays } from '../core/holidays.ts';
import { config, integrationStatus, useSecureCookies } from '../config.ts';
import { buildInfo, buildLabel } from '../version.ts';
import { SESSION_COOKIE, login, logout, operatorCount } from '../domain/auth.ts';
import {
  bookingStats,
  bookingsOnDate,
  cancelBooking,
  completeBooking,
  confirmBooking,
  getBookingOrThrow,
  listBookings,
  markAttended,
  markNoShow,
  upcomingBookings,
} from '../domain/booking/bookings.ts';
import { createService, listServices, listStaff, updateService } from '../domain/catalog.ts';
import { flowForIndustry, flowSummary } from '../domain/intake/flows.ts';
import { bookingAnswerSummary } from '../domain/intake/service.ts';
import { INDUSTRIES, industryLabel, industryPreset } from '../domain/industries.ts';
import { lookupCompanyProfile } from '../domain/lookup.ts';
import { brandColorForIndustry } from '../website/palette-defaults.ts';
import { importSite } from '../website/import.ts';
import {
  activateTenant,
  listTasks,
  progress,
  provisionTenant,
  setTaskStatus,
} from '../domain/provisioning.ts';
import { weeklyHoursMap } from '../domain/schedule.ts';
import {
  createTenant,
  getFeatures,
  getTenantOrThrow,
  listTenants,
  updateTenant,
  validateTenantInput,
} from '../domain/tenants.ts';
import { FEATURES, FEATURE_LABELS, type Feature } from '../domain/types.ts';
import { SETTING_KEYS, saveSettings } from '../domain/settings.ts';
import { buildEmailPlan, verifyEmailDns, type EmailProvider } from '../integrations/email/provisioning.ts';
import { listMessages, testSmtpConnection } from '../integrations/email/mailer.ts';
import { checkSmtpSettings, diagnoseSmtpError } from '../integrations/email/diagnose.ts';
import { recordSmtpTest, lastSmtpTest } from '../domain/settings.ts';
import { buildAuthUrl, exchangeCode, isCalendarLinked, parseState, saveGoogleAccount, unlinkGoogleAccount } from '../integrations/google/oauth.ts';
import { calendarStatus, syncBusyBlocks } from '../integrations/google/calendar.ts';
import { createPairingInvite, listDevices, pendingInvite } from '../integrations/push/devices.ts';
import { listNotifications } from '../integrations/push/expo.ts';
import { webhookUrls } from '../integrations/twilio.ts';
import { csrfProtect, loadSession, requireOperator } from '../http/middleware.ts';
import { htmlResponse, json, redirect, serializeCookie, withCookie } from '../http/response.ts';
import { Router } from '../http/router.ts';
import type { RequestContext } from '../http/context.ts';
import { chosenVariant, generateVariants, latestBuild, listVariants, publishVariant } from '../website/generator.ts';
import { deployPublishedSite, hostingStatus } from '../website/hosting.ts';
import { servePreview } from '../publicapi/routes.ts';
import { csrfField, emptyState, icon, money, page, statCard, statusTag, when } from './layout.ts';
import { registerFirstRun } from './firstrun.ts';
import { integrationsView } from './integrations.ts';

const WEEKDAY_LABELS: Record<Weekday, string> = {
  1: 'Mánudagur', 2: 'Þriðjudagur', 3: 'Miðvikudagur', 4: 'Fimmtudagur',
  5: 'Föstudagur', 6: 'Laugardagur', 7: 'Sunnudagur',
};

/** Flash messages travel in the query string across redirects. */
function flashFrom(ctx: RequestContext): { kind: 'gott' | 'villa' | 'upplysing'; text: string } | null {
  const text = ctx.query.get('skilabod');
  if (!text) return null;
  const kind = ctx.query.get('tegund');
  return { kind: kind === 'villa' ? 'villa' : kind === 'upplysing' ? 'upplysing' : 'gott', text: text.slice(0, 300) };
}

function withFlash(path: string, text: string, kind: 'gott' | 'villa' | 'upplysing' = 'gott'): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}skilabod=${encodeURIComponent(text)}&tegund=${kind}`;
}

function tenantTabs(tenantId: string, active: string): SafeHtml {
  const tabs = [
    { key: 'yfirlit', label: 'Yfirlit', href: `/vidskiptavinir/${tenantId}` },
    { key: 'verkefni', label: 'Uppsetning', href: `/vidskiptavinir/${tenantId}/verkefni` },
    { key: 'vefur', label: 'Vefsíða', href: `/vidskiptavinir/${tenantId}/vefur` },
    { key: 'bokanir', label: 'Bókanir', href: `/vidskiptavinir/${tenantId}/bokanir` },
    { key: 'thjonusta', label: 'Þjónusta', href: `/vidskiptavinir/${tenantId}/thjonusta` },
    { key: 'simtol', label: 'Símtöl', href: `/vidskiptavinir/${tenantId}/simtol` },
    { key: 'stillingar', label: 'Stillingar', href: `/vidskiptavinir/${tenantId}/stillingar` },
  ];
  return html`<div class="tabs">
    ${tabs.map((tab) => html`<a href="${tab.href}" class="${tab.key === active ? 'is-active' : ''}">${tab.label}</a>`)}
  </div>`;
}

function settingsTabs(active: string): SafeHtml {
  const tabs = [
    { key: 'tengingar', label: 'Tengingar', href: '/stillingar' },
    { key: 'kerfi', label: 'Kerfið', href: '/stillingar/kerfi' },
  ];
  return html`<div class="tabs">
    ${tabs.map((tab) => html`<a href="${tab.href}" class="${tab.key === active ? 'is-active' : ''}">${tab.label}</a>`)}
  </div>`;
}

export function adminRouter(): Router {
  const router = new Router();
  router.use(loadSession);

  // The packaged desktop build has no terminal, so the very first account is
  // created through the browser instead of a setup script.
  registerFirstRun(router);

  // =======================================================================
  // Authentication
  // =======================================================================

  router.get('/innskraning', (ctx) => {
    if (ctx.session) return redirect('/stjornbord');
    // Nothing to log into yet — send them to first-run setup.
    if (operatorCount() === 0) return redirect('/uppsetning');
    return htmlResponse(loginPage(ctx.query.get('next') ?? '/stjornbord', null));
  });

  router.post('/innskraning', async (ctx) => {
    const form = ctx.form();
    const next = form.next && form.next.startsWith('/') ? form.next : '/stjornbord';

    try {
      const result = await login(form.netfang ?? '', form.lykilord ?? '', {
        ip: ctx.ip,
        userAgent: String(ctx.headers['user-agent'] ?? ''),
      });

      const cookie = serializeCookie(SESSION_COOKIE, result.sessionToken, {
        maxAgeSec: config.operator.sessionTtlHours * 3600,
        secure: useSecureCookies(),
        sameSite: 'Lax',
      });
      return withCookie(redirect(next), cookie);
    } catch (error) {
      const message = isAppError(error) ? error.publicMessage : 'Innskráning mistókst.';
      return htmlResponse(loginPage(next, message), 401);
    }
  });

  router.post('/utskraning', (ctx) => {
    const token = ctx.cookies[SESSION_COOKIE];
    if (token) logout(token);
    return withCookie(redirect('/innskraning'), serializeCookie(SESSION_COOKIE, '', { maxAgeSec: 0 }));
  }, [requireOperator, csrfProtect]);

  // Everything below requires a session.
  const guard = [requireOperator];
  const guardWrite = [requireOperator, csrfProtect];

  router.get('/', () => redirect('/stjornbord'));

  // =======================================================================
  // Dashboard
  // =======================================================================

  router.get('/stjornbord', (ctx) => {
    const tenants = listTenants();
    const active = tenants.filter((tenant) => tenant.status === 'virkur');
    const setup = tenants.filter((tenant) => tenant.status === 'undirbuningur');

    const today = plainDateOf(Date.now(), config.defaults.timezone);
    let bookingsToday = 0;
    let upcoming = 0;
    let revenue = 0;
    for (const tenant of tenants) {
      const stats = bookingStats(tenant.id);
      bookingsToday += stats.today;
      upcoming += stats.upcoming;
      revenue += stats.revenueThisMonthIsk;
    }

    const attention = tenants
      .map((tenant) => ({ tenant, progress: progress(tenant.id) }))
      .filter((entry) => entry.progress.blocked > 0 || (entry.tenant.status === 'undirbuningur' && entry.progress.total > 0));

    const holidays = upcomingHolidays(today, 45);

    return htmlResponse(
      page(
        { title: 'Yfirlit', session: ctx.session, active: 'stjornbord', flash: flashFrom(ctx) },
        html`
          <div class="head">
            <div>
              <h1>Yfirlit</h1>
              <p class="sub">Staðan á öllum viðskiptavinum Rafrænnar Þjónustu.</p>
            </div>
            <a class="btn btn-primary" href="/vidskiptavinir/nyr">Nýr viðskiptavinur</a>
          </div>

          <div class="grid grid-4">
            ${statCard(active.length, 'Virkir viðskiptavinir', `${setup.length} í uppsetningu`)}
            ${statCard(bookingsToday, 'Bókanir í dag')}
            ${statCard(upcoming, 'Framundan')}
            ${statCard(money(revenue), 'Velta þessa mánaðar', 'Samtals hjá öllum')}
          </div>

          <div class="grid grid-2" style="margin-top:1rem">
            <div class="panel">
              <h2>Þarfnast athygli</h2>
              ${attention.length === 0
                ? html`<p class="muted">Ekkert bíður. Allir viðskiptavinir eru komnir í gang.</p>`
                : html`<div class="table-wrap"><table>
                    <thead><tr><th>Viðskiptavinur</th><th>Staða</th><th>Framvinda</th></tr></thead>
                    <tbody>
                      ${attention.map(
                        (entry) => html`
                          <tr>
                            <td><a href="/vidskiptavinir/${entry.tenant.id}/verkefni">${entry.tenant.name}</a></td>
                            <td>${statusTag(entry.tenant.status)}
                                ${entry.progress.blocked > 0 ? html`<span class="tag tag-bad">${entry.progress.blocked} stopp</span>` : ''}</td>
                            <td style="min-width:140px">
                              <div class="progress"><i style="width:${entry.progress.percent}%"></i></div>
                              <span class="small muted">${entry.progress.done} af ${entry.progress.total}</span>
                            </td>
                          </tr>`,
                      )}
                    </tbody>
                  </table></div>`}
            </div>

            <div class="panel">
              <h2>Tengingar</h2>
              <div class="table-wrap"><table>
                <tbody>
                  ${integrationStatus().map(
                    (item) => html`
                      <tr>
                        <td><strong>${item.label}</strong><br><span class="small muted">${item.hint}</span></td>
                        <td style="text-align:right">${item.ready ? statusTag('lokid') : html`<span class="tag tag-warn">Óstillt</span>`}</td>
                      </tr>`,
                  )}
                </tbody>
              </table></div>
            </div>
          </div>

          <div class="panel" style="margin-top:1rem">
            <h2>Frídagar framundan</h2>
            ${holidays.length === 0
              ? html`<p class="muted">Engir lögbundnir frídagar næstu 45 daga.</p>`
              : html`<div class="split">
                  ${holidays.map(
                    (holiday) => html`<span class="tag ${holiday.kind === 'hálfur' ? 'tag-warn' : 'tag-muted'}">
                      ${formatDateIs(holiday.date, { year: false, short: true })} · ${holiday.name}
                    </span>`,
                  )}
                </div>
                <p class="small muted" style="margin-top:.75rem">
                  Bókunarkerfið lokar sjálfkrafa á þessa daga hjá viðskiptavinum sem virða frídaga.
                </p>`}
          </div>`,
      ),
    );
  }, guard);

  // =======================================================================
  // Tenants
  // =======================================================================

  router.get('/vidskiptavinir', (ctx) => {
    const search = ctx.query.get('leit') ?? '';
    const tenants = listTenants({ search });

    return htmlResponse(
      page(
        { title: 'Viðskiptavinir', session: ctx.session, active: 'vidskiptavinir', flash: flashFrom(ctx) },
        html`
          <div class="head">
            <div><h1>Viðskiptavinir</h1><p class="sub">${tenants.length} skráðir.</p></div>
            <a class="btn btn-primary" href="/vidskiptavinir/nyr">Nýr viðskiptavinur</a>
          </div>

          <form method="get" class="panel" style="margin-bottom:1rem">
            <div class="split">
              <input type="text" name="leit" value="${search}" placeholder="Leita eftir nafni, auðkenni eða netfangi" style="flex:1">
              <button class="btn btn-ghost" type="submit">Leita</button>
            </div>
          </form>

          ${tenants.length === 0
            ? emptyState('Engir viðskiptavinir skráðir ennþá.', { label: 'Stofna þann fyrsta', href: '/vidskiptavinir/nyr' })
            : html`<div class="panel"><div class="table-wrap"><table>
                <thead><tr><th>Fyrirtæki</th><th>Fag</th><th>Staða</th><th>Uppsetning</th><th>Bókanir í dag</th></tr></thead>
                <tbody>
                  ${tenants.map((tenant) => {
                    const p = progress(tenant.id);
                    const stats = bookingStats(tenant.id);
                    return html`
                      <tr>
                        <td>
                          <a href="/vidskiptavinir/${tenant.id}"><strong>${tenant.name}</strong></a>
                          <div class="small muted">${tenant.slug}</div>
                        </td>
                        <td>${industryPreset(tenant.industry).emoji} ${industryPreset(tenant.industry).label}</td>
                        <td>${statusTag(tenant.status)}</td>
                        <td style="min-width:130px">
                          <div class="progress"><i style="width:${p.percent}%"></i></div>
                          <span class="small muted">${p.done}/${p.total}</span>
                        </td>
                        <td>${stats.today}</td>
                      </tr>`;
                  })}
                </tbody>
              </table></div></div>`}`,
      ),
    );
  }, guard);

  // --- Wizard -------------------------------------------------------------

  router.get('/vidskiptavinir/nyr', (ctx) =>
    htmlResponse(page(
      { title: 'Nýr viðskiptavinur', session: ctx.session, active: 'vidskiptavinir',
        breadcrumb: [{ label: 'Viðskiptavinir', href: '/vidskiptavinir' }, { label: 'Nýr' }] },
      wizardForm(ctx, {}, {}),
    )), guard);

  /**
   * Company lookup for the wizard. Returns JSON rather than re-rendering, so
   * whatever the operator has already typed is never thrown away by a reload.
   */
  router.post('/vidskiptavinir/uppfletting', async (ctx) => {
    const outcome = await lookupCompanyProfile(ctx.form().kennitala ?? '', { industryLabel });
    return json(outcome);
  }, guardWrite);

  router.post('/vidskiptavinir/nyr', (ctx) => {
    const form = ctx.form();
    const input = {
      name: form.nafn ?? '',
      industry: form.fag ?? 'annad',
      legalName: form.logadili ?? '',
      kennitala: form.kennitala ?? '',
      email: form.netfang ?? '',
      phone: form.simi ?? '',
      websiteDomain: form.len ?? '',
      address: form.heimilisfang ?? '',
      postcode: form.postnumer ?? '',
      about: form.lysing ?? '',
      brandColor: brandColorForIndustry(form.fag ?? 'annad'),
      notes: form.athugasemd ?? '',
    };

    const errors = validateTenantInput(input);
    if (Object.keys(errors).length > 0) {
      return htmlResponse(
        page(
          { title: 'Nýr viðskiptavinur', session: ctx.session, active: 'vidskiptavinir',
            flash: { kind: 'villa', text: 'Sumar upplýsingar vantar eða eru rangar.' } },
          wizardForm(ctx, form, errors),
        ),
        422,
      );
    }

    const tenant = createTenant(input);

    const features = ctx.formList('eiginleikar').filter((value): value is Feature =>
      (FEATURES as readonly string[]).includes(value),
    );

    const result = provisionTenant({
      tenantId: tenant.id,
      features,
      emailProvider: (form.postthjonusta as EmailProvider) || 'google',
      staffNames: (form.starfsfolk ?? '').split('\n'),
      capacity: Number.parseInt(form.afkastageta ?? '', 10) || undefined,
    });

    logger.info('Nýr viðskiptavinur settur upp', { tenantId: tenant.id, ...result });

    const destination = features.includes('vefsida')
      ? `/vidskiptavinir/${tenant.id}/vefur`
      : `/vidskiptavinir/${tenant.id}/verkefni`;

    return redirect(
      withFlash(
        destination,
        `${tenant.name} stofnað. ${result.servicesCreated} þjónustur, ${result.variantsBuilt} útlitstillögur og ${result.tasksCreated} verkefni tilbúin.`,
      ),
    );
  }, guardWrite);

  // --- Tenant detail ------------------------------------------------------

  router.get('/vidskiptavinir/:id', (ctx) => {
    const tenant = getTenantOrThrow(ctx.params.id ?? '');
    const features = getFeatures(tenant.id);
    const stats = bookingStats(tenant.id);
    const p = progress(tenant.id);
    const services = listServices(tenant.id);
    const staff = listStaff(tenant.id);
    const build = latestBuild(tenant.id);
    const calendar = calendarStatus(tenant.id);
    const hours = weeklyHoursMap(tenant.id, null);
    const upcoming = upcomingBookings(tenant.id, 8);
    const flow = flowSummary(tenant.industry);

    return htmlResponse(
      page(
        { title: tenant.name, session: ctx.session, active: 'vidskiptavinir', flash: flashFrom(ctx),
          breadcrumb: [{ label: 'Viðskiptavinir', href: '/vidskiptavinir' }, { label: tenant.name }] },
        html`
          <div class="head">
            <div>
              <h1>${tenant.name}</h1>
              <p class="sub">
                ${industryPreset(tenant.industry).emoji} ${industryPreset(tenant.industry).label}
                ${tenant.kennitala ? ` · kt. ${formatKennitala(tenant.kennitala)}` : ''}
                · ${statusTag(tenant.status)}
              </p>
            </div>
            <div class="btn-row">
              <a class="btn btn-ghost" href="/v/${tenant.slug}" target="_blank" rel="noopener">Skoða vefsíðu</a>
              ${tenant.status === 'undirbuningur'
                ? html`<form method="post" action="/vidskiptavinir/${tenant.id}/virkja">
                    ${csrfField(ctx.session)}
                    <button class="btn btn-primary" type="submit">Virkja</button>
                  </form>`
                : ''}
            </div>
          </div>

          ${tenantTabs(tenant.id, 'yfirlit')}

          <div class="grid grid-4">
            ${statCard(stats.today, 'Bókanir í dag')}
            ${statCard(stats.upcoming, 'Framundan')}
            ${statCard(money(stats.revenueThisMonthIsk), 'Velta mánaðarins')}
            ${statCard(`${p.percent}%`, 'Uppsetning', `${p.done} af ${p.total} verkefnum`)}
          </div>

          <div class="grid grid-2" style="margin-top:1rem">
            <div class="panel">
              <h2>Næstu bókanir</h2>
              ${upcoming.length === 0
                ? html`<p class="muted">Engar bókanir framundan.</p>`
                : html`<div class="table-wrap"><table>
                    <thead><tr><th>Tími</th><th>Viðskiptavinur</th><th>Þjónusta</th><th></th></tr></thead>
                    <tbody>
                      ${upcoming.map(
                        (booking) => html`
                          <tr>
                            <td>${formatDateTimeIs(booking.startsAt, tenant.timezone)}<br>
                                <span class="small muted">${relativeIs(booking.startsAt, tenant.timezone)}</span></td>
                            <td>${booking.customerName}<br><span class="small muted">${booking.customerPhone ? normalizePhone(booking.customerPhone).display : ''}</span></td>
                            <td>${booking.serviceName}</td>
                            <td>${statusTag(booking.status)}</td>
                          </tr>`,
                      )}
                    </tbody>
                  </table></div>`}
            </div>

            <div class="panel">
              <h2>Eiginleikar</h2>
              <div class="table-wrap"><table><tbody>
                ${FEATURES.map(
                  (feature) => html`
                    <tr>
                      <td><strong>${FEATURE_LABELS[feature].label}</strong><br>
                          <span class="small muted">${FEATURE_LABELS[feature].description}</span></td>
                      <td style="text-align:right">${features[feature].enabled ? statusTag('lokid') : html`<span class="tag tag-muted">Óvirkt</span>`}</td>
                    </tr>`,
                )}
              </tbody></table></div>
            </div>
          </div>

          <div class="grid grid-3" style="margin-top:1rem">
            <div class="panel">
              <h3>Opnunartími</h3>
              <div class="table-wrap"><table><tbody>
                ${([1, 2, 3, 4, 5, 6, 7] as Weekday[]).map((weekday) => {
                  const windows = hours[weekday];
                  return html`<tr>
                    <td>${WEEKDAY_LABELS[weekday]}</td>
                    <td style="text-align:right" class="${windows.length === 0 ? 'muted' : ''}">
                      ${windows.length === 0 ? 'Lokað' : windows.map((w) => `${minutesToHhmm(w.openMin)}–${minutesToHhmm(w.closeMin)}`).join(', ')}
                    </td>
                  </tr>`;
                })}
              </tbody></table></div>
            </div>

            <div class="panel">
              <h3>Samantekt</h3>
              <p class="small"><strong>${services.length}</strong> þjónustur · <strong>${staff.length}</strong> starfsmenn</p>
              <p class="small"><strong>Spurningaflæði:</strong> ${flow.total} spurningar,
                 þar af ${flow.conditional} skilyrtar.</p>
              <p class="small"><strong>Vefsíða:</strong>
                 ${build ? `útgáfa ${build.version} · ${build.template}` : 'ekki birt'}</p>
              <p class="small"><strong>Dagatal:</strong>
                 ${calendar.linked ? `tengt (${calendar.email || 'óþekkt'})` : 'ekki tengt'}</p>
              ${calendar.error ? html`<p class="error-text">${calendar.error}</p>` : ''}
            </div>

            <div class="panel">
              <h3>Samskiptaupplýsingar</h3>
              <p class="small">
                ${tenant.email ? html`${tenant.email}<br>` : ''}
                ${tenant.phone ? html`${normalizePhone(tenant.phone).display}<br>` : ''}
                ${tenant.address ? html`${tenant.address}<br>${tenant.postcode} ${tenant.city}` : ''}
              </p>
              ${tenant.websiteDomain
                ? html`<p class="small"><a href="https://${tenant.websiteDomain}" target="_blank" rel="noopener">${tenant.websiteDomain}</a></p>`
                : html`<p class="small muted">Ekkert lén skráð.</p>`}
            </div>
          </div>`,
      ),
    );
  }, guard);

  router.post('/vidskiptavinir/:id/virkja', (ctx) => {
    const tenantId = ctx.params.id ?? '';
    const result = activateTenant(tenantId);
    return redirect(
      result.activated
        ? withFlash(`/vidskiptavinir/${tenantId}`, 'Viðskiptavinur virkjaður.')
        : withFlash(`/vidskiptavinir/${tenantId}/verkefni`, `Ekki hægt að virkja: ${result.blocking.join(', ')}`, 'villa'),
    );
  }, guardWrite);

  // =======================================================================
  // Website variants
  // =======================================================================

  router.get('/vidskiptavinir/:id/vefur', (ctx) => {
    const tenant = getTenantOrThrow(ctx.params.id ?? '');
    const variants = listVariants(tenant.id);
    const chosen = chosenVariant(tenant.id);
    const build = latestBuild(tenant.id);
    const hosting = hostingStatus(tenant.id);

    return htmlResponse(
      page(
        { title: `Vefsíða — ${tenant.name}`, session: ctx.session, active: 'vidskiptavinir', flash: flashFrom(ctx), wide: true,
          breadcrumb: [{ label: 'Viðskiptavinir', href: '/vidskiptavinir' }, { label: tenant.name, href: `/vidskiptavinir/${tenant.id}` }, { label: 'Vefsíða' }] },
        html`
          <div class="head">
            <div>
              <h1>Veldu útlit</h1>
              <p class="sub">Þrjár fullbúnar tillögur með sama efni. Smelltu til að skoða í fullri stærð og veldu svo þá sem passar.</p>
            </div>
            <div class="btn-row">
              ${tenant.websiteDomain
                ? html`<form method="post" action="/vidskiptavinir/${tenant.id}/vefur/flytja-inn">
                    ${csrfField(ctx.session)}
                    <button class="btn btn-ghost" type="submit"
                            title="Sækir texta, liti, verðskrá og tengiliði af ${tenant.websiteDomain}">
                      Sækja af ${tenant.websiteDomain}
                    </button>
                  </form>`
                : ''}
              <form method="post" action="/vidskiptavinir/${tenant.id}/vefur/endurgera">
                ${csrfField(ctx.session)}
                <button class="btn btn-ghost" type="submit">Endurgera tillögur</button>
              </form>
            </div>
          </div>

          ${tenantTabs(tenant.id, 'vefur')}

          ${build
            ? html`<div class="panel" style="margin-bottom:1rem">
                <div class="split">
                  <strong>Birt útgáfa ${build.version}</strong>
                  <span class="tag tag-ok">${build.template}</span>
                  <span class="muted small">${when(build.built_at)}</span>
                  <a class="btn btn-ghost btn-sm" href="/v/${tenant.slug}" target="_blank" rel="noopener">Opna vefsíðu</a>
                </div>

                <div class="split" style="margin-top:.9rem;padding-top:.9rem;border-top:1px solid var(--border)">
                  ${hosting
                    ? html`
                      <span class="tag ${hosting.stale ? 'tag-bad' : 'tag-ok'}">
                        ${hosting.stale ? 'Úrelt á Vercel' : 'Í loftinu á Vercel'}
                      </span>
                      <a class="btn btn-ghost btn-sm" href="${hosting.url}" target="_blank" rel="noopener">${hosting.url}</a>
                      <span class="muted small">${hosting.deployedAt ? when(hosting.deployedAt) : ''}</span>`
                    : html`<span class="muted small">
                        ${config.vercel.enabled
                          ? 'Ekki komin á ytri hýsingu — vefsíðan er aðeins aðgengileg héðan.'
                          : 'Ytri hýsing er óstillt. Bættu við VERCEL_TOKEN undir Tengingar til að setja vefinn í loftið á eigin léni.'}
                      </span>`}

                  ${config.vercel.enabled
                    ? html`<form method="post" action="/vidskiptavinir/${tenant.id}/vefur/hysing">
                        ${csrfField(ctx.session)}
                        <button class="btn ${hosting && !hosting.stale ? 'btn-ghost' : 'btn-primary'} btn-sm" type="submit">
                          ${hosting ? 'Senda aftur á Vercel' : 'Setja í loftið á Vercel'}
                        </button>
                      </form>`
                    : ''}
                </div>
              </div>`
            : ''}

          ${variants.length === 0
            ? emptyState('Engar útlitstillögur hafa verið gerðar.')
            : html`<div class="grid grid-3">
                ${variants.map(
                  (variant) => html`
                    <div class="variant ${chosen?.variant === variant.variant ? 'is-chosen' : ''}">
                      <div class="split" style="justify-content:space-between">
                        <h3 style="margin:0">${variant.label}</h3>
                        ${chosen?.variant === variant.variant ? html`<span class="tag tag-ok">Valið</span>` : ''}
                      </div>
                      <p class="small muted">${variant.description}</p>
                      <div class="variant-frame">
                        <iframe src="/forskodun/${tenant.id}/${variant.variant}"
                                title="Forskoðun — ${variant.label}"
                                loading="lazy" sandbox="allow-scripts"></iframe>
                      </div>
                      <div class="btn-row" style="margin-top:.85rem">
                        <a class="btn btn-ghost btn-sm" href="/forskodun/${tenant.id}/${variant.variant}" target="_blank" rel="noopener">Skoða</a>
                        <form method="post" action="/vidskiptavinir/${tenant.id}/vefur">
                          ${csrfField(ctx.session)}
                          <input type="hidden" name="utgafa" value="${variant.variant}">
                          <button class="btn btn-primary btn-sm" type="submit">Velja og birta</button>
                        </form>
                      </div>
                    </div>`,
                )}
              </div>`}`,
      ),
    );
  }, guard);

  router.post('/vidskiptavinir/:id/vefur', (ctx) => {
    const tenantId = ctx.params.id ?? '';
    const variant = ctx.form().utgafa ?? '';
    const result = publishVariant(tenantId, variant);
    setTaskStatus(tenantId, 'vefsida', 'lokid', `Birt: ${result.url}`);
    return redirect(withFlash(`/vidskiptavinir/${tenantId}/vefur`, `Vefsíðan er komin í loftið á ${result.url}`));
  }, guardWrite);

  /** Pushes the published build to Vercel. Separate from choosing a design. */
  router.post('/vidskiptavinir/:id/vefur/hysing', async (ctx) => {
    const tenantId = ctx.params.id ?? '';
    const target = `/vidskiptavinir/${tenantId}/vefur`;

    try {
      const result = await deployPublishedSite(tenantId);

      if (result.pendingDns.length > 0) {
        // The site is live on the Vercel URL either way; the domain is what is
        // waiting. Saying only "published" would hide the remaining step.
        return redirect(withFlash(
          target,
          `Vefsíðan er í loftinu á ${result.url}. Lénið bíður DNS-færslna: ${result.pendingDns.join(' — ')}`,
          'upplysing',
        ));
      }

      return redirect(withFlash(target, `Vefsíðan er komin í loftið á ${result.domain || result.url}`));
    } catch (error) {
      // The flash already names the provider, so the `[vercel]` tag that
      // IntegrationError prepends would only be noise here.
      const message = (error instanceof Error ? error.message : String(error)).replace(/^\[vercel\]\s*/, '');
      return redirect(withFlash(target, `Birting á Vercel mistókst: ${message}`, 'villa'));
    }
  }, guardWrite);

  /**
   * Lifts content off the company's existing website.
   *
   * Applied to empty fields only. An operator who has already written a
   * tagline meant it, and an import is a guess by comparison — it proposes,
   * it does not overwrite.
   */
  router.post('/vidskiptavinir/:id/vefur/flytja-inn', async (ctx) => {
    const tenantId = ctx.params.id ?? '';
    const tenant = getTenantOrThrow(tenantId);
    const target = `/vidskiptavinir/${tenantId}/vefur`;

    if (!tenant.websiteDomain) {
      return redirect(withFlash(target, 'Ekkert lén er skráð á viðskiptavininn.', 'villa'));
    }

    const imported = await importSite(tenant.websiteDomain);
    if (!imported) {
      return redirect(withFlash(target, `Náði ekki í ${tenant.websiteDomain} eða síðan skilaði ekki HTML.`, 'villa'));
    }

    const patch: Record<string, unknown> = {};
    const taken: string[] = [];

    if (!tenant.tagline && imported.tagline) { patch.tagline = imported.tagline; taken.push('kjörorð'); }
    if (!tenant.about && imported.about) { patch.about = imported.about; taken.push('lýsing'); }
    if (!tenant.phone && imported.phone) { patch.phone = imported.phone; taken.push('sími'); }
    if (!tenant.email && imported.email) { patch.email = imported.email; taken.push('netfang'); }
    if (imported.brandColor) { patch.brandColor = imported.brandColor; taken.push('einkennislitur'); }

    if (Object.keys(patch).length > 0) updateTenant(tenantId, patch);

    // Prices are only added when there is no catalogue yet: merging a scraped
    // price list into services the operator has already priced would be a
    // silent overwrite of real numbers.
    let addedServices = 0;
    if (imported.services.length > 0 && listServices(tenantId).length === 0) {
      for (const service of imported.services.slice(0, 20)) {
        try {
          createService(tenantId, { name: service.name, priceIsk: service.priceIsk, durationMin: 60 });
          addedServices++;
        } catch {
          // A name the catalogue rejects is skipped rather than failing the import.
        }
      }
      if (addedServices > 0) taken.push(`${addedServices} þjónustuliðir`);
    }

    const built = generateVariants(tenantId);

    const summary = taken.length > 0
      ? `Sótt af ${imported.url}: ${taken.join(', ')}. ${built.length} tillögur endurgerðar.`
      : `Ekkert nýtt fannst á ${imported.url} — reitirnir eru þegar fylltir. ${built.length} tillögur endurgerðar.`;

    return redirect(withFlash(target, imported.notes.length > 0 ? `${summary} ${imported.notes.join(' ')}` : summary,
      taken.length > 0 ? 'gott' : 'upplysing'));
  }, guardWrite);

  router.post('/vidskiptavinir/:id/vefur/endurgera', (ctx) => {
    const tenantId = ctx.params.id ?? '';
    const built = generateVariants(tenantId);
    return redirect(withFlash(`/vidskiptavinir/${tenantId}/vefur`, `${built.length} tillögur endurgerðar.`));
  }, guardWrite);

  router.get('/forskodun/:id/:variant', (ctx) =>
    servePreview(ctx.params.id ?? '', ctx.params.variant ?? ''), guard);

  // =======================================================================
  // Provisioning checklist
  // =======================================================================

  router.get('/vidskiptavinir/:id/verkefni', (ctx) => {
    const tenant = getTenantOrThrow(ctx.params.id ?? '');
    const tasks = listTasks(tenant.id);
    const p = progress(tenant.id);
    const invite = pendingInvite(tenant.id);
    const devices = listDevices(tenant.id);

    return htmlResponse(
      page(
        { title: `Uppsetning — ${tenant.name}`, session: ctx.session, active: 'vidskiptavinir', flash: flashFrom(ctx),
          breadcrumb: [{ label: 'Viðskiptavinir', href: '/vidskiptavinir' }, { label: tenant.name, href: `/vidskiptavinir/${tenant.id}` }, { label: 'Uppsetning' }] },
        html`
          <div class="head">
            <div>
              <h1>Uppsetning</h1>
              <p class="sub">${p.done} af ${p.total} verkefnum lokið · ${p.waitingOnOperator} bíða þín.</p>
            </div>
          </div>

          ${tenantTabs(tenant.id, 'verkefni')}

          <div class="panel" style="margin-bottom:1rem">
            <div class="progress"><i style="width:${p.percent}%"></i></div>
          </div>

          ${tasks.map((task) => html`
            <div class="panel" style="margin-bottom:.85rem">
              <div class="split" style="justify-content:space-between;align-items:flex-start">
                <div style="flex:1;min-width:260px">
                  <div class="split">
                    <h3 style="margin:0">${task.title}</h3>
                    ${statusTag(task.status)}
                    ${task.requiresOperator && task.status !== 'lokid' ? html`<span class="tag tag-warn">Þarf aðgerð</span>` : ''}
                  </div>
                  <p class="small muted" style="margin:.4rem 0 0">${task.description}</p>
                  ${task.detail ? html`<p class="small" style="margin:.4rem 0 0">${task.detail}</p>` : ''}
                  ${taskPayload(tenant.id, task.key, task.payload, ctx)}
                </div>
                <form method="post" action="/vidskiptavinir/${tenant.id}/verkefni/${task.key}" class="split">
                  ${csrfField(ctx.session)}
                  <select name="stada">
                    ${['bidur', 'i_vinnslu', 'lokid', 'stopp', 'sleppt'].map(
                      (status) => html`<option value="${status}" ${task.status === status ? 'selected' : ''}>${status}</option>`,
                    )}
                  </select>
                  <button class="btn btn-ghost btn-sm" type="submit">Vista</button>
                </form>
              </div>
            </div>`)}

          <div class="panel">
            <h2>Snjallsímaapp</h2>
            ${invite
              ? html`<p>Pörunarkóði: <strong class="mono" style="font-size:1.3rem">${invite.code}</strong>
                       <span class="small muted">(gildir til ${formatTimeIs(invite.expiresAt, tenant.timezone)})</span></p>`
              : html`<p class="muted">Enginn virkur pörunarkóði.</p>`}
            <form method="post" action="/vidskiptavinir/${tenant.id}/app">
              ${csrfField(ctx.session)}
              <button class="btn btn-ghost btn-sm" type="submit">Búa til nýjan kóða</button>
            </form>
            ${devices.length > 0
              ? html`<div class="table-wrap" style="margin-top:1rem"><table>
                  <thead><tr><th>Tæki</th><th>Kerfi</th><th>Síðast virkt</th></tr></thead>
                  <tbody>${devices.map((device) => html`
                    <tr><td>${device.label}</td><td>${device.platform}</td>
                        <td class="small muted">${device.lastSeenAt ? when(device.lastSeenAt, tenant.timezone) : '—'}</td></tr>`)}
                  </tbody></table></div>`
              : ''}
          </div>`,
      ),
    );
  }, guard);

  router.post('/vidskiptavinir/:id/verkefni/:key', (ctx) => {
    const tenantId = ctx.params.id ?? '';
    const key = ctx.params.key ?? '';
    const status = ctx.form().stada ?? 'bidur';
    setTaskStatus(tenantId, key, status as 'bidur');
    return redirect(withFlash(`/vidskiptavinir/${tenantId}/verkefni`, 'Verkefni uppfært.'));
  }, guardWrite);

  router.post('/vidskiptavinir/:id/app', (ctx) => {
    const tenantId = ctx.params.id ?? '';
    const invite = createPairingInvite(tenantId, 'Sími eiganda');
    return redirect(withFlash(`/vidskiptavinir/${tenantId}/verkefni`, `Nýr pörunarkóði: ${invite.code}`));
  }, guardWrite);

  /** Live DNS check for the email task. */
  router.post('/vidskiptavinir/:id/dns', async (ctx) => {
    const tenant = getTenantOrThrow(ctx.params.id ?? '');
    const form = ctx.form();
    const provider = (form.postthjonusta as EmailProvider) || 'google';
    const domain = form.len || tenant.websiteDomain;

    if (!domain) {
      return redirect(withFlash(`/vidskiptavinir/${tenant.id}/verkefni`, 'Skráðu lén á viðskiptavininn fyrst.', 'villa'));
    }

    const plan = buildEmailPlan(provider, domain, { dmarcReportTo: tenant.email || undefined });
    const result = await verifyEmailDns(plan);

    const summary = result.checks
      .map((check) => `${check.record.type} ${check.record.host}: ${check.status}`)
      .join(' · ');

    setTaskStatus(tenant.id, 'tolvupostur', result.allGood ? 'lokid' : 'i_vinnslu', summary.slice(0, 500));

    return redirect(
      withFlash(
        `/vidskiptavinir/${tenant.id}/verkefni`,
        result.allGood ? 'Allar DNS-færslur eru komnar í gildi.' : `DNS ekki tilbúið: ${summary}`,
        result.allGood ? 'gott' : 'upplysing',
      ),
    );
  }, guardWrite);

  // =======================================================================
  // Bookings
  // =======================================================================

  router.get('/vidskiptavinir/:id/bokanir', (ctx) => {
    const tenant = getTenantOrThrow(ctx.params.id ?? '');
    const date = (ctx.query.get('dagur') as PlainDate) || plainDateOf(Date.now(), tenant.timezone);
    const bookings = bookingsOnDate(tenant.id, date);
    const highlight = ctx.query.get('bokun');

    return htmlResponse(
      page(
        { title: `Bókanir — ${tenant.name}`, session: ctx.session, active: 'vidskiptavinir', flash: flashFrom(ctx), wide: true,
          breadcrumb: [{ label: 'Viðskiptavinir', href: '/vidskiptavinir' }, { label: tenant.name, href: `/vidskiptavinir/${tenant.id}` }, { label: 'Bókanir' }] },
        html`
          <div class="head">
            <div><h1>Bókanir</h1><p class="sub">${formatDateIs(date)}</p></div>
            <div class="split">
              <a class="btn btn-ghost btn-sm" href="?dagur=${addDays(date, -1)}">← Fyrri dagur</a>
              <a class="btn btn-ghost btn-sm" href="?dagur=${plainDateOf(Date.now(), tenant.timezone)}">Í dag</a>
              <a class="btn btn-ghost btn-sm" href="?dagur=${addDays(date, 1)}">Næsti dagur →</a>
            </div>
          </div>

          ${tenantTabs(tenant.id, 'bokanir')}

          ${bookings.length === 0
            ? emptyState('Engar bókanir þennan dag.')
            : html`<div class="panel"><div class="table-wrap"><table>
                <thead><tr><th>Tími</th><th>Viðskiptavinur</th><th>Þjónusta</th><th>Svör</th><th>Staða</th><th>Aðgerðir</th></tr></thead>
                <tbody>
                  ${bookings.map((booking) => {
                    const answers = bookingAnswerSummary(booking.id);
                    return html`
                      <tr style="${highlight === booking.id ? 'background:var(--brand-soft)' : ''}">
                        <td>
                          <strong>${formatTimeIs(booking.startsAt, tenant.timezone)}</strong><br>
                          <span class="small muted">${formatDurationIs(Math.round((booking.endsAt - booking.startsAt) / 60000))}</span>
                        </td>
                        <td>
                          ${booking.customerName}<br>
                          <span class="small muted">${booking.customerPhone ? normalizePhone(booking.customerPhone).display : ''}</span>
                        </td>
                        <td>${booking.serviceName}<br>
                            <span class="small muted">${booking.staffName ?? '—'}</span></td>
                        <td style="max-width:340px">
                          ${answers.length === 0
                            ? html`<span class="small muted">—</span>`
                            : html`<details><summary class="small">${answers.length} svör</summary>
                                <div class="small" style="margin-top:.4rem">
                                  ${answers.map((answer) => html`<div><strong>${answer.label}:</strong> ${answer.value}</div>`)}
                                </div>
                              </details>`}
                          ${booking.notes ? html`<div class="small muted" style="margin-top:.3rem">„${booking.notes}“</div>` : ''}
                        </td>
                        <td>${statusTag(booking.status)}<br><span class="small muted">${booking.source}</span></td>
                        <td>
                          <form method="post" action="/bokanir/${booking.id}/stada" class="split">
                            ${csrfField(ctx.session)}
                            <select name="adgerd">
                              <option value="stadfesta">Staðfesta</option>
                              <option value="maett">Mætt</option>
                              <option value="lokid">Lokið</option>
                              <option value="ekki_maett">Mætti ekki</option>
                              <option value="afboka">Afbóka</option>
                            </select>
                            <button class="btn btn-ghost btn-sm" type="submit">Uppfæra</button>
                          </form>
                        </td>
                      </tr>`;
                  })}
                </tbody>
              </table></div></div>`}`,
      ),
    );
  }, guard);

  router.post('/bokanir/:id/stada', (ctx) => {
    const bookingId = ctx.params.id ?? '';
    const booking = getBookingOrThrow(bookingId);
    const action = ctx.form().adgerd ?? '';

    try {
      if (action === 'stadfesta') confirmBooking(bookingId);
      else if (action === 'maett') markAttended(bookingId);
      else if (action === 'lokid') completeBooking(bookingId);
      else if (action === 'ekki_maett') markNoShow(bookingId);
      else if (action === 'afboka') cancelBooking(bookingId, { cancelledBy: 'fyrirtaeki', reason: 'Afbókað af starfsmanni' });
    } catch (error) {
      const message = isAppError(error) ? error.publicMessage : 'Aðgerð mistókst.';
      return redirect(withFlash(`/vidskiptavinir/${booking.tenantId}/bokanir`, message, 'villa'));
    }

    return redirect(withFlash(`/vidskiptavinir/${booking.tenantId}/bokanir`, 'Bókun uppfærð.'));
  }, guardWrite);

  router.get('/bokanir', (ctx) => {
    const tenants = listTenants({ status: 'virkur' });
    const rows = tenants.flatMap((tenant) =>
      upcomingBookings(tenant.id, 10).map((booking) => ({ tenant, booking })),
    ).sort((a, b) => a.booking.startsAt - b.booking.startsAt).slice(0, 100);

    return htmlResponse(
      page(
        { title: 'Bókanir', session: ctx.session, active: 'bokanir', flash: flashFrom(ctx), wide: true },
        html`
          <div class="head"><div><h1>Bókanir framundan</h1><p class="sub">Allir virkir viðskiptavinir.</p></div></div>
          ${rows.length === 0
            ? emptyState('Engar bókanir framundan.')
            : html`<div class="panel"><div class="table-wrap"><table>
                <thead><tr><th>Tími</th><th>Fyrirtæki</th><th>Viðskiptavinur</th><th>Þjónusta</th><th>Staða</th></tr></thead>
                <tbody>${rows.map(({ tenant, booking }) => html`
                  <tr>
                    <td>${formatDateTimeIs(booking.startsAt, tenant.timezone)}<br>
                        <span class="small muted">${relativeIs(booking.startsAt, tenant.timezone)}</span></td>
                    <td><a href="/vidskiptavinir/${tenant.id}/bokanir">${tenant.name}</a></td>
                    <td>${booking.customerName}<br><span class="small muted">${booking.customerPhone ? normalizePhone(booking.customerPhone).display : ''}</span></td>
                    <td>${booking.serviceName}</td>
                    <td>${statusTag(booking.status)}</td>
                  </tr>`)}
                </tbody></table></div></div>`}`,
      ),
    );
  }, guard);

  // =======================================================================
  // Services
  // =======================================================================

  router.get('/vidskiptavinir/:id/thjonusta', (ctx) => {
    const tenant = getTenantOrThrow(ctx.params.id ?? '');
    const services = listServices(tenant.id, { includeInactive: true });
    const staff = listStaff(tenant.id, { includeInactive: true });
    const flow = flowForIndustry(tenant.industry);

    return htmlResponse(
      page(
        { title: `Þjónusta — ${tenant.name}`, session: ctx.session, active: 'vidskiptavinir', flash: flashFrom(ctx), wide: true,
          breadcrumb: [{ label: 'Viðskiptavinir', href: '/vidskiptavinir' }, { label: tenant.name, href: `/vidskiptavinir/${tenant.id}` }, { label: 'Þjónusta' }] },
        html`
          <div class="head"><div><h1>Þjónusta og starfsfólk</h1></div></div>
          ${tenantTabs(tenant.id, 'thjonusta')}

          <div class="panel">
            <h2>Þjónustulisti</h2>
            <div class="table-wrap"><table>
              <thead><tr><th>Heiti</th><th>Lengd</th><th>Biðtími</th><th>Verð</th><th>Samtímis</th><th>Virk</th><th></th></tr></thead>
              <tbody>
                ${services.map((service) => html`
                  <tr>
                    <form method="post" action="/vidskiptavinir/${tenant.id}/thjonusta/${service.id}">
                      ${csrfField(ctx.session)}
                      <td><input type="text" name="nafn" value="${service.name}" style="min-width:180px"></td>
                      <td><input type="number" name="lengd" value="${service.durationMin}" min="5" max="1440" step="5" style="width:90px"> mín</td>
                      <td><input type="number" name="bidtimi" value="${service.bufferAfterMin}" min="0" max="240" step="5" style="width:80px"></td>
                      <td><input type="number" name="verd" value="${service.priceIsk}" min="0" step="100" style="width:110px"></td>
                      <td><input type="number" name="afkastageta" value="${service.capacity}" min="1" max="50" style="width:70px"></td>
                      <td><input type="checkbox" name="virk" ${service.active ? 'checked' : ''}></td>
                      <td><button class="btn btn-ghost btn-sm" type="submit">Vista</button></td>
                    </form>
                  </tr>`)}
              </tbody>
            </table></div>
          </div>

          <div class="grid grid-2" style="margin-top:1rem">
            <div class="panel">
              <h2>Starfsfólk</h2>
              ${staff.length === 0
                ? html`<p class="muted">Ekkert starfsfólk skráð — bókanir eru þá ekki bundnar við nafn.</p>`
                : html`<div class="table-wrap"><table>
                    <thead><tr><th>Nafn</th><th>Starf</th><th>Tekur bókanir</th></tr></thead>
                    <tbody>${staff.map((member) => html`
                      <tr><td>${member.name}</td><td class="muted">${member.title}</td>
                          <td>${member.acceptsBookings ? statusTag('lokid') : html`<span class="tag tag-muted">Nei</span>`}</td></tr>`)}
                    </tbody></table></div>`}
            </div>

            <div class="panel">
              <h2>Spurningaflæði viðskiptavina</h2>
              <p class="small muted">${flow.intro}</p>
              <div class="table-wrap"><table>
                <thead><tr><th>Spurning</th><th>Tegund</th><th>Birtist</th></tr></thead>
                <tbody>${flow.questions.map((question) => html`
                  <tr>
                    <td>${question.label}${question.required ? html` <span class="tag tag-warn">skylda</span>` : ''}</td>
                    <td class="small muted">${question.type}</td>
                    <td class="small muted">${question.showIf ? 'skilyrt' : 'alltaf'}</td>
                  </tr>`)}
                </tbody></table></div>
            </div>
          </div>`,
      ),
    );
  }, guard);

  router.post('/vidskiptavinir/:id/thjonusta/:serviceId', (ctx) => {
    const tenantId = ctx.params.id ?? '';
    const form = ctx.form();
    updateService(ctx.params.serviceId ?? '', {
      name: form.nafn,
      durationMin: Number(form.lengd),
      bufferAfterMin: Number(form.bidtimi),
      priceIsk: Number(form.verd),
      capacity: Number(form.afkastageta),
      active: form.virk === 'on',
    });
    return redirect(withFlash(`/vidskiptavinir/${tenantId}/thjonusta`, 'Þjónusta uppfærð.'));
  }, guardWrite);

  // =======================================================================
  // Calls
  // =======================================================================

  router.get('/vidskiptavinir/:id/simtol', (ctx) => {
    const tenant = getTenantOrThrow(ctx.params.id ?? '');
    const calls = all<{
      id: string; from_number: string; started_at: number; duration_sec: number | null;
      outcome: string; transcript: string; recording_url: string;
    }>(
      'SELECT id, from_number, started_at, duration_sec, outcome, transcript, recording_url FROM call_log WHERE tenant_id = ? ORDER BY started_at DESC LIMIT 100',
      tenant.id,
    );
    const hooks = webhookUrls(tenant.id);

    return htmlResponse(
      page(
        { title: `Símtöl — ${tenant.name}`, session: ctx.session, active: 'vidskiptavinir', flash: flashFrom(ctx), wide: true,
          breadcrumb: [{ label: 'Viðskiptavinir', href: '/vidskiptavinir' }, { label: tenant.name, href: `/vidskiptavinir/${tenant.id}` }, { label: 'Símtöl' }] },
        html`
          <div class="head"><div><h1>Símtöl</h1><p class="sub">Símsvarinn svarar á íslensku og bókar tíma.</p></div></div>
          ${tenantTabs(tenant.id, 'simtol')}

          <div class="panel" style="margin-bottom:1rem">
            <h3>Vefkrókar fyrir Twilio</h3>
            <p class="small muted">Límdu þessar slóðir inn í stillingar símanúmersins í Twilio.</p>
            <div class="copy mono">Voice: ${hooks.voice}</div>
            <div class="copy mono" style="margin-top:.4rem">Status: ${hooks.status}</div>
            <div class="copy mono" style="margin-top:.4rem">SMS: ${hooks.sms}</div>
          </div>

          ${calls.length === 0
            ? emptyState('Engin símtöl skráð ennþá.')
            : html`<div class="panel"><div class="table-wrap"><table>
                <thead><tr><th>Tími</th><th>Frá</th><th>Lengd</th><th>Niðurstaða</th><th>Umritun</th></tr></thead>
                <tbody>${calls.map((call) => html`
                  <tr>
                    <td>${when(call.started_at, tenant.timezone)}</td>
                    <td>${normalizePhone(call.from_number).display || call.from_number}</td>
                    <td>${call.duration_sec ? `${call.duration_sec}s` : '—'}</td>
                    <td><span class="tag ${call.outcome === 'bokad' ? 'tag-ok' : call.outcome === 'villa' ? 'tag-bad' : 'tag-muted'}">${call.outcome}</span></td>
                    <td class="small" style="max-width:420px">${call.transcript || html`<span class="muted">—</span>`}</td>
                  </tr>`)}
                </tbody></table></div></div>`}`,
      ),
    );
  }, guard);

  // =======================================================================
  // Tenant settings
  // =======================================================================

  router.get('/vidskiptavinir/:id/stillingar', (ctx) => {
    const tenant = getTenantOrThrow(ctx.params.id ?? '');
    const features = getFeatures(tenant.id);
    const calendar = calendarStatus(tenant.id);

    return htmlResponse(
      page(
        { title: `Stillingar — ${tenant.name}`, session: ctx.session, active: 'vidskiptavinir', flash: flashFrom(ctx),
          breadcrumb: [{ label: 'Viðskiptavinir', href: '/vidskiptavinir' }, { label: tenant.name, href: `/vidskiptavinir/${tenant.id}` }, { label: 'Stillingar' }] },
        html`
          <div class="head"><div><h1>Stillingar</h1></div></div>
          ${tenantTabs(tenant.id, 'stillingar')}

          <form method="post" action="/vidskiptavinir/${tenant.id}/stillingar">
            ${csrfField(ctx.session)}
            <div class="grid grid-2">
              <div class="panel">
                <h2>Fyrirtækið</h2>
                ${textField('nafn', 'Nafn', tenant.name)}
                ${textField('netfang', 'Netfang', tenant.email, 'email')}
                ${textField('simi', 'Símanúmer', tenant.phone ? normalizePhone(tenant.phone).display : '')}
                ${textField('len', 'Lén', tenant.websiteDomain, 'text', 't.d. stofan.is')}
                ${textField('heimilisfang', 'Heimilisfang', tenant.address)}
                ${textField('postnumer', 'Póstnúmer', tenant.postcode)}
                <div class="field">
                  <label for="lysing">Um okkur</label>
                  <textarea id="lysing" name="lysing" rows="4">${tenant.about}</textarea>
                </div>
              </div>

              <div class="panel">
                <h2>Bókunarreglur</h2>
                ${numberField('bil', 'Bil milli tíma (mín)', tenant.slotGranularityMin, 5, 120)}
                ${numberField('fyrirvari', 'Lágmarksfyrirvari (mín)', tenant.minNoticeMin, 0, 10080)}
                ${numberField('hamark', 'Hámark fram í tímann (dagar)', tenant.maxAdvanceDays, 1, 365)}
                ${numberField('afbokun', 'Afbókunarfrestur (klst)', tenant.cancelWindowHours, 0, 168)}
                <label class="check">
                  <input type="checkbox" name="fridagar" ${tenant.respectHolidays ? 'checked' : ''}>
                  <span><strong>Loka á lögbundnum frídögum</strong>
                  <span>Bókanir eru ekki í boði á frídögum og styttast á aðfangadag og gamlársdag.</span></span>
                </label>
                <label class="check" style="margin-top:.6rem">
                  <input type="checkbox" name="sjalfvirk" ${tenant.autoConfirm ? 'checked' : ''}>
                  <span><strong>Staðfesta bókanir sjálfkrafa</strong>
                  <span>Annars bíða þær samþykkis.</span></span>
                </label>

                <h2 style="margin-top:1.5rem">Símsvörun</h2>
                <div class="field">
                  <label for="kvedja">Kveðja símsvara</label>
                  <textarea id="kvedja" name="kvedja" rows="3">${tenant.greeting}</textarea>
                </div>
                ${textField('aframsending', 'Áframsendinúmer', tenant.forwardNumber ? normalizePhone(tenant.forwardNumber).display : '')}
                ${textField('skilabodanetfang', 'Netfang fyrir skilaboð', tenant.voicemailEmail, 'email')}
              </div>
            </div>

            <div class="panel" style="margin-top:1rem">
              <h2>Eiginleikar</h2>
              <div class="checks">
                ${FEATURES.map((feature) => html`
                  <label class="check">
                    <input type="checkbox" name="eiginleikar" value="${feature}" ${features[feature].enabled ? 'checked' : ''}>
                    <span><strong>${FEATURE_LABELS[feature].label}</strong><span>${FEATURE_LABELS[feature].description}</span></span>
                  </label>`)}
              </div>
            </div>

            <div class="btn-row" style="margin-top:1rem">
              <button class="btn btn-primary" type="submit">Vista stillingar</button>
            </div>
          </form>

          <div class="panel" style="margin-top:1rem">
            <h2>Google dagatal</h2>
            <p class="small">${calendar.linked ? `Tengt við ${calendar.email || 'reikning'} · síðasta samstilling: ${calendar.lastSync}` : 'Ekki tengt.'}</p>
            ${calendar.error ? html`<p class="error-text">${calendar.error}</p>` : ''}
            <div class="btn-row">
              ${config.google.enabled
                ? html`<a class="btn btn-ghost btn-sm" href="/vidskiptavinir/${tenant.id}/google/tengja">
                    ${calendar.linked ? 'Tengja aftur' : 'Tengja dagatal'}</a>`
                : html`<span class="small muted">GOOGLE_CLIENT_ID vantar í stillingar.</span>`}
              ${calendar.linked
                ? html`
                  <form method="post" action="/vidskiptavinir/${tenant.id}/google/samstilla">
                    ${csrfField(ctx.session)}<button class="btn btn-ghost btn-sm" type="submit">Samstilla núna</button>
                  </form>
                  <form method="post" action="/vidskiptavinir/${tenant.id}/google/aftengja">
                    ${csrfField(ctx.session)}<button class="btn btn-danger btn-sm" type="submit">Aftengja</button>
                  </form>`
                : ''}
            </div>
          </div>`,
      ),
    );
  }, guard);

  router.post('/vidskiptavinir/:id/stillingar', (ctx) => {
    const tenantId = ctx.params.id ?? '';
    const form = ctx.form();

    try {
      updateTenant(tenantId, {
        name: form.nafn,
        email: form.netfang,
        phone: form.simi,
        websiteDomain: form.len,
        address: form.heimilisfang,
        postcode: form.postnumer,
        about: form.lysing,

        slotGranularityMin: Number(form.bil),
        minNoticeMin: Number(form.fyrirvari),
        maxAdvanceDays: Number(form.hamark),
        cancelWindowHours: Number(form.afbokun),
        respectHolidays: form.fridagar === 'on',
        autoConfirm: form.sjalfvirk === 'on',
        greeting: form.kvedja,
        forwardNumber: form.aframsending,
        voicemailEmail: form.skilabodanetfang,
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        return redirect(withFlash(`/vidskiptavinir/${tenantId}/stillingar`, Object.values(error.fieldErrors).join(' '), 'villa'));
      }
      throw error;
    }

    const features = ctx.formList('eiginleikar').filter((value): value is Feature =>
      (FEATURES as readonly string[]).includes(value),
    );
    provisionTenant({ tenantId, features, keepCatalogue: true });

    return redirect(withFlash(`/vidskiptavinir/${tenantId}/stillingar`, 'Stillingar vistaðar.'));
  }, guardWrite);

  // =======================================================================
  // Google OAuth
  // =======================================================================

  router.get('/vidskiptavinir/:id/google/tengja', (ctx) => redirect(buildAuthUrl(ctx.params.id ?? ''), 302), guard);

  router.get('/oauth/google/callback', async (ctx) => {
    const code = ctx.query.get('code');
    const state = ctx.query.get('state');
    const error = ctx.query.get('error');

    if (error) return redirect(withFlash('/vidskiptavinir', `Google hafnaði tengingu: ${error}`, 'villa'));
    if (!code || !state) return redirect(withFlash('/vidskiptavinir', 'Ógilt svar frá Google.', 'villa'));

    const tenantId = parseState(state);
    const tokens = await exchangeCode(code);
    await saveGoogleAccount(tenantId, tokens);
    await syncBusyBlocks(tenantId);
    setTaskStatus(tenantId, 'google_calendar', 'lokid', 'Dagatal tengt.');

    return redirect(withFlash(`/vidskiptavinir/${tenantId}/stillingar`, 'Google dagatal tengt og samstillt.'));
  }, guard);

  router.post('/vidskiptavinir/:id/google/samstilla', async (ctx) => {
    const tenantId = ctx.params.id ?? '';
    const result = await syncBusyBlocks(tenantId);
    return redirect(withFlash(`/vidskiptavinir/${tenantId}/stillingar`, `Samstillt: ${result.imported} atburðir sóttir.`));
  }, guardWrite);

  router.post('/vidskiptavinir/:id/google/aftengja', (ctx) => {
    const tenantId = ctx.params.id ?? '';
    unlinkGoogleAccount(tenantId);
    return redirect(withFlash(`/vidskiptavinir/${tenantId}/stillingar`, 'Dagatal aftengt.'));
  }, guardWrite);

  // =======================================================================
  // Messages and notifications
  // =======================================================================

  router.get('/samskipti', (ctx) => {
    const messages = listMessages({ limit: 100 });
    const tenants = new Map(listTenants().map((tenant) => [tenant.id, tenant.name]));

    return htmlResponse(
      page(
        { title: 'Samskipti', session: ctx.session, active: 'samskipti', flash: flashFrom(ctx), wide: true },
        html`
          <div class="head"><div><h1>Samskipti</h1><p class="sub">Tölvupóstur og SMS sem kerfið hefur sent.</p></div></div>
          ${messages.length === 0
            ? emptyState('Engin skilaboð send ennþá.')
            : html`<div class="panel"><div class="table-wrap"><table>
                <thead><tr><th>Tími</th><th>Fyrirtæki</th><th>Rás</th><th>Viðtakandi</th><th>Efni</th><th>Staða</th></tr></thead>
                <tbody>${messages.map((message) => html`
                  <tr>
                    <td class="small">${when(message.created_at)}</td>
                    <td class="small">${message.tenant_id ? tenants.get(message.tenant_id) ?? '—' : '—'}</td>
                    <td><span class="tag tag-muted">${message.channel}</span></td>
                    <td class="small">${message.to_addr}</td>
                    <td class="small">${message.subject || message.template}</td>
                    <td>${statusTag(message.status)}${message.error ? html`<div class="error-text small">${message.error}</div>` : ''}</td>
                  </tr>`)}
                </tbody></table></div></div>`}`,
      ),
    );
  }, guard);

  // =======================================================================
  // Platform settings
  // =======================================================================

  router.get('/stillingar', (ctx) =>
    htmlResponse(
      page(
        { title: 'Tengingar', session: ctx.session, active: 'stillingar', flash: flashFrom(ctx), wide: true },
        html`
          ${settingsTabs('tengingar')}
          ${integrationsView(ctx.session, lastSmtpTest())}`,
      ),
    ), guard);

  router.post('/stillingar/tengingar', (ctx) => {
    const form = ctx.form();
    const values: Record<string, string> = {};

    for (const key of SETTING_KEYS) {
      // Unchecked checkboxes are absent from the submission, which for a
      // toggle means "false" rather than "leave unchanged".
      if (key === 'SMTP_IMPLICIT_TLS' || key === 'PUSH_ENABLED') {
        values[key] = form[key] === 'true' ? 'true' : 'false';
      } else if (key in form) {
        values[key] = form[key] ?? '';
      }
    }

    const result = saveSettings(values);
    return redirect(
      withFlash(
        '/stillingar',
        result.saved.length > 0
          ? `Tengingar vistaðar (${result.saved.length} gildi uppfærð).`
          : 'Engar breytingar.',
      ),
    );
  }, guardWrite);

  /** Saves first, then sends a real message through the configured server. */
  router.post('/stillingar/profa-post', async (ctx) => {
    const form = ctx.form();
    const values: Record<string, string> = {};
    for (const key of SETTING_KEYS) {
      if (key === 'SMTP_IMPLICIT_TLS' || key === 'PUSH_ENABLED') {
        values[key] = form[key] === 'true' ? 'true' : 'false';
      } else if (key in form) {
        values[key] = form[key] ?? '';
      }
    }
    saveSettings(values);

    const recipient = ctx.session?.email ?? '';
    if (!recipient) {
      return redirect(withFlash('/stillingar', 'Ekkert netfang til að senda á.', 'villa'));
    }

    const result = await testSmtpConnection(null, recipient);

    // The full detail is stored rather than squeezed into a redirect, so the
    // page can show the server's own words next to what to do about them.
    recordSmtpTest({
      at: Date.now(),
      status: result.status,
      recipient,
      error: result.error ?? '',
      host: config.smtp.host,
      warnings: checkSmtpSettings({
        host: config.smtp.host,
        port: config.smtp.port,
        user: config.smtp.user,
        fromEmail: config.smtp.fromEmail,
        implicitTls: config.smtp.implicitTls,
      }),
    });

    if (result.status === 'sent') {
      return redirect(withFlash('/stillingar', `Prófunarpóstur sendur á ${recipient}. Athugaðu pósthólfið (og ruslpóst).`));
    }
    if (result.status === 'thurrkeyrsla') {
      return redirect(withFlash('/stillingar', 'SMTP er ekki fullstillt — fylltu út þjón og sendandanetfang.', 'upplysing'));
    }

    const diagnosis = diagnoseSmtpError(result.error ?? '', config.smtp.host);
    return redirect(
      withFlash('/stillingar', diagnosis ? diagnosis.title : 'Sending mistókst — sjá nánar hér að neðan.', 'villa'),
    );
  }, guardWrite);

  /** Environment and diagnostics, kept separate from the credential forms. */
  router.get('/stillingar/kerfi', (ctx) => {
    const tenants = listTenants();
    const notifications = tenants.flatMap((tenant) => listNotifications(tenant.id, 10));

    return htmlResponse(
      page(
        { title: 'Kerfið', session: ctx.session, active: 'stillingar', flash: flashFrom(ctx) },
        html`
          ${settingsTabs('kerfi')}

          <div class="head"><div><h1>Kerfið</h1><p class="sub">Umhverfi og staða.</p></div></div>

          ${buildInfo.packaged
            ? html`<div class="flash flash-upplysing" style="margin-bottom:1.2rem">
                ${icon('M12 16v-5M12 8.5v.5M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z', 18)}
                <span>Þetta er keyrsluskrá. Hún uppfærist ekki sjálf — keyrðu
                <span class="mono">git pull</span> og <span class="mono">npm run exe</span>
                til að fá nýja útgáfu.</span>
              </div>`
            : ''}

          <div class="panel">
            <h2>Umhverfi</h2>
            <div class="table-wrap"><table><tbody>
              <tr><td>Útgáfa</td><td class="mono">${buildLabel()}</td></tr>
              <tr><td>Slóð</td><td class="mono">${config.baseUrl}</td></tr>
              <tr><td>Umhverfi</td><td class="mono">${config.env}</td></tr>
              <tr><td>Gagnagrunnur</td><td class="mono">${config.databasePath}</td></tr>
              <tr><td>Vefsíður</td><td class="mono">${config.sitesDir}</td></tr>
              <tr><td>Tímabelti</td><td class="mono">${config.defaults.timezone}</td></tr>
              <tr><td>Áminning</td><td class="mono">${config.booking.reminderHoursBefore} klst. fyrir tíma</td></tr>
            </tbody></table></div>
            <p class="small muted" style="margin-top:1rem">
              Taktu afrit af möppunni sem gagnagrunnurinn er í — hún geymir allt kerfið.
            </p>
          </div>

          <div class="panel" style="margin-top:1rem">
            <h2>Síðustu tilkynningar í app</h2>
            ${notifications.length === 0
              ? html`<p class="muted">Engar tilkynningar sendar ennþá.</p>`
              : html`<div class="table-wrap"><table>
                  <thead><tr><th>Tími</th><th>Titill</th><th>Staða</th></tr></thead>
                  <tbody>${notifications.slice(0, 20).map((notification) => html`
                    <tr><td class="small">${when(notification.created_at)}</td>
                        <td class="small">${notification.title}</td>
                        <td>${statusTag(notification.status)}</td></tr>`)}
                  </tbody></table></div>`}
          </div>`,
      ),
    );
  }, guard);

  return router;
}

// ---------------------------------------------------------------------------
// Form partials
// ---------------------------------------------------------------------------

function textField(name: string, label: string, value: string, type = 'text', help = ''): SafeHtml {
  return html`
    <div class="field">
      <label for="${name}">${label}</label>
      <input id="${name}" name="${name}" type="${type}" value="${value}">
      ${help ? html`<p class="help">${help}</p>` : ''}
    </div>`;
}

function numberField(name: string, label: string, value: number, min: number, max: number): SafeHtml {
  return html`
    <div class="field">
      <label for="${name}">${label}</label>
      <input id="${name}" name="${name}" type="number" value="${value}" min="${min}" max="${max}">
    </div>`;
}

function loginPage(next: string, error: string | null): SafeHtml {
  return page(
    { title: 'Innskráning', session: null, bare: true },
    html`
      <div class="auth-shell">
        <div class="auth-brand">
          <div class="auth-mark">RÞ</div>
          <h1>Rafræn Þjónusta</h1>
          <p>
            Stjórnborð fyrir stafræna þjónustu við íslensk smáfyrirtæki —
            vefsíður, bókanir, tölvupóst og símsvörun.
          </p>
          <ul class="auth-points">
            <li><strong>Vefsíður</strong> — þrjár tillögur, þú velur</li>
            <li><strong>Bókanir</strong> — spurningaflæði eftir fagi</li>
            <li><strong>Tölvupóstur</strong> — DNS-færslur og eftirlit</li>
            <li><strong>Símsvörun</strong> — svarar á íslensku</li>
          </ul>
        </div>

        <div class="auth-card">
          <h2>Innskráning</h2>
          <p class="muted">Sláðu inn aðganginn þinn til að halda áfram.</p>

          ${error ? html`<div class="flash flash-villa">${icon('M12 8v5M12 16.5v.5M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z', 18)}<span>${error}</span></div>` : ''}

          <form method="post" action="/innskraning">
            <input type="hidden" name="next" value="${next}">
            <div class="field">
              <label for="netfang">Netfang</label>
              <input id="netfang" name="netfang" type="email" autocomplete="username" required autofocus>
            </div>
            <div class="field">
              <label for="lykilord">Lykilorð</label>
              <input id="lykilord" name="lykilord" type="password" autocomplete="current-password" required>
            </div>
            <button class="btn btn-primary btn-block" type="submit">Skrá inn</button>
          </form>

          <p class="auth-foot">
            Gögnin þín eru geymd á þessari tölvu. Ekkert fer í skýið nema það
            sem þú tengir sjálf/ur.
          </p>
        </div>
      </div>`,
  );
}

/** Renders the extra data attached to a provisioning task. */
function taskPayload(tenantId: string, key: string, payload: Record<string, unknown>, ctx: RequestContext): SafeHtml {
  if (key === 'tolvupostur') {
    const records = (payload.faerslur ?? []) as Array<{ type: string; host: string; value: string; priority?: number; purpose: string; providerSupplied?: boolean }>;
    const steps = (payload.skref ?? []) as string[];
    const mailboxes = (payload.netfong ?? []) as string[];

    return html`
      <details style="margin-top:.75rem">
        <summary class="small">DNS-færslur og skref (${records.length})</summary>
        <ol class="small" style="margin:.75rem 0">${steps.map((step) => html`<li>${step}</li>`)}</ol>
        <div class="table-wrap"><table>
          <thead><tr><th>Tegund</th><th>Nafn</th><th>Gildi</th><th>Tilgangur</th></tr></thead>
          <tbody>${records.map((record) => html`
            <tr>
              <td class="mono">${record.type}${record.priority ? ` (${record.priority})` : ''}</td>
              <td class="mono">${record.host}</td>
              <td class="mono">${record.providerSupplied && !record.value ? html`<span class="tag tag-warn">Kemur frá þjónustuaðila</span>` : record.value}</td>
              <td class="small muted">${record.purpose}</td>
            </tr>`)}
          </tbody></table></div>
        ${mailboxes.length ? html`<p class="small" style="margin-top:.6rem">Tillaga að netföngum: ${mailboxes.join(', ')}</p>` : ''}
        <form method="post" action="/vidskiptavinir/${tenantId}/dns" style="margin-top:.75rem">
          ${csrfField(ctx.session)}
          <input type="hidden" name="postthjonusta" value="${String(payload.provider ?? 'google')}">
          <input type="hidden" name="len" value="${String(payload.domain ?? '')}">
          <button class="btn btn-ghost btn-sm" type="submit">Athuga DNS núna</button>
        </form>
      </details>`;
  }

  if (key === 'simsvorun') {
    const hooks = (payload.vefkrokar ?? {}) as Record<string, string>;
    return html`
      <details style="margin-top:.75rem">
        <summary class="small">Vefkrókar fyrir Twilio</summary>
        ${Object.entries(hooks).map(([label, url]) => html`<div class="copy mono" style="margin-top:.4rem">${label}: ${url}</div>`)}
      </details>`;
  }

  if (key === 'app_tilkynningar' && payload.kodi) {
    return html`<p class="small" style="margin-top:.5rem">Pörunarkóði: <strong class="mono">${String(payload.kodi)}</strong></p>`;
  }

  if (key === 'vefsida' && payload.forskodunSlod) {
    return html`<p class="small" style="margin-top:.5rem"><a href="${String(payload.forskodunSlod)}">Skoða útlitstillögur</a></p>`;
  }

  return html``;
}

/**
 * The onboarding wizard: one page, sensible defaults, everything editable later.
 *
 * Both the staff list and the capacity input are rendered up front and toggled
 * client-side by the trade selector. The obvious alternative — re-submitting
 * the form when the trade changes — throws away everything already typed and
 * greets the operator with validation errors for fields they have not reached
 * yet, so it is worth the twenty lines of inline script to avoid.
 */
function wizardForm(ctx: RequestContext, values: Record<string, string>, errors: Record<string, string>): SafeHtml {
  const selected = values.fag ?? 'hargreidslustofa';
  const firstRender = values.nafn === undefined;
  const checked = ctx.formList('eiginleikar');

  /** Per-trade facts the inline script uses to update the live summary. */
  const facts = Object.fromEntries(
    INDUSTRIES.map((entry) => [
      entry.key,
      {
        label: entry.label,
        staffled: entry.staffled,
        thjonustur: entry.services.length,
        spurningar: flowSummary(entry.key).total,
        starfsheiti: entry.defaultStaffTitle,
      },
    ]),
  );

  const field = (name: string, label: string, options: { type?: string; help?: string; placeholder?: string } = {}) => html`
    <div class="field">
      <label for="${name}">${label}</label>
      <input id="${name}" name="${name}" type="${options.type ?? 'text'}"
             value="${values[name] ?? ''}" placeholder="${options.placeholder ?? ''}">
      ${options.help ? html`<p class="help">${options.help}</p>` : ''}
      ${errors[name] ? html`<p class="error-text">${errors[name]}</p>` : ''}
    </div>`;

  return html`
    <div class="head">
      <div>
        <h1>Nýr viðskiptavinur</h1>
        <p class="sub">Sláðu inn nafn, veldu fag og hakaðu við það sem á að setja upp. Restin gerist sjálfkrafa.</p>
      </div>
    </div>

    <form method="post" action="/vidskiptavinir/nyr" id="wizard">
      ${csrfField(ctx.session)}

      <div class="grid grid-2">
        <div class="panel">
          <h2>1 · Fyrirtækið</h2>
          ${field('nafn', 'Nafn fyrirtækis', { placeholder: 'Hárstofan Ösp' })}

          <div class="field">
            <label for="fag">Fag</label>
            <select id="fag" name="fag">
              ${INDUSTRIES.map((entry) => html`
                <option value="${entry.key}" ${entry.key === selected ? 'selected' : ''}>${entry.emoji} ${entry.label}</option>`)}
            </select>
            <p class="help">Ræður þjónustulista, opnunartíma, spurningaflæði og útlitstillögum.</p>
          </div>

          <div class="field">
            <label for="kennitala">Kennitala</label>
            <div class="lookup-row">
              <input id="kennitala" name="kennitala" type="text" placeholder="000000-0000"
                     value="${values.kennitala ?? ''}" autocomplete="off">
              <button class="btn btn-ghost" type="button" id="uppfletting">Sækja upplýsingar</button>
            </div>
            <p class="help">Sækir nafn, heimilisfang og fag úr fyrirtækjaskrá, og lén, síma og netfang úr lénaskrá.</p>
            ${errors.kennitala ? html`<p class="error-text">${errors.kennitala}</p>` : ''}
            <div id="uppfletting-svar" hidden></div>
          </div>
          ${field('netfang', 'Netfang', { type: 'email' })}
          ${field('simi', 'Símanúmer', { placeholder: '555 1234' })}
          ${field('len', 'Lén', { placeholder: 'stofan.is', help: 'Ef lénið er ekki til ennþá má sleppa því.' })}
          ${field('heimilisfang', 'Heimilisfang')}
          ${field('postnumer', 'Póstnúmer', { placeholder: '101' })}

          <div class="field">
            <label for="lysing">Lýsing á fyrirtækinu</label>
            <textarea id="lysing" name="lysing" rows="4"
              placeholder="Hvað gerir fyrirtækið, hverjir eru viðskiptavinirnir, hvað greinir það frá öðrum?">${values.lysing ?? ''}</textarea>
            <p class="help">Notað í vefsíðutexta. Sleppirðu því notum við staðlaðan texta fyrir fagið.</p>
          </div>
        </div>

        <div>
          <div class="panel">
            <h2>2 · Hvað á að setja upp?</h2>
            <div class="checks">
              ${FEATURES.map((feature) => html`
                <label class="check">
                  <input type="checkbox" name="eiginleikar" value="${feature}"
                         ${firstRender || checked.includes(feature) ? 'checked' : ''}>
                  <span><strong>${FEATURE_LABELS[feature].label}</strong><span>${FEATURE_LABELS[feature].description}</span></span>
                </label>`)}
            </div>
          </div>

          <div class="panel" style="margin-top:1rem">
            <h2>3 · Um reksturinn</h2>

            <div class="field" data-when="staffled">
              <label for="starfsfolk">Starfsfólk sem tekur bókanir</label>
              <textarea id="starfsfolk" name="starfsfolk" rows="4"
                        placeholder="Eitt nafn í hverri línu">${values.starfsfolk ?? ''}</textarea>
              <p class="help">Hver fær sitt eigið dagatal og lausa tíma. Má sleppa og bæta við síðar.</p>
            </div>

            <div class="field" data-when="pool">
              <label for="afkastageta">Hversu mörg verk geta verið í gangi samtímis?</label>
              <input id="afkastageta" name="afkastageta" type="number" min="1" max="20"
                     value="${values.afkastageta ?? '2'}">
              <p class="help">Til dæmis fjöldi lyfta á verkstæði eða vinnuborða á stofu.</p>
            </div>

            <div class="field">
              <label for="postthjonusta">Póstþjónusta</label>
              <select id="postthjonusta" name="postthjonusta">
                <option value="google">Google Workspace</option>
                <option value="proton">Proton Mail</option>
                <option value="annad">Annar aðili</option>
              </select>
              <p class="help">Við búum til réttar DNS-færslur og athugum þær fyrir þig.</p>
            </div>

            <div class="field">
              <label for="athugasemd">Innri athugasemd</label>
              <textarea id="athugasemd" name="athugasemd" rows="2" placeholder="Sést ekki viðskiptavininum">${values.athugasemd ?? ''}</textarea>
            </div>
          </div>

          <div class="panel" style="margin-top:1rem">
            <h3>Þetta verður búið til</h3>
            <ul class="auth-points" style="margin-top:.9rem">
              <li><strong data-fact="thjonustur"></strong> þjónustur með verði og tímalengd</li>
              <li>Opnunartími fyrir <strong data-fact="label"></strong></li>
              <li>Spurningaflæði með <strong data-fact="spurningar"></strong> spurningum</li>
              <li>Þrjár fullbúnar útlitstillögur að vefsíðu</li>
              <li>Verkefnalisti með því sem þarf að klára handvirkt</li>
            </ul>
          </div>
        </div>
      </div>

      <div class="btn-row" style="margin-top:1.25rem">
        <button class="btn btn-primary" type="submit">Stofna og setja upp</button>
        <a class="btn btn-ghost" href="/vidskiptavinir">Hætta við</a>
      </div>
    </form>

    <script>
      (function () {
        var facts = ${jsonScript(facts)};
        var select = document.getElementById('fag');
        var form = document.getElementById('wizard');

        function apply() {
          var entry = facts[select.value];
          if (!entry) return;

          form.querySelectorAll('[data-when="staffled"]').forEach(function (node) {
            node.hidden = !entry.staffled;
          });
          form.querySelectorAll('[data-when="pool"]').forEach(function (node) {
            node.hidden = entry.staffled;
          });
          form.querySelectorAll('[data-fact]').forEach(function (node) {
            node.textContent = entry[node.getAttribute('data-fact')];
          });
        }

        select.addEventListener('change', apply);
        apply();

        // --- Company lookup by kennitala ---------------------------------
        var SOURCE_LABEL = {
          fyrirtaekjaskra: 'fyrirtækjaskrá',
          isnic: 'lénaskrá',
          gervigreind: 'gervigreind'
        };

        var fagTouched = false;
        select.addEventListener('change', function () { fagTouched = true; });

        var button = document.getElementById('uppfletting');
        var panel = document.getElementById('uppfletting-svar');
        var ktInput = document.getElementById('kennitala');

        function note(kind, text) {
          panel.hidden = false;
          panel.className = 'lookup-note lookup-' + kind;
          panel.textContent = text;
        }

        // A filled field is marked with where the value came from, so an
        // AI-written description is never mistaken for a registry fact.
        function markSource(name, source) {
          var input = form.elements[name];
          if (!input) return;
          var wrapper = input.closest('.field');
          if (!wrapper) return;

          var existing = wrapper.querySelector('.source-tag');
          if (existing) existing.remove();

          var tag = document.createElement('span');
          tag.className = 'source-tag source-' + source;
          tag.textContent = SOURCE_LABEL[source] || source;
          var label = wrapper.querySelector('label');
          if (label) label.appendChild(tag);
        }

        async function lookup() {
          var kennitala = ktInput.value.trim();
          if (!kennitala) { note('bad', 'Sláðu inn kennitölu fyrst.'); return; }

          button.disabled = true;
          var original = button.textContent;
          button.textContent = 'Leita…';
          note('info', 'Fletti upp í fyrirtækjaskrá og lénaskrá…');

          try {
            var body = new URLSearchParams();
            body.set('kennitala', kennitala);
            body.set('_csrf', form.elements._csrf.value);

            var response = await fetch('/vidskiptavinir/uppfletting', {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: body.toString()
            });
            var result = await response.json();

            if (!result.found) { note('bad', result.message); return; }

            var filled = [];
            Object.keys(result.profile.fields).forEach(function (name) {
              var entry = result.profile.fields[name];
              var input = form.elements[name];
              if (!input) return;

              // Never overwrite something already typed — the operator may
              // know better than the register does. A <select> always reports
              // a value (its first option), so "untouched" has to be tracked
              // rather than inferred from emptiness.
              var untouched = input.tagName === 'SELECT' ? !fagTouched : input.value.trim() === '';
              if (!untouched) return;

              input.value = entry.value;
              markSource(name, entry.source);
              filled.push(name);
              if (name === 'fag') apply();
            });

            var lines = [];
            lines.push(filled.length + ' reitir fylltir út.');
            if (result.profile.legalForm) lines.push('Rekstrarform: ' + result.profile.legalForm);
            if (result.profile.isat) lines.push('ÍSAT: ' + result.profile.isat);
            if (result.profile.vskNumber) lines.push('VSK-númer: ' + result.profile.vskNumber);
            result.profile.notes.forEach(function (entry) { lines.push('• ' + entry); });

            note(filled.length > 0 ? 'ok' : 'info', lines.join('\\n'));
          } catch (error) {
            note('bad', 'Uppfletting mistókst: ' + error);
          } finally {
            button.disabled = false;
            button.textContent = original;
          }
        }

        button.addEventListener('click', lookup);
        ktInput.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') { event.preventDefault(); lookup(); }
        });
      })();
    </script>

    <style>
      .lookup-row{display:flex;gap:.5rem;align-items:stretch}
      .lookup-row input{flex:1}
      .lookup-note{margin-top:.6rem;padding:.7rem .85rem;border-radius:var(--r);font-size:.87rem;
        white-space:pre-line;line-height:1.5;border:1px solid transparent}
      .lookup-ok{background:var(--ok-soft);color:var(--ok);border-color:color-mix(in srgb,var(--ok) 25%,transparent)}
      .lookup-info{background:var(--brand-soft);color:var(--brand);border-color:color-mix(in srgb,var(--brand) 25%,transparent)}
      .lookup-bad{background:var(--bad-soft);color:var(--bad);border-color:color-mix(in srgb,var(--bad) 25%,transparent)}
      .source-tag{margin-left:.45rem;padding:.1rem .42rem;border-radius:999px;font-size:.68rem;
        font-weight:700;letter-spacing:.03em;text-transform:uppercase;vertical-align:middle}
      .source-fyrirtaekjaskra{background:var(--ok-soft);color:var(--ok)}
      .source-isnic{background:var(--brand-soft);color:var(--brand)}
      .source-gervigreind{background:var(--warn-soft);color:var(--warn)}
    </style>`;
}
