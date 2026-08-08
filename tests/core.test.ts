/**
 * Core utility tests: Icelandic validation and formatting, holidays, interval
 * arithmetic, timezone conversion, SMTP message construction and routing.
 *
 * These are the pieces everything else is built on, so they are tested against
 * known-correct values rather than against their own implementation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { easterSunday, firstDayOfSummer, commerceDay, holidayOn, holidaysForYear, isClosedHoliday, upcomingHolidays } from '../src/core/holidays.ts';
import {
  addVsk, canReceiveSms, formatISK, formatKennitala, isValidEmail, joinIs,
  normalizePhone, placeForPostcode, pluralIs, splitVsk, validateKennitala, VSK,
} from '../src/core/iceland.ts';
import { clampAll, intersect, merge, sliceSlots, subtract, totalMs } from '../src/core/intervals.ts';
import {
  addDays, daysBetween, formatDateIs, formatDateTimeIs, formatDurationIs,
  hhmmToMinutes, instantFromWallClock, minutesToHhmm, plainDateOf, weekdayNameIs, weekdayOf,
} from '../src/core/time.ts';
import { escapeHtml, html, raw } from '../src/core/html.ts';
import { looksUnexpanded } from '../src/config.ts';
import { slugify } from '../src/core/ids.ts';
import { buildMessage, encodeHeaderValue } from '../src/integrations/email/smtp.ts';
import { checkSmtpSettings, diagnoseSmtpError } from '../src/integrations/email/diagnose.ts';
import { buildEmailPlan } from '../src/integrations/email/provisioning.ts';
import { classifyIntent } from '../src/integrations/voice/receptionist.ts';
import { VARIANTS, buildPalette, luminance, variantsForIndustry } from '../src/website/theme.ts';

describe('kennitala', () => {
  it('samþykkir gilda kennitölu einstaklings', () => {
    // Checksum computed by hand: weights 3,2,7,6,5,4,3,2.
    const result = validateKennitala('120174-3399');
    assert.equal(result.valid, true);
    assert.equal(result.type, 'einstaklingur');
    assert.equal(result.date, '1974-01-12');
  });

  it('þekkir kennitölu fyrirtækis (dagur + 40)', () => {
    const result = validateKennitala('520175-0599');
    assert.equal(result.valid, true);
    assert.equal(result.type, 'fyrirtaeki');
    assert.equal(result.date, '1975-01-12');
  });

  it('hafnar rangri vartölu', () => {
    // The 9th digit is the check digit; the 10th is the century marker.
    const result = validateKennitala('120174-3389');
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /[Vv]artala/);
  });

  it('hafnar röngum fjölda stafa', () => {
    assert.equal(validateKennitala('12017433').valid, false);
    assert.equal(validateKennitala('').valid, false);
  });

  it('hafnar ógildri dagsetningu', () => {
    // 32nd of a month can never be valid, whatever the checksum says.
    assert.equal(validateKennitala('320174-3399').valid, false);
  });

  it('sniðmátar kennitölu', () => {
    assert.equal(formatKennitala('1201743399'), '120174-3399');
  });
});

describe('símanúmer', () => {
  it('staðlar íslensk númer á ýmsu formi', () => {
    for (const input of ['5551234', '555-1234', '555 1234', '+354 555 1234', '00354 5551234', '3545551234']) {
      const result = normalizePhone(input);
      assert.equal(result.valid, true, `${input} á að vera gilt`);
      assert.equal(result.e164, '+3545551234', `${input} -> E.164`);
      assert.equal(result.display, '555 1234');
    }
  });

  it('greinir farsíma frá heimasíma', () => {
    assert.equal(normalizePhone('6601234').kind, 'farsimi');
    assert.equal(normalizePhone('5551234').kind, 'heimasimi');
    assert.equal(normalizePhone('8001234').kind, 'graennumer');
  });

  it('leyfir aðeins SMS á farsíma', () => {
    assert.equal(canReceiveSms('6601234'), true);
    assert.equal(canReceiveSms('5551234'), false);
  });

  it('hafnar ógildum númerum', () => {
    assert.equal(normalizePhone('123').valid, false);
    assert.equal(normalizePhone('abc').valid, false);
    assert.equal(normalizePhone('').valid, false);
  });

  it('hleypir erlendum númerum í gegn', () => {
    const result = normalizePhone('+4520123456');
    assert.equal(result.valid, true);
    assert.equal(result.kind, 'erlent');
  });
});

describe('peningar og virðisaukaskattur', () => {
  it('sniðmátar krónur með punkti', () => {
    assert.equal(formatISK(12500), '12.500 kr.');
    assert.equal(formatISK(999), '999 kr.');
    assert.equal(formatISK(1234567), '1.234.567 kr.');
    assert.equal(formatISK(0), '0 kr.');
  });

  it('skiptir verði í nettó og vsk', () => {
    const result = splitVsk(12400, VSK.standard);
    assert.equal(result.gross, 12400);
    assert.equal(result.net, 10000);
    assert.equal(result.vsk, 2400);
  });

  it('bætir vsk ofan á nettóverð', () => {
    assert.equal(addVsk(10000, VSK.standard), 12400);
    assert.equal(addVsk(10000, VSK.reduced), 11100);
  });
});

describe('póstnúmer og texti', () => {
  it('flettir upp póstnúmerum', () => {
    assert.equal(placeForPostcode('101'), 'Reykjavík');
    assert.equal(placeForPostcode('600'), 'Akureyri');
    assert.equal(placeForPostcode('900'), 'Vestmannaeyjar');
    assert.equal(placeForPostcode('999'), null);
  });

  it('tengir lista með „og“', () => {
    assert.equal(joinIs(['klipping']), 'klipping');
    assert.equal(joinIs(['klipping', 'litun']), 'klipping og litun');
    assert.equal(joinIs(['a', 'b', 'c']), 'a, b og c');
  });

  it('beygir eftir tölu', () => {
    assert.equal(pluralIs(1, 'bókun', 'bókanir'), '1 bókun');
    assert.equal(pluralIs(2, 'bókun', 'bókanir'), '2 bókanir');
    assert.equal(pluralIs(21, 'bókun', 'bókanir'), '21 bókun');
    assert.equal(pluralIs(11, 'bókun', 'bókanir'), '11 bókanir');
  });

  it('býr til slóðarheiti úr íslenskum nöfnum', () => {
    assert.equal(slugify('Hárgreiðslustofan Ösp'), 'hargreidslustofan-osp');
    assert.equal(slugify('Þórður & Co ehf.'), 'thordur-co-ehf');
    assert.equal(slugify('   '), 'fyrirtaeki');
  });

  it('staðfestir netföng', () => {
    assert.equal(isValidEmail('nafn@example.is'), true);
    assert.equal(isValidEmail('nafn@sub.example.co.uk'), true);
    assert.equal(isValidEmail('nafn@'), false);
    assert.equal(isValidEmail('nafn example.is'), false);
  });
});

describe('frídagar', () => {
  it('reiknar páskadag rétt', () => {
    // Known values.
    assert.equal(easterSunday(2024), '2024-03-31');
    assert.equal(easterSunday(2025), '2025-04-20');
    assert.equal(easterSunday(2026), '2026-04-05');
    assert.equal(easterSunday(2027), '2027-03-28');
  });

  it('finnur sumardaginn fyrsta (fyrsta fimmtudag eftir 18. apríl)', () => {
    for (const year of [2024, 2025, 2026, 2027, 2028]) {
      const date = firstDayOfSummer(year);
      assert.equal(weekdayOf(date), 4, `${date} á að vera fimmtudagur`);
      const day = Number(date.slice(8));
      assert.ok(day >= 19 && day <= 25, `${date} á að vera 19.–25. apríl`);
    }
  });

  it('finnur frídag verslunarmanna (fyrsta mánudag í ágúst)', () => {
    assert.equal(commerceDay(2026), '2026-08-03');
    assert.equal(weekdayOf(commerceDay(2027)), 1);
  });

  it('þekkir fasta frídaga', () => {
    assert.equal(isClosedHoliday('2026-01-01'), true, 'nýársdagur');
    assert.equal(isClosedHoliday('2026-06-17'), true, 'þjóðhátíðardagurinn');
    assert.equal(isClosedHoliday('2026-12-25'), true, 'jóladagur');
    assert.equal(isClosedHoliday('2026-08-06'), false, 'venjulegur fimmtudagur');
  });

  it('merkir aðfangadag og gamlársdag sem hálfa daga', () => {
    assert.equal(holidayOn('2026-12-24')?.kind, 'hálfur');
    assert.equal(holidayOn('2026-12-24')?.closesAtMinute, 720);
    assert.equal(holidayOn('2026-12-31')?.kind, 'hálfur');
    assert.equal(isClosedHoliday('2026-12-24'), false, 'hálfur dagur er ekki lokun');
  });

  it('skilar öllum lögbundnum frídögum ársins', () => {
    const holidays = holidaysForYear(2026).filter((holiday) => holiday.kind === 'frídagur');
    // 14 full public holidays in Iceland.
    assert.equal(holidays.length, 14);
    const names = holidays.map((holiday) => holiday.name);
    assert.ok(names.includes('Skírdagur'));
    assert.ok(names.includes('Föstudagurinn langi'));
    assert.ok(names.includes('Uppstigningardagur'));
    assert.ok(names.includes('Annar í hvítasunnu'));
  });

  it('skilar frídögum framundan', () => {
    const upcoming = upcomingHolidays('2026-12-01', 45);
    assert.ok(upcoming.length >= 3);
    assert.ok(upcoming.every((holiday) => holiday.date >= '2026-12-01'));
  });
});

describe('tímabil (intervals)', () => {
  it('sameinar skarandi og aðliggjandi bil', () => {
    const result = merge([
      { start: 10, end: 20 },
      { start: 15, end: 25 },
      { start: 25, end: 30 },
      { start: 40, end: 50 },
    ]);
    assert.deepEqual(result, [{ start: 10, end: 30 }, { start: 40, end: 50 }]);
  });

  it('hendir tómum bilum', () => {
    assert.deepEqual(merge([{ start: 10, end: 10 }, { start: 20, end: 15 }]), []);
  });

  it('dregur frá upptekinn tíma', () => {
    const result = subtract([{ start: 0, end: 100 }], [{ start: 20, end: 30 }, { start: 60, end: 70 }]);
    assert.deepEqual(result, [
      { start: 0, end: 20 },
      { start: 30, end: 60 },
      { start: 70, end: 100 },
    ]);
  });

  it('skilar engu þegar allt er upptekið', () => {
    assert.deepEqual(subtract([{ start: 0, end: 100 }], [{ start: 0, end: 100 }]), []);
  });

  it('sker saman tvö sett', () => {
    const result = intersect(
      [{ start: 0, end: 50 }, { start: 60, end: 100 }],
      [{ start: 25, end: 75 }],
    );
    assert.deepEqual(result, [{ start: 25, end: 50 }, { start: 60, end: 75 }]);
  });

  it('telur heildartíma án tvítalningar', () => {
    assert.equal(totalMs([{ start: 0, end: 10 }, { start: 5, end: 20 }]), 20);
  });

  it('klippir bil að mörkum', () => {
    const result = clampAll([{ start: 0, end: 100 }, { start: 200, end: 300 }], { start: 50, end: 250 });
    assert.deepEqual(result, [{ start: 50, end: 100 }, { start: 200, end: 250 }]);
  });

  it('sneiðir glugga í tímabil', () => {
    assert.deepEqual(sliceSlots({ start: 0, end: 100 }, 30, 30), [0, 30, 60]);
    assert.deepEqual(sliceSlots({ start: 0, end: 100 }, 60, 30), [0, 30, 40].slice(0, 2));
  });

  it('stillir tímabil af við viðmið', () => {
    // Window starts at 10 but slots should land on multiples of 30 from 0.
    assert.deepEqual(sliceSlots({ start: 10, end: 100 }, 30, 30, 0), [30, 60]);
  });
});

describe('tími og tímabelti', () => {
  it('breytir staðartíma í augnablik og til baka', () => {
    const instant = instantFromWallClock('2026-08-06', hhmmToMinutes('14:30'), 'Atlantic/Reykjavik');
    assert.equal(plainDateOf(instant, 'Atlantic/Reykjavik'), '2026-08-06');
    assert.equal(new Date(instant).toISOString(), '2026-08-06T14:30:00.000Z', 'Ísland er á UTC allt árið');
  });

  it('höndlar tímabelti með sumartíma rétt', () => {
    // Copenhagen is UTC+2 in August.
    const instant = instantFromWallClock('2026-08-06', hhmmToMinutes('14:30'), 'Europe/Copenhagen');
    assert.equal(new Date(instant).toISOString(), '2026-08-06T12:30:00.000Z');

    // …and UTC+1 in January.
    const winter = instantFromWallClock('2026-01-06', hhmmToMinutes('14:30'), 'Europe/Copenhagen');
    assert.equal(new Date(winter).toISOString(), '2026-01-06T13:30:00.000Z');
  });

  it('reiknar vikudaga eftir ISO', () => {
    assert.equal(weekdayOf('2026-08-06'), 4, 'fimmtudagur');
    assert.equal(weekdayOf('2026-08-09'), 7, 'sunnudagur');
    assert.equal(weekdayOf('2026-08-10'), 1, 'mánudagur');
  });

  it('leggur við daga yfir mánaðamót', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2024-02-28', 1), '2024-02-29', 'hlaupár');
    assert.equal(daysBetween('2026-01-01', '2026-12-31'), 364);
  });

  it('sniðmátar tíma á íslensku', () => {
    assert.equal(minutesToHhmm(570), '09:30');
    assert.equal(hhmmToMinutes('09:30'), 570);
    assert.equal(formatDateIs('2026-08-06'), '6. ágúst 2026');
    assert.equal(weekdayNameIs('2026-08-06'), 'fimmtudagur');
    assert.equal(weekdayNameIs('2026-08-06', 'definite'), 'fimmtudaginn');
    assert.equal(formatDurationIs(90), '1 klst. 30 mín.');
    assert.equal(formatDurationIs(45), '45 mín.');
    assert.equal(formatDurationIs(120), '2 klst.');

    const instant = instantFromWallClock('2026-08-06', 870, 'Atlantic/Reykjavik');
    assert.equal(formatDateTimeIs(instant, 'Atlantic/Reykjavik'), 'fimmtudaginn 6. ágúst kl. 14:30');
  });

  it('hafnar ógildum tímum', () => {
    assert.throws(() => hhmmToMinutes('25:00'));
    assert.throws(() => hhmmToMinutes('bull'));
  });
});

describe('HTML-vörn', () => {
  it('sleppir sértáknum sjálfkrafa', () => {
    const output = html`<p>${'<script>alert(1)</script>'}</p>`.value;
    assert.equal(output, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('treystir raw() eingöngu', () => {
    assert.equal(html`${raw('<b>feitt</b>')}`.value, '<b>feitt</b>');
  });

  it('meðhöndlar lista og tóm gildi', () => {
    assert.equal(html`${[1, 2, 3]}`.value, '123');
    assert.equal(html`${null}${undefined}${false}`.value, '');
  });

  it('sleppir gæsalöppum í eigindum', () => {
    assert.equal(escapeHtml('a"b\'c'), 'a&quot;b&#39;c');
  });
});

describe('SMTP-skeytasmíði', () => {
  it('kóðar íslenskar fyrirsagnir samkvæmt RFC 2047', () => {
    assert.equal(encodeHeaderValue('Simple ASCII'), 'Simple ASCII');
    const encoded = encodeHeaderValue('Staðfesting á tíma');
    assert.match(encoded, /^=\?UTF-8\?B\?/);
    assert.equal(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8'), 'Staðfesting á tíma');
  });

  it('smíðar gilt multipart-skeyti', () => {
    const message = buildMessage(
      {
        from: { name: 'Hárstofan Ösp', email: 'bokanir@osp.is' },
        to: [{ name: 'Jón Jónsson', email: 'jon@example.is' }],
        subject: 'Staðfesting á tíma',
        text: 'Halló',
        html: '<p>Halló</p>',
      },
      '<abc@rafraen>',
    );

    assert.match(message, /^From: =\?UTF-8\?B\?/m);
    assert.match(message, /^To: =\?UTF-8\?B\?[^\n]*<jon@example\.is>/m);
    assert.match(message, /^MIME-Version: 1\.0$/m);
    assert.match(message, /Content-Type: multipart\/alternative; boundary="/);
    assert.ok(message.endsWith('\r\n.\r\n'), 'skeyti á að enda á punktalínu');
  });

  it('ver gegn punktalínu í meginmáli', () => {
    const message = buildMessage(
      { from: { email: 'a@b.is' }, to: [{ email: 'c@d.is' }], subject: 'x', text: 'línaí' },
      '<id@x>',
    );
    // The body is base64-encoded, so a bare "." can never terminate DATA early.
    assert.match(message, /Content-Transfer-Encoding: base64/);
  });
});

describe('greining á óútvíkkuðum skeljaskipunum', () => {
  // The exact string Fly.io receives when a Windows shell is handed the bash
  // one-liner from the README. It is 23 characters, so it fails the length
  // check, and the length alone does not explain why.
  const UNEXPANDED = '$(openssl rand -hex 32)';

  it('þekkir bash-skipun sem skelin víkkaði ekki út', () => {
    assert.ok(looksUnexpanded(UNEXPANDED));
    assert.ok(looksUnexpanded('${APP_SECRET}'));
    assert.ok(looksUnexpanded('%APP_SECRET%'));
    assert.ok(looksUnexpanded('`openssl rand -hex 32`'));
  });

  it('kallar ekki alvöru leyndarmál skipun', () => {
    // A real secret is hex or base64; neither carries shell punctuation.
    assert.equal(looksUnexpanded('a3f9c1e07b2d48569af0c3e1b7d29f04'), false);
    assert.equal(looksUnexpanded('kJ8x+Qz/1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123='), false);
  });
});

describe('SMTP-villugreining', () => {
  // The exact wording Gmail returns on a wrong password. This is the failure
  // an operator is overwhelmingly most likely to hit, so it is pinned.
  const GMAIL_535 =
    '[smtp] Auðkenning (PLAIN) mistókst: 535 5.7.8 Username and Password not accepted. ' +
    'Learn more at | 5.7.8  https://support.google.com/mail/?p=BadCredentials';

  it('þekkir að Gmail vill app-lykilorð', () => {
    const diagnosis = diagnoseSmtpError(GMAIL_535, 'smtp.gmail.com');
    assert.ok(diagnosis, 'greining á að finnast');
    assert.match(diagnosis.advice.join(' '), /app-lykilorð/);
    assert.equal(diagnosis.link?.url, 'https://myaccount.google.com/apppasswords');
  });

  it('gefur almennari ráð þegar þjónninn er ekki Gmail', () => {
    const diagnosis = diagnoseSmtpError('[smtp] Auðkenning (LOGIN) mistókst: 535 Invalid login', 'mail.stofan.is');
    assert.ok(diagnosis);
    assert.doesNotMatch(diagnosis.title, /Gmail/);
  });

  it('greinir tengingar- og TLS-villur', () => {
    assert.match(diagnoseSmtpError('connect ECONNREFUSED 127.0.0.1:1025')!.advice.join(' '), /Bridge/);
    assert.match(diagnoseSmtpError('getaddrinfo ENOTFOUND smtp.gmial.com')!.title, /nafnauppflettingu/);
    assert.match(diagnoseSmtpError('wrong version number')!.advice.join(' '), /465/);
  });

  it('skilar null þegar ekkert passar, frekar en að skálda ráð', () => {
    assert.equal(diagnoseSmtpError(''), null);
    assert.equal(diagnoseSmtpError('eitthvað alveg nýtt fór úrskeiðis'), null);
  });

  it('varar við ósamræmi milli ports og TLS-stillingar', () => {
    const base = { host: 'smtp.gmail.com', user: 'a@gmail.com', fromEmail: 'a@gmail.com' };
    assert.match(checkSmtpSettings({ ...base, port: 465, implicitTls: false }).join(' '), /465/);
    assert.match(checkSmtpSettings({ ...base, port: 587, implicitTls: true }).join(' '), /STARTTLS/);
    assert.deepEqual(checkSmtpSettings({ ...base, port: 587, implicitTls: false }), []);
  });

  it('varar við þegar sendandanetfang og notandanafn stangast á hjá Gmail', () => {
    const warnings = checkSmtpSettings({
      host: 'smtp.gmail.com', port: 587, implicitTls: false,
      user: 'rekstur@gmail.com', fromEmail: 'bokanir@stofan.is',
    });
    assert.match(warnings.join(' '), /samnefni/);
  });
});

describe('uppsetning tölvupósts', () => {
  it('býr til réttar Google Workspace færslur', () => {
    const plan = buildEmailPlan('google', 'Stofan.is');
    assert.equal(plan.domain, 'stofan.is');

    const mx = plan.records.find((record) => record.type === 'MX');
    assert.equal(mx?.value, 'smtp.google.com');
    assert.equal(mx?.priority, 1);

    const spf = plan.records.find((record) => record.host === '@' && record.type === 'TXT');
    assert.match(spf?.value ?? '', /^v=spf1 include:_spf\.google\.com ~all$/);

    const dmarc = plan.records.find((record) => record.host === '_dmarc');
    assert.match(dmarc?.value ?? '', /^v=DMARC1/);

    // DKIM cannot be generated by us — it must be marked as provider-supplied.
    const dkim = plan.records.find((record) => record.host === 'google._domainkey');
    assert.equal(dkim?.providerSupplied, true);
    assert.equal(dkim?.value, '');
  });

  it('býr til réttar Proton færslur', () => {
    const plan = buildEmailPlan('proton', 'stofan.is');
    const mxHosts = plan.records.filter((record) => record.type === 'MX').map((record) => record.value);
    assert.deepEqual(mxHosts, ['mail.protonmail.ch', 'mailsec.protonmail.ch']);
    assert.equal(plan.records.filter((record) => record.type === 'CNAME').length, 3, 'þrír DKIM-lyklar');
  });

  it('fjarlægir www og slóðarhluta úr léni', () => {
    assert.equal(buildEmailPlan('google', 'https://www.stofan.is/eitthvad').domain, 'stofan.is');
  });
});

describe('símsvari — greining erinda', () => {
  it('les takkaval', () => {
    assert.equal(classifyIntent('', '1'), 'bokun');
    assert.equal(classifyIntent('', '2'), 'opnunartimi');
    assert.equal(classifyIntent('', '0'), 'starfsmadur');
  });

  it('skilur talað mál', () => {
    assert.equal(classifyIntent('mig langar að bóka tíma', ''), 'bokun');
    assert.equal(classifyIntent('hvenær er opið hjá ykkur', ''), 'opnunartimi');
    assert.equal(classifyIntent('get ég talað við starfsmann', ''), 'starfsmadur');
    assert.equal(classifyIntent('ég þarf að afbóka', ''), 'afbokun');
  });

  it('skilar óljósu þegar ekkert passar', () => {
    assert.equal(classifyIntent('', ''), 'ohljost');
    assert.equal(classifyIntent('bla bla eitthvað allt annað', ''), 'ohljost');
  });

  it('lætur takka ganga fyrir tali', () => {
    assert.equal(classifyIntent('ég vil afbóka', '1'), 'bokun');
  });
});

describe('útlit vefsíðna', () => {
  it('velur læsilegan texta á einkennislit', () => {
    // Dark brand → white text; light brand → dark text.
    assert.equal(buildPalette('#1d4ed8').onBrand, '#ffffff');
    assert.equal(buildPalette('#fde047').onBrand, '#111827', 'gulur bakgrunnur þarf dökkan texta');
  });

  it('reiknar birtu rétt', () => {
    assert.ok(luminance('#ffffff') > 0.9);
    assert.ok(luminance('#000000') < 0.05);
  });

  it('raðar útlitum eftir fagi', () => {
    const forSalon = variantsForIndustry('hargreidslustofa');
    assert.equal(forSalon[0]?.key, 'nutima', 'nútímalegt hentar stofum best');

    const forGarage = variantsForIndustry('bilaverkstaedi');
    assert.equal(forGarage[0]?.key, 'klassiskt');

    const forWorkshop = variantsForIndustry('tresmidi');
    assert.equal(forWorkshop[0]?.key, 'skogur', 'dökka verslunarútlitið hentar smiðju best');

    // Every industry still gets every option — the order is the only thing
    // the trade changes.
    assert.equal(forSalon.length, VARIANTS.length);
  });

  it('fellur aftur á sjálfgefinn lit þegar gildið er ógilt', () => {
    assert.equal(buildPalette('ekki-litur').brand, '#1d4ed8');
  });
});
