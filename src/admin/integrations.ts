/**
 * The integrations settings page.
 *
 * Every external service the platform can use is configured here, with the
 * signup steps written next to the fields they produce. The alternative —
 * documenting credentials in a README and asking the operator to edit a file —
 * does not work at all for a packaged desktop app, and works badly everywhere
 * else.
 */

import { html, raw, type SafeHtml } from '../core/html.ts';
import { config, integrationStatus } from '../config.ts';
import { environmentKeys, isSecret, settingsForForm, SETTING_KEYS } from '../domain/settings.ts';
import { webhookUrls } from '../integrations/twilio.ts';
import type { OperatorSession } from '../http/context.ts';
import { csrfField, icon, statusTag } from './layout.ts';

export interface FieldSpec {
  key: string;
  label: string;
  type?: 'text' | 'password' | 'number' | 'email';
  placeholder?: string;
  help?: string;
  /** Renders as a checkbox rather than a text input. */
  toggle?: boolean;
}

export interface IntegrationSpec {
  key: string;
  title: string;
  /** One line explaining what breaks without it. */
  purpose: string;
  /** What happens when it is not configured. */
  withoutIt: string;
  /** Numbered signup steps, written for someone who has never done it. */
  steps: SafeHtml[];
  fields: FieldSpec[];
  docsUrl?: string;
  docsLabel?: string;
}

