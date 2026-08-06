/**
 * First-run setup, performed in the browser.
 *
 * The packaged desktop build has no terminal to run `npm run setup` in, so the
 * operator account is created through a web form instead.
 *
 * The security model is simple and strict: this route only functions while
 * *zero* operators exist. The moment the account is created the route stops
 * accepting anything, so it cannot be used to add a second account later. It is
 * also bound to loopback in the desktop build, so it is not reachable from the
 * network during the window in which it is live.
 */

import { forbidden } from '../core/errors.ts';
import { html, raw, type SafeHtml } from '../core/html.ts';
import { logger } from '../core/logger.ts';
import { config, useSecureCookies } from '../config.ts';
import { SESSION_COOKIE, createOperator, login, operatorCount } from '../domain/auth.ts';
import { htmlResponse, redirect, serializeCookie, withCookie } from '../http/response.ts';
import type { Router } from '../http/router.ts';
import { page } from './layout.ts';

/** Guards every first-run route: available only before an account exists. */
function assertFirstRun(): void {
  if (operatorCount() > 0) {
    throw forbidden('Uppsetningu er þegar lokið. Skráðu þig inn í staðinn.');
  }
}

export function registerFirstRun(router: Router): void {
  router.get('/uppsetning', () => {
    if (operatorCount() > 0) return redirect('/innskraning');
    return htmlResponse(setupPage({}, {}));
  });

  router.post('/uppsetning', async (ctx) => {
    assertFirstRun();

    const form = ctx.form();
    const email = (form.netfang ?? '').trim().toLowerCase();
    const password = form.lykilord ?? '';
    const repeat = form.lykilord_aftur ?? '';
    const name = (form.nafn ?? '').trim();

    const errors: Record<string, string> = {};
    if (!email.includes('@')) errors.netfang = 'Sláðu inn gilt netfang.';
    if (password.length < 12) errors.lykilord = 'Lykilorð verður að vera að minnsta kosti 12 stafir.';
    if (password !== repeat) errors.lykilord_aftur = 'Lykilorðin stemma ekki.';

    if (Object.keys(errors).length > 0) {
      return htmlResponse(setupPage({ netfang: email, nafn: name }, errors), 422);
    }

    await createOperator(email, password, name);
    logger.info('Uppsetningu lokið í vafra', { email });

    // Sign the operator straight in — asking them to type the password again
    // immediately after choosing it is pure friction.
    const session = await login(email, password, {
      ip: ctx.ip,
      userAgent: String(ctx.headers['user-agent'] ?? ''),
    });

    const cookie = serializeCookie(SESSION_COOKIE, session.sessionToken, {
      maxAgeSec: config.operator.sessionTtlHours * 3600,
      secure: useSecureCookies(),
      sameSite: 'Lax',
    });

    // Encoded programmatically: hand-writing percent-escapes around Icelandic
    // characters produces mojibake, because the non-ASCII bytes slip through
    // unencoded and are then decoded as Latin-1.
    const welcome = encodeURIComponent('Velkomin! Byrjaðu á að stofna fyrsta viðskiptavininn.');
    return withCookie(redirect(`/stjornbord?skilabod=${welcome}&tegund=gott`), cookie);
  });
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function setupPage(values: Record<string, string>, errors: Record<string, string>): SafeHtml {
  const field = (
    name: string,
    label: string,
    options: { type?: string; help?: string; autocomplete?: string; autofocus?: boolean } = {},
  ) => html`
    <div class="field">
      <label for="${name}">${label}</label>
      <input
        id="${name}"
        name="${name}"
        type="${options.type ?? 'text'}"
        value="${values[name] ?? ''}"
        autocomplete="${options.autocomplete ?? 'off'}"
        ${options.autofocus ? raw('autofocus') : ''}
      >
      ${options.help ? html`<p class="help">${options.help}</p>` : ''}
      ${errors[name] ? html`<p class="error-text">${errors[name]}</p>` : ''}
    </div>`;

  return page(
    { title: 'Uppsetning', session: null, bare: true },
    html`
      <div class="auth-shell">
        <div class="auth-brand">
          <div class="auth-mark">RÞ</div>
          <h1>Velkomin í Rafræna Þjónustu</h1>
          <p>
            Þetta er fyrsta keyrsla. Búðu til aðganginn þinn — hann er sá eini
            sem kerfið hefur, og með honum stjórnar þú öllum viðskiptavinum.
          </p>

          <ul class="auth-points">
            <li><strong>Vefsíður</strong> — þrjár tillögur, þú velur</li>
            <li><strong>Bókanir</strong> — spurningaflæði eftir fagi</li>
            <li><strong>Tölvupóstur</strong> — DNS-færslur og eftirlit</li>
            <li><strong>Símsvörun</strong> — svarar á íslensku</li>
          </ul>
        </div>

        <div class="auth-card">
          <h2>Stofna aðgang</h2>
          <p class="muted">Gögnin þín eru geymd á þessari tölvu, ekki í skýinu.</p>

          <form method="post" action="/uppsetning" novalidate>
            ${field('nafn', 'Nafn', { autocomplete: 'name', autofocus: true })}
            ${field('netfang', 'Netfang', { type: 'email', autocomplete: 'username' })}
            ${field('lykilord', 'Lykilorð', {
              type: 'password',
              autocomplete: 'new-password',
              help: 'Að minnsta kosti 12 stafir. Því lengra, því betra.',
            })}
            ${field('lykilord_aftur', 'Lykilorð aftur', { type: 'password', autocomplete: 'new-password' })}

            <button class="btn btn-primary btn-block" type="submit">Stofna aðgang og byrja</button>
          </form>

          <p class="auth-foot">
            Gleymt lykilorð er ekki hægt að endurheimta — það er hvergi geymt,
            aðeins dulkóðað fingrafar af því. Skrifaðu það hjá þér.
          </p>
        </div>
      </div>`,
  );
}
