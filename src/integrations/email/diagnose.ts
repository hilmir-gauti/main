/**
 * Turning SMTP failures into instructions.
 *
 * A raw SMTP error is a status code and a sentence written for a mail admin.
 * Nearly every failure a small operator hits is one of a handful of causes,
 * and each has a specific fix — so the error is matched against those and the
 * fix is shown instead of the jargon.
 *
 * The original message is always kept alongside: guesses can be wrong, and
 * the server's own words are what a provider's support will ask for.
 */

export interface Diagnosis {
  /** Short statement of what went wrong. */
  title: string;
  /** What to do about it. */
  advice: string[];
  /** Documentation worth opening. */
  link?: { label: string; url: string };
}

interface Rule {
  match: RegExp;
  /** Narrows a rule to one provider, matched against the host. */
  host?: RegExp;
  diagnosis: Diagnosis;
}

const GMAIL_APP_PASSWORD: Diagnosis = {
  title: 'Gmail hafnaði notandanafni eða lykilorði.',
  advice: [
    'Gmail leyfir ekki venjulegt lykilorð reikningsins fyrir SMTP. Þú þarft sérstakt app-lykilorð.',
    'Kveiktu fyrst á tveggja þátta auðkenningu (2FA) á Google-reikningnum — app-lykilorð eru ekki í boði án hennar.',
    'Farðu svo á myaccount.google.com/apppasswords, búðu til nýtt app-lykilorð og límdu það í lykilorðareitinn hér.',
    'App-lykilorðið er 16 stafir. Bil skipta ekki máli — þú mátt líma það inn eins og Google sýnir það.',
    'Notandanafnið á að vera fullt netfang, t.d. nafn@gmail.com.',
  ],
  link: { label: 'Búa til app-lykilorð', url: 'https://myaccount.google.com/apppasswords' },
};