/** Built as a function because some steps embed the tenant's live URLs. */
export function integrationSpecs(): IntegrationSpec[] {
  const callbackUrl = `${config.baseUrl}/oauth/google/callback`;

  return [
    {
      key: 'google',
      title: 'Google Calendar',
      purpose: 'Bókanir birtast í dagatali fyrirtækisins, og einkatímar í dagatalinu loka á bókanir á móti.',
      withoutIt: 'Bókanir virka áfram, en ekkert samstillist við Google.',
      docsUrl: 'https://console.cloud.google.com/apis/credentials',
      docsLabel: 'Google Cloud Console',
      steps: [
        html`Farðu á <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a> og búðu til nýtt verkefni (t.d. „Rafræn Þjónusta“).`,
        html`Í <strong>APIs &amp; Services → Library</strong>, leitaðu að <strong>Google Calendar API</strong> og ýttu á <em>Enable</em>.`,
        html`Í <strong>APIs &amp; Services → OAuth consent screen</strong>, veldu <strong>External</strong>, fylltu út nafn og netfang, og vistaðu. Þú þarft ekki að senda inn til yfirferðar — bættu bara þínu eigin Google-netfangi við sem <em>Test user</em>.`,
        html`Í <strong>Credentials → Create credentials → OAuth client ID</strong>, veldu <strong>Web application</strong>.`,
        html`Undir <strong>Authorized redirect URIs</strong>, límdu inn nákvæmlega þessa slóð:
          <span class="copy mono" style="display:block;margin:.5rem 0">${callbackUrl}</span>
          Hún verður að stemma stafrétt, annars hafnar Google tengingunni.`,
        html`Afritaðu <strong>Client ID</strong> og <strong>Client secret</strong> hingað niður og vistaðu.`,
        html`Að lokum: opnaðu viðskiptavin, farðu í <strong>Stillingar</strong> og ýttu á <em>Tengja dagatal</em>. Hver viðskiptavinur tengir sitt eigið dagatal.`,
      ],
      fields: [
        { key: 'GOOGLE_CLIENT_ID', label: 'Client ID', placeholder: '123456789-abc.apps.googleusercontent.com' },
        { key: 'GOOGLE_CLIENT_SECRET', label: 'Client secret', type: 'password' },
        {
          key: 'GOOGLE_REDIRECT_URI',
          label: 'Redirect URI',
          placeholder: callbackUrl,
          help: 'Sjálfgefið er slóðin hér að ofan. Breyttu aðeins ef þú keyrir á öðru léni.',
        },
      ],
    },

    {
      key: 'email',
      title: 'Tölvupóstur (SMTP)',
      purpose: 'Staðfestingar, áminningar og skilaboð úr símsvara fara út með pósti.',
      withoutIt: 'Póstar eru samdir og skráðir en ekki sendir — merktir „þurrkeyrsla“ í Samskipti.',
      steps: [
        html`<strong>Gmail eða Google Workspace</strong> — kveiktu á tveggja þátta auðkenningu, farðu svo á
          <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords</a>
          og búðu til <em>app-lykilorð</em>. Notaðu það sem lykilorð hér, ekki venjulega lykilorðið þitt.
          Þjónn: <span class="mono">smtp.gmail.com</span>, port <span class="mono">587</span>.`,
        html`<strong>Proton Mail</strong> — settu upp
          <a href="https://proton.me/mail/bridge" target="_blank" rel="noopener">Proton Mail Bridge</a>
          á sömu vél. Bridge gefur þér þjón <span class="mono">127.0.0.1</span>, port <span class="mono">1025</span>
          og sitt eigið lykilorð.`,
        html`<strong>Annar þjónustuaðili</strong> — hvaða SMTP-þjónn sem er virkar. Port 587 notar STARTTLS, port 465 notar TLS strax.`,
        html`Vistaðu og ýttu á <em>Senda prófunarpóst</em> hér að neðan til að staðfesta að þetta virki.`,
      ],
      fields: [
        { key: 'SMTP_HOST', label: 'Þjónn', placeholder: 'smtp.gmail.com' },
        { key: 'SMTP_PORT', label: 'Port', type: 'number', placeholder: '587' },
        { key: 'SMTP_USER', label: 'Notandanafn', placeholder: 'nafn@fyrirtaeki.is' },
        { key: 'SMTP_PASSWORD', label: 'Lykilorð', type: 'password', help: 'App-lykilorð fyrir Gmail, Bridge-lykilorð fyrir Proton.' },
        { key: 'SMTP_FROM_EMAIL', label: 'Sendandanetfang', type: 'email', placeholder: 'bokanir@fyrirtaeki.is' },
        { key: 'SMTP_FROM_NAME', label: 'Sendandanafn', placeholder: 'Rafræn Þjónusta' },
        { key: 'SMTP_IMPLICIT_TLS', label: 'Nota TLS strax (port 465)', toggle: true },
      ],
    },

    {
      key: 'twilio',
      title: 'Símsvörun og SMS (Twilio)',
      purpose: 'Símsvari sem svarar á íslensku og bókar tíma, ásamt SMS-staðfestingum og áminningum.',
      withoutIt: 'Símsvörun er óvirk og SMS fara í þurrkeyrslu.',
      docsUrl: 'https://console.twilio.com/',
      docsLabel: 'Twilio Console',
      steps: [
        html`Stofnaðu reikning á <a href="https://www.twilio.com/try-twilio" target="_blank" rel="noopener">twilio.com</a>. Prufureikningur virkar til að byrja með.`,
        html`Á forsíðu <strong>Console</strong> finnurðu <strong>Account SID</strong> og <strong>Auth Token</strong>. Afritaðu bæði hingað.`,
        html`Í <strong>Phone Numbers → Buy a number</strong>, veldu númer sem styður bæði <em>Voice</em> og <em>SMS</em>. Íslensk númer eru til, en bandarískt númer er ódýrara ef þú ert bara að prófa.`,
        html`Skráðu númerið hér að neðan á forminu <span class="mono">+3545550100</span>.`,
        html`Opnaðu svo hvern viðskiptavin í <strong>Símtöl</strong>-flipanum — þar eru þrjár vefkrókaslóðir sem þú límir inn í stillingar númersins í Twilio.`,
        html`<strong>Athugið:</strong> vefkrókarnir þurfa að ná í þessa vél utan frá. Keyrirðu á eigin tölvu þarftu göng, t.d.
          <a href="https://ngrok.com/" target="_blank" rel="noopener">ngrok</a>, og að skrá þá slóð sem BASE_URL.`,
      ],
      fields: [
        { key: 'TWILIO_ACCOUNT_SID', label: 'Account SID', placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
        { key: 'TWILIO_AUTH_TOKEN', label: 'Auth Token', type: 'password' },
        { key: 'TWILIO_PHONE_NUMBER', label: 'Símanúmer', placeholder: '+3545550100' },
      ],
    },

    {
      key: 'push',
      title: 'Snjallsímatilkynningar (Expo)',
      purpose: 'Tilkynning í síma eiganda um leið og bókun berst.',
      withoutIt: 'Tilkynningar eru skráðar en ekki sendar.',
      steps: [
        html`Virkar án uppsetningar meðan appið er keyrt í gegnum <strong>Expo Go</strong> — engir lyklar þarf.`,
        html`Þegar þú gefur út appið í App Store eða Google Play, keyrðu <span class="mono">eas build:configure</span> í <span class="mono">mobile/</span> möppunni.`,
        html`Krefjist Expo-verkefnið auðkenningar á push, límdu aðgangslykilinn hér að neðan. Annars má skilja hann eftir auðan.`,
        html`Pörunarkóði fyrir hvert tæki er búinn til á <strong>Uppsetning</strong>-flipa viðskiptavinarins.`,
      ],
      fields: [
        { key: 'EXPO_ACCESS_TOKEN', label: 'Expo access token', type: 'password', help: 'Valfrjálst.' },
        { key: 'PUSH_ENABLED', label: 'Senda tilkynningar', toggle: true },
      ],
    },

    {
      key: 'ai',
      title: 'Gervigreind (Anthropic)',
      purpose: 'Tillögur þegar viðskiptavinur lýsir óskum sínum með eigin orðum, og textagerð fyrir vefsíður.',
      withoutIt: 'Tilbúnar tillögur eftir fagi eru notaðar. Bókun stöðvast aldrei.',
      docsUrl: 'https://console.anthropic.com/settings/keys',
      docsLabel: 'Anthropic Console',
      steps: [
        html`Stofnaðu reikning á <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a>.`,
        html`Farðu í <strong>Settings → API keys</strong> og búðu til nýjan lykil.`,
        html`Límdu hann hér að neðan. Lykillinn er dulkóðaður áður en hann fer í gagnagrunninn.`,
        html`Þetta er eina tengingin sem kostar eftir notkun — hver tillaga er örfáar krónur.`,
      ],
      fields: [
        { key: 'ANTHROPIC_API_KEY', label: 'API-lykill', type: 'password', placeholder: 'sk-ant-...' },
        { key: 'AI_MODEL', label: 'Líkan', placeholder: 'claude-sonnet-5' },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function integrationsView(session: OperatorSession | null): SafeHtml {
  const values = settingsForForm();
  const status = new Map(integrationStatus().map((entry) => [entry.key, entry]));
  const fromEnv = new Set(environmentKeys());
  const specs = integrationSpecs();

  const field = (spec: FieldSpec): SafeHtml => {
    const current = values[spec.key] ?? { value: '', hasSecret: false };
    const envProvided = fromEnv.has(spec.key);

    if (spec.toggle) {
      const on = current.value === '' ? spec.key === 'PUSH_ENABLED' : current.value === 'true';
      return html`
        <label class="check" style="margin-bottom:1.05rem">
          <input type="checkbox" name="${spec.key}" value="true" ${on ? 'checked' : ''}>
          <span><strong>${spec.label}</strong>
          ${spec.help ? html`<span>${spec.help}</span>` : ''}</span>
        </label>`;
    }

    return html`
      <div class="field">
        <label for="${spec.key}">
          ${spec.label}
          ${isSecret(spec.key) && current.hasSecret ? html` <span class="tag tag-ok">vistað</span>` : ''}
          ${envProvided ? html` <span class="tag tag-muted tag-plain">úr umhverfi</span>` : ''}
        </label>
        <input
          id="${spec.key}"
          name="${spec.key}"
          type="${spec.type ?? 'text'}"
          value="${current.value}"
          placeholder="${spec.placeholder ?? ''}"
          autocomplete="off"
          spellcheck="false"
        >
        ${spec.help ? html`<p class="help">${spec.help}</p>` : ''}
        ${isSecret(spec.key) && current.hasSecret
          ? html`<p class="help">Skildu eftir autt til að halda núverandi gildi. Skrifaðu <span class="mono">-</span> til að eyða því.</p>`
          : ''}
      </div>`;
  };

  return html`
    <div class="head">
      <div>
        <h1>Tengingar</h1>
        <p class="sub">
          Fylltu út það sem þú vilt nota. Það sem er óstillt fer í þurrkeyrslu —
          kerfið virkar áfram, en sendir ekkert út.
        </p>
      </div>
    </div>

    <div class="panel" style="margin-bottom:1.4rem">
      <div class="table-wrap"><table>
        <thead><tr><th>Þjónusta</th><th>Staða</th><th>Athugasemd</th></tr></thead>
        <tbody>
          ${specs.map((spec) => {
            const entry = status.get(spec.key);
            return html`
              <tr>
                <td><a href="#${spec.key}"><strong>${spec.title}</strong></a></td>
                <td>${entry?.ready ? statusTag('lokid') : html`<span class="tag tag-warn">Óstillt</span>`}</td>
                <td class="small muted">${entry?.ready ? entry.hint : spec.withoutIt}</td>
              </tr>`;
          })}
        </tbody>
      </table></div>
    </div>

    <form method="post" action="/stillingar/tengingar">
      ${csrfField(session)}

      ${specs.map((spec) => {
        const entry = status.get(spec.key);
        return html`
          <div class="panel" id="${spec.key}" style="margin-bottom:1.1rem">
            <div class="panel-head" style="padding:0 0 1rem;border-bottom:1px solid var(--border-2);margin-bottom:1.2rem">
              <div>
                <h2 style="margin:0">${spec.title}</h2>
                <p class="small muted" style="margin:.3rem 0 0">${spec.purpose}</p>
              </div>
              <div class="split">
                ${entry?.ready ? statusTag('lokid') : html`<span class="tag tag-warn">Óstillt</span>`}
                ${spec.docsUrl
                  ? html`<a class="btn btn-ghost btn-sm" href="${spec.docsUrl}" target="_blank" rel="noopener">${spec.docsLabel ?? 'Opna'} ↗</a>`
                  : ''}
              </div>
            </div>

            <div class="grid grid-2" style="align-items:start">
              <div>
                <h3>Hvernig á að setja þetta upp</h3>
                <ol class="setup-steps">
                  ${spec.steps.map((step) => html`<li>${step}</li>`)}
                </ol>
              </div>

              <div>
                <h3>Gildi</h3>
                ${spec.fields.map(field)}

                ${spec.key === 'email'
                  ? html`
                    <div class="btn-row" style="margin-top:.4rem">
                      <button class="btn btn-ghost btn-sm" type="submit" formaction="/stillingar/profa-post">
                        Senda prófunarpóst
                      </button>
                      <span class="small muted">Vistar fyrst, sendir svo á netfangið þitt.</span>
                    </div>`
                  : ''}
              </div>
            </div>
          </div>`;
      })}

      <div class="btn-row" style="position:sticky;bottom:1rem;background:var(--panel);padding:1rem;border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow-2)">
        <button class="btn btn-primary" type="submit">Vista tengingar</button>
        <span class="small muted">Breytingar taka gildi strax — engin endurræsing.</span>
      </div>
    </form>

    <div class="panel" style="margin-top:1.4rem">
      <h2>Vefkrókar og slóðir</h2>
      <p class="small muted">
        Twilio þarf að ná í þessa vél utan frá. Slóðirnar hér að neðan miðast við
        núverandi <span class="mono">BASE_URL</span>.
      </p>
      <div class="copy mono">${config.baseUrl}</div>
      ${config.baseUrl.includes('localhost')
        ? html`
          <p class="small" style="margin-top:.8rem">
            ${icon('M12 8v5M12 16.5v.5M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z', 15)}
            Þetta er staðbundin slóð. Google-tenging virkar, en Twilio nær ekki í hana —
            notaðu göng (ngrok) og settu þá slóð sem <span class="mono">BASE_URL</span> þegar
            þú vilt prófa símsvörun.
          </p>`
        : ''}
    </div>

    <style>
      .setup-steps{margin:0;padding-left:1.3rem;display:grid;gap:.7rem;color:var(--ink-2);font-size:.92rem;line-height:1.6}
      .setup-steps li{padding-left:.2rem}
      .setup-steps li::marker{color:var(--brand);font-weight:700}
    </style>`;
}

export { SETTING_KEYS, webhookUrls, raw };