const RULES: Rule[] = [
  // --- Authentication -----------------------------------------------------
  {
    match: /535|Username and Password not accepted|BadCredentials|5\.7\.8/i,
    host: /gmail|google/i,
    diagnosis: GMAIL_APP_PASSWORD,
  },
  {
    match: /Application-specific password required|5\.7\.9/i,
    diagnosis: GMAIL_APP_PASSWORD,
  },
  {
    match: /535|Authentication (failed|credentials invalid)|Invalid login|authentication failure/i,
    diagnosis: {
      title: 'Þjónninn hafnaði notandanafni eða lykilorði.',
      advice: [
        'Athugaðu hvort notandanafnið eigi að vera fullt netfang eða bara notandahlutinn — það er misjafnt milli þjónustuaðila.',
        'Sumir þjónustuaðilar krefjast sérstaks app-lykilorðs frekar en lykilorðs reikningsins.',
        'Gættu að aukabilum sem gætu hafa fylgt með við afritun.',
      ],
    },
  },
  {
    match: /534|Please log in with your web browser|5\.7\.14/i,
    diagnosis: {
      title: 'Google krefst staðfestingar í vafra.',
      advice: [
        'Skráðu þig inn á reikninginn í vafra og staðfestu innskráninguna.',
        'Ef þetta heldur áfram: notaðu app-lykilorð í stað venjulega lykilorðsins.',
      ],
      link: { label: 'Búa til app-lykilorð', url: 'https://myaccount.google.com/apppasswords' },
    },
  },

  // --- Connectivity -------------------------------------------------------
  {
    match: /ECONNREFUSED/i,
    diagnosis: {
      title: 'Ekkert svaraði á þessu vistfangi og porti.',
      advice: [
        'Athugaðu hvort þjónsheitið sé rétt stafað (t.d. smtp.gmail.com).',
        'Algeng port: 587 fyrir STARTTLS, 465 fyrir TLS strax.',
        'Notirðu Proton Mail Bridge þarf það forrit að vera í gangi — þjónn 127.0.0.1, port 1025.',
      ],
    },
  },
  {
    match: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    diagnosis: {
      title: 'Fann ekki þjóninn í nafnauppflettingu.',
      advice: [
        'Þjónsheitið er líklega rangt stafað.',
        'Athugaðu líka nettenginguna á þessari vél.',
      ],
    },
  },
  {
    match: /ETIMEDOUT|svaraði ekki innan|timeout/i,
    diagnosis: {
      title: 'Þjónninn svaraði ekki í tæka tíð.',
      advice: [
        'Eldveggur eða netkerfi lokar líklega á portið. Mörg heimanet og fyrirtækjanet loka á port 25 og stundum 587.',
        'Prófaðu port 465 í staðinn og hakaðu við „Nota TLS strax“.',
        'Ertu á fyrirtækjaneti gæti þurft að biðja um að opna fyrir útleið á SMTP.',
      ],
    },
  },

  // --- TLS ----------------------------------------------------------------
  {
    match: /býður ekki upp á STARTTLS|STARTTLS mistókst|454/i,
    diagnosis: {
      title: 'Dulkóðun tókst ekki að koma á.',
      advice: [
        'Á porti 587 verður þjónninn að styðja STARTTLS. Styðji hann það ekki, notaðu port 465 og hakaðu við „Nota TLS strax“.',
        'Öfugt gildir líka: sértu á porti 465 án þess að haka við TLS strax mistekst handabandið.',
      ],
    },
  },
  {
    match: /self.signed|SELF_SIGNED_CERT|UNABLE_TO_VERIFY|CERT_HAS_EXPIRED|DEPTH_ZERO/i,
    diagnosis: {
      title: 'Skírteini þjónsins stóðst ekki athugun.',
      advice: [
        'Þetta er eðlilegt á eigin póstþjóni með sjálfgerðu skírteini, en ætti aldrei að gerast hjá Gmail eða Proton.',
        'Gerist þetta hjá stórum þjónustuaðila: athugaðu hvort þjónsheitið sé rétt — rangt heiti gefur skírteini sem passar ekki.',
      ],
    },
  },
  {
    match: /wrong version number|SSL routines|packet length too long/i,
    diagnosis: {
      title: 'Dulkóðunarstillingin passar ekki við portið.',
      advice: [
        'Port 465 vill TLS strax — hakaðu við „Nota TLS strax“.',
        'Port 587 vill STARTTLS — hafðu þann reit ó­hakaðan.',
      ],
    },
  },

  // --- Policy -------------------------------------------------------------
  {
    match: /5\.7\.1|not allowed to send as|Sender address rejected|does not match|550/i,
    diagnosis: {
      title: 'Þjónninn leyfir ekki að senda frá þessu netfangi.',
      advice: [
        'Sendandanetfangið verður yfirleitt að vera sama netfang og þú auðkennir þig með, eða skráð samnefni (alias) á þeim reikningi.',
        'Prófaðu að setja sama netfang í „Notandanafn“ og „Sendandanetfang“.',
      ],
    },
  },
  {
    match: /421|4\.7\.0|too many|rate limit|Try again later/i,
    diagnosis: {
      title: 'Þjónninn takmarkar sendingar í bili.',
      advice: [
        'Bíddu í nokkrar mínútur og reyndu aftur.',
        'Gmail takmarkar bæði fjölda sendinga og fjölda misheppnaðra innskráninga.',
      ],
    },
  },
];

/**
 * Matches an error message against the known causes.
 * Returns null when nothing fits, so the caller shows the raw error alone
 * rather than inventing advice.
 */
export function diagnoseSmtpError(message: string, host = ''): Diagnosis | null {
  if (!message) return null;

  for (const rule of RULES) {
    if (rule.host && !rule.host.test(host)) continue;
    if (rule.match.test(message)) return rule.diagnosis;
  }
  return null;
}

/** Sanity checks on the settings themselves, before any connection is made. */
export function checkSmtpSettings(smtp: {
  host: string;
  port: number;
  user: string;
  fromEmail: string;
  implicitTls: boolean;
}): string[] {
  const warnings: string[] = [];

  if (smtp.port === 465 && !smtp.implicitTls) {
    warnings.push('Port 465 krefst þess að hakað sé við „Nota TLS strax“.');
  }
  if (smtp.port === 587 && smtp.implicitTls) {
    warnings.push('Port 587 notar STARTTLS — taktu hakið af „Nota TLS strax“.');
  }
  if (smtp.port === 25) {
    warnings.push('Port 25 er lokað hjá flestum netveitum. Notaðu 587 eða 465.');
  }
  if (/gmail|google/i.test(smtp.host) && smtp.user && !smtp.user.includes('@')) {
    warnings.push('Gmail vill fullt netfang sem notandanafn, t.d. nafn@gmail.com.');
  }
  if (smtp.fromEmail && smtp.user && smtp.fromEmail !== smtp.user && /gmail|google/i.test(smtp.host)) {
    warnings.push(
      `Sendandanetfangið (${smtp.fromEmail}) er ekki það sama og notandanafnið (${smtp.user}). ` +
      'Gmail hafnar því nema það sé skráð samnefni á reikningnum.',
    );
  }

  return warnings;
}
