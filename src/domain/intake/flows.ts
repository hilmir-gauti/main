/**
 * Per-industry intake flows.
 *
 * These are the questions a customer answers when booking. They are written to
 * mirror the conversation a good receptionist would have: identify the item
 * (car, hair, pipe), find out what the customer wants, and when they cannot
 * name it, help them describe it by symptom instead of jargon.
 *
 * The "I don't know what's wrong" branch is the important one. Most people
 * booking a garage cannot say "the front brake discs are warped" — they can say
 * "the steering wheel shakes when I brake". Turning that into a structured
 * answer is what saves the mechanic a phone call.
 */

import type { IntakeFlow, IntakeOption } from './schema.ts';

/** Reused across trades: how long has this been happening? */
const DURATION_OPTIONS: IntakeOption[] = [
  { value: 'i_dag', label: 'Byrjaði í dag' },
  { value: 'nokkrir_dagar', label: 'Síðustu daga' },
  { value: 'vikur', label: 'Nokkrar vikur' },
  { value: 'manudir', label: 'Mánuðir eða lengur' },
  { value: 'kemur_og_fer', label: 'Kemur og fer' },
];

const ACCESS_OPTIONS: IntakeOption[] = [
  { value: 'eg_verd_heima', label: 'Ég verð heima' },
  { value: 'annar_heima', label: 'Einhver annar hleypir inn' },
  { value: 'lykill', label: 'Lykill er hjá húsverði eða nágranna' },
  { value: 'tharf_ad_semja', label: 'Þarf að semja um aðgang' },
];

// ---------------------------------------------------------------------------
// Bílaverkstæði
// ---------------------------------------------------------------------------

const GARAGE_FLOW: IntakeFlow = {
  industry: 'bilaverkstaedi',
  title: 'Um bílinn og verkið',
  intro: 'Nokkrar spurningar svo við getum áætlað tímann rétt og haft varahluti til.',
  questions: [
    {
      key: 'bilnumer',
      label: 'Bílnúmer',
      type: 'bilnumer',
      required: true,
      placeholder: 'AB123',
      help: 'Við flettum upp bílnum þegar þú mætir.',
    },
    {
      key: 'bill_tegund',
      label: 'Tegund og árgerð',
      type: 'texti',
      placeholder: 't.d. Toyota Yaris 2018',
      help: 'Hjálpar okkur að eiga rétta varahluti til.',
    },
    {
      key: 'thjonusta',
      label: 'Hvaða þjónustu þarftu?',
      type: 'val',
      required: true,
      options: [
        { value: 'olia', label: 'Olíuskipti', serviceHint: 'Smurþjónusta' },
        { value: 'bremsur', label: 'Bremsuskipti (diskar/klossar)', serviceHint: 'Bremsuviðgerð' },
        { value: 'skiptivokvi', label: 'Skipt um sjálfskiptivökva', serviceHint: 'Smurþjónusta', addsMinutes: 30 },
        { value: 'perur', label: 'Peruskipti', serviceHint: 'Bilanagreining' },
        { value: 'thurrkublod', label: 'Skipt um þurrkublöð', serviceHint: 'Bilanagreining' },
        { value: 'dekk', label: 'Dekkjaskipti', serviceHint: 'Dekkjaskipti' },
        { value: 'skodun', label: 'Undirbúningur fyrir skoðun', serviceHint: 'Skoðunarþjónusta' },
        { value: 'annad', label: 'Annað', description: 'Við spyrjum nánar út í það.' },
      ],
    },

    // --- Brakes -------------------------------------------------------------
    {
      key: 'bremsur_hvar',
      label: 'Hvar þarf að skipta?',
      type: 'val',
      required: true,
      showIf: { key: 'thjonusta', equals: 'bremsur' },
      options: [
        { value: 'framan', label: 'Að framan' },
        { value: 'aftan', label: 'Að aftan' },
        { value: 'badir', label: 'Bæði að framan og aftan', addsMinutes: 90 },
        { value: 'veit_ekki', label: 'Veit ekki — skoðið það' },
      ],
    },
    {
      key: 'bremsur_hvad',
      label: 'Hvað á að endurnýja?',
      type: 'fjolval',
      showIf: { key: 'thjonusta', equals: 'bremsur' },
      options: [
        { value: 'klossar', label: 'Bremsuklossar' },
        { value: 'diskar', label: 'Bremsudiskar', addsMinutes: 30 },
        { value: 'vokvi', label: 'Bremsuvökvi', addsMinutes: 20 },
        { value: 'veit_ekki', label: 'Veit ekki — metið það' },
      ],
    },

    // --- Bulbs --------------------------------------------------------------
    {
      key: 'perur_hvar',
      label: 'Hvaða perur eru bilaðar?',
      type: 'fjolval',
      required: true,
      showIf: { key: 'thjonusta', equals: 'perur' },
      options: [
        { value: 'adalljos', label: 'Aðalljós' },
        { value: 'lagljos', label: 'Lágljós' },
        { value: 'stefnuljos', label: 'Stefnuljós' },
        { value: 'bremsuljos', label: 'Bremsuljós' },
        { value: 'afturljos', label: 'Afturljós' },
        { value: 'numersljos', label: 'Númersljós' },
        { value: 'thokuljos', label: 'Þokuljós' },
        { value: 'innanljos', label: 'Ljós inni í bílnum' },
      ],
    },

    // --- Tyres --------------------------------------------------------------
    {
      key: 'dekk_tegund',
      label: 'Hvaða dekk á að setja undir?',
      type: 'val',
      showIf: { key: 'thjonusta', equals: 'dekk' },
      options: [
        { value: 'vetrar', label: 'Vetrardekk' },
        { value: 'sumar', label: 'Sumardekk' },
        { value: 'negld', label: 'Negld vetrardekk' },
        { value: 'ny', label: 'Ný dekk — vantar ráðgjöf', addsMinutes: 15 },
      ],
    },
    {
      key: 'dekk_geymsla',
      label: 'Eru dekkin í geymslu hjá okkur?',
      type: 'ja_nei',
      showIf: { key: 'thjonusta', equals: 'dekk' },
    },

    // --- "Other" branch -----------------------------------------------------
    {
      key: 'veit_vandamal',
      label: 'Veistu hvað er að?',
      type: 'ja_nei',
      required: true,
      showIf: { key: 'thjonusta', equals: 'annad' },
      help: 'Ekkert mál þótt svarið sé nei — við hjálpum þér að lýsa því.',
    },
    {
      key: 'vandamal_lysing',
      label: 'Lýstu vandamálinu með þínum orðum',
      type: 'langur_texti',
      required: true,
      maxLength: 2000,
      showIf: { all: [{ key: 'thjonusta', equals: 'annad' }, { key: 'veit_vandamal', equals: 'ja' }] },
      placeholder: 't.d. „Kúplingin er farin að slá og það heyrist urg þegar ég skipti í annan gír.“',
    },
    {
      key: 'einkenni',
      label: 'Hvaða einkenni tekurðu eftir?',
      type: 'fjolval',
      required: true,
      showIf: { all: [{ key: 'thjonusta', equals: 'annad' }, { key: 'veit_vandamal', equals: 'nei' }] },
      help: 'Veldu allt sem á við.',
      options: [
        { value: 'titringur_styri', label: 'Titringur — í stýri' },
        { value: 'titringur_hjol', label: 'Titringur — í hjólum eða undirvagni' },
        { value: 'titringur_bremsun', label: 'Titringur — þegar ég bremsa' },
        { value: 'hljod_innan', label: 'Hljóð — innan úr farþegarými' },
        { value: 'hljod_vel', label: 'Hljóð — undan vélarhlíf' },
        { value: 'hljod_hjol', label: 'Hljóð — frá hjólunum' },
        { value: 'hljod_bremsur', label: 'Ískur eða urg þegar ég bremsa' },
        { value: 'vidvorunarljos', label: 'Viðvörunarljós í mælaborði' },
        { value: 'erfitt_i_gang', label: 'Bíllinn er tregur í gang' },
        { value: 'kraftleysi', label: 'Kraftleysi, hikst eða ójafn gangur' },
        { value: 'leki', label: 'Leki undan bílnum' },
        { value: 'lykt', label: 'Óvenjuleg lykt' },
        { value: 'reykur', label: 'Reykur úr púströri eða vélarrými' },
        { value: 'ofhitnun', label: 'Bíllinn hitnar of mikið' },
        { value: 'annad_einkenni', label: 'Annað' },
      ],
    },
    {
      key: 'einkenni_hvenaer',
      label: 'Hvenær kemur þetta helst fram?',
      type: 'fjolval',
      showIf: { key: 'einkenni', answered: true },
      options: [
        { value: 'gangsetning', label: 'Við gangsetningu' },
        { value: 'kaldur', label: 'Þegar bíllinn er kaldur' },
        { value: 'a_ferd', label: 'Á ferð' },
        { value: 'hradi', label: 'Á miklum hraða' },
        { value: 'bremsun', label: 'Við hemlun' },
        { value: 'beygjur', label: 'Í beygjum' },
        { value: 'ojofnur', label: 'Á ójöfnum vegi' },
        { value: 'alltaf', label: 'Alltaf' },
      ],
    },
    {
      key: 'vidvorunarljos_hvada',
      label: 'Hvaða viðvörunarljós logar?',
      type: 'fjolval',
      showIf: { key: 'einkenni', oneOf: ['vidvorunarljos'] },
      options: [
        { value: 'vel', label: 'Vélarljós (check engine)' },
        { value: 'olia', label: 'Olíuljós' },
        { value: 'hledsla', label: 'Hleðsluljós (rafgeymir)' },
        { value: 'abs', label: 'ABS' },
        { value: 'bremsur', label: 'Bremsuljós' },
        { value: 'hiti', label: 'Hitaljós' },
        { value: 'dekkjathrystingur', label: 'Dekkjaþrýstingur' },
        { value: 'annad_ljos', label: 'Annað ljós' },
      ],
    },
    {
      key: 'einkenni_annad_lysing',
      label: 'Lýstu einkenninu nánar',
      type: 'langur_texti',
      required: true,
      showIf: { key: 'einkenni', oneOf: ['annad_einkenni'] },
      placeholder: 'Segðu okkur það sem þú tekur eftir — hvenær, hversu oft, hvernig það hljómar.',
    },
    {
      key: 'hversu_lengi',
      label: 'Hversu lengi hefur þetta staðið?',
      type: 'val',
      showIf: { key: 'thjonusta', equals: 'annad' },
      options: DURATION_OPTIONS,
    },
    {
      key: 'akfaer',
      label: 'Er bíllinn ökufær?',
      type: 'ja_nei',
      showIf: { key: 'thjonusta', equals: 'annad' },
      help: 'Ef ekki, þá getum við skipulagt dráttarbíl.',
    },

    // --- Common tail --------------------------------------------------------
    {
      key: 'bilalan',
      label: 'Vantar þig bíl á meðan viðgerð stendur?',
      type: 'ja_nei',
    },
    {
      key: 'athugasemd',
      label: 'Eitthvað fleira sem við ættum að vita?',
      type: 'langur_texti',
      placeholder: 'Valfrjálst',
    },
  ],
};

// ---------------------------------------------------------------------------
// Dekkjaverkstæði
// ---------------------------------------------------------------------------

const TYRE_FLOW: IntakeFlow = {
  industry: 'dekkjaverkstaedi',
  title: 'Um bílinn og dekkin',
  intro: 'Svo við höfum réttan búnað tilbúinn þegar þú kemur.',
  questions: [
    { key: 'bilnumer', label: 'Bílnúmer', type: 'bilnumer', required: true, placeholder: 'AB123' },
    { key: 'bill_tegund', label: 'Tegund og árgerð', type: 'texti', placeholder: 't.d. Kia Sportage 2020' },
    {
      key: 'thjonusta',
      label: 'Hvaða þjónustu þarftu?',
      type: 'val',
      required: true,
      options: [
        { value: 'umfelgun', label: 'Umfelgun (skipt um dekk á felgum)', serviceHint: 'Umfelgun' },
        { value: 'heil_hjol', label: 'Skipt um heil hjól', serviceHint: 'Dekkjaskipti á felgum' },
        { value: 'vidgerd', label: 'Viðgerð á sprungnu dekki', serviceHint: 'Viðgerð á sprungnu dekki' },
        { value: 'geymsla', label: 'Dekkjageymsla', serviceHint: 'Dekkjageymsla' },
        { value: 'ny_dekk', label: 'Kaupa ný dekk', addsMinutes: 20 },
      ],
    },
    {
      key: 'dekk_ars',
      label: 'Hvaða dekk á að setja undir?',
      type: 'val',
      showIf: { key: 'thjonusta', oneOf: ['umfelgun', 'heil_hjol', 'ny_dekk'] },
      options: [
        { value: 'vetrar', label: 'Vetrardekk' },
        { value: 'negld', label: 'Negld vetrardekk' },
        { value: 'sumar', label: 'Sumardekk' },
        { value: 'heilsars', label: 'Heilsársdekk' },
      ],
    },
    {
      key: 'dekkjastaerd',
      label: 'Dekkjastærð',
      type: 'texti',
      placeholder: 't.d. 205/55 R16',
      help: 'Stendur á hlið dekksins. Ekki nauðsynlegt — við finnum það annars.',
    },
    {
      key: 'fjoldi',
      label: 'Hversu mörg dekk?',
      type: 'val',
      options: [
        { value: '1', label: '1 dekk' },
        { value: '2', label: '2 dekk' },
        { value: '4', label: '4 dekk' },
      ],
    },
    {
      key: 'i_geymslu',
      label: 'Eru dekkin í geymslu hjá okkur?',
      type: 'ja_nei',
      showIf: { key: 'thjonusta', oneOf: ['umfelgun', 'heil_hjol'] },
    },
    { key: 'athugasemd', label: 'Athugasemd', type: 'langur_texti', placeholder: 'Valfrjálst' },
  ],
};

// ---------------------------------------------------------------------------
// Hárgreiðslustofa
// ---------------------------------------------------------------------------

const HAIR_FLOW: IntakeFlow = {
  industry: 'hargreidslustofa',
  title: 'Um tímann þinn',
  intro: 'Svo við tökum frá réttan tíma og höfum réttu vörurnar tilbúnar.',
  questions: [
    {
      key: 'thjonusta',
      label: 'Hvað langar þig að láta gera?',
      type: 'val',
      required: true,
      options: [
        { value: 'klipping', label: 'Klipping', serviceHint: 'Klipping' },
        { value: 'litun', label: 'Litun', serviceHint: 'Litun' },
        { value: 'stripur', label: 'Strípur eða balayage', serviceHint: 'Strípur' },
        { value: 'klipping_litun', label: 'Klipping og litun', serviceHint: 'Litun', addsMinutes: 45 },
        { value: 'blastur', label: 'Blástur eða uppsetning', serviceHint: 'Blástur og uppsetning' },
        { value: 'permanent', label: 'Permanent', serviceHint: 'Permanent' },
        { value: 'annad', label: 'Annað' },
      ],
    },
    {
      key: 'annad_lysing',
      label: 'Hvað hefurðu í huga?',
      type: 'langur_texti',
      required: true,
      showIf: { key: 'thjonusta', equals: 'annad' },
    },
    {
      key: 'har_sidd',
      label: 'Hversu sítt er hárið?',
      type: 'val',
      required: true,
      options: [
        { value: 'stutt', label: 'Stutt (ofan við eyru)' },
        { value: 'medal', label: 'Axlarsítt' },
        { value: 'sitt', label: 'Sítt (niður á herðablöð)', addsMinutes: 20 },
        { value: 'mjog_sitt', label: 'Mjög sítt (niður fyrir mitti)', addsMinutes: 40 },
      ],
    },
    {
      key: 'har_thykkt',
      label: 'Hárþykkt',
      type: 'val',
      options: [
        { value: 'fint', label: 'Fínt' },
        { value: 'medal', label: 'Meðal' },
        { value: 'thykkt', label: 'Þykkt', addsMinutes: 15 },
      ],
    },
    {
      key: 'litun_tegund',
      label: 'Hvers konar litun?',
      type: 'val',
      required: true,
      showIf: { key: 'thjonusta', oneOf: ['litun', 'stripur', 'klipping_litun'] },
      options: [
        { value: 'heillitun', label: 'Heillitun' },
        { value: 'rotarlitun', label: 'Rótarlitun' },
        { value: 'ljosar_stripur', label: 'Ljósar strípur', addsMinutes: 30 },
        { value: 'dokkar_stripur', label: 'Dökkar strípur' },
        { value: 'balayage', label: 'Balayage', addsMinutes: 45 },
        { value: 'toning', label: 'Tónun' },
      ],
    },
    {
      key: 'litad_adur',
      label: 'Hefur hárið verið litað áður?',
      type: 'ja_nei',
      required: true,
      showIf: { key: 'thjonusta', oneOf: ['litun', 'stripur', 'klipping_litun'] },
      help: 'Skiptir máli fyrir hvernig nýi liturinn kemur út.',
    },
    {
      key: 'nuverandi_litur',
      label: 'Hvaða litur er í hárinu núna?',
      type: 'texti',
      showIf: { key: 'litad_adur', equals: 'ja' },
      placeholder: 't.d. „ljóst með dökkri rót“ eða „rautt frá því í fyrra“',
    },
    {
      key: 'heimalitun',
      label: 'Hefurðu litað hárið heima síðustu 6 mánuði?',
      type: 'ja_nei',
      showIf: { key: 'litad_adur', equals: 'ja' },
      help: 'Heimalitur getur haft áhrif á niðurstöðuna — gott að vita fyrirfram.',
    },
    {
      key: 'oskalitur',
      label: 'Hvaða lit langar þig í?',
      type: 'texti',
      showIf: { key: 'thjonusta', oneOf: ['litun', 'stripur', 'klipping_litun'] },
      placeholder: 't.d. „öskuljóst“ eða „hlýtt súkkulaðibrúnt“',
    },
    {
      key: 'mynd_til',
      label: 'Ertu með viðmiðunarmynd?',
      type: 'ja_nei',
      showIf: { key: 'thjonusta', oneOf: ['klipping', 'litun', 'stripur', 'klipping_litun', 'blastur'] },
    },
    {
      key: 'mynd',
      label: 'Slóð á myndina',
      type: 'mynd',
      showIf: { key: 'mynd_til', equals: 'ja' },
      placeholder: 'https://…',
      help: 'Límdu inn slóð af Instagram eða Pinterest.',
    },
    {
      key: 'utlit_lysing',
      label: 'Lýstu því sem þig langar í',
      type: 'langur_texti',
      showIf: { key: 'mynd_til', equals: 'nei' },
      placeholder: 't.d. „mýkri línur, sítt að framan, meiri áferð“',
      aiSuggest: { fromKey: 'utlit_lysing', subject: 'hárútlit' },
    },
    {
      key: 'ofnaemi',
      label: 'Ertu með þekkt ofnæmi fyrir hárvörum eða litum?',
      type: 'ja_nei',
      showIf: { key: 'thjonusta', oneOf: ['litun', 'stripur', 'klipping_litun', 'permanent'] },
    },
    {
      key: 'ofnaemi_lysing',
      label: 'Hverju ertu með ofnæmi fyrir?',
      type: 'texti',
      required: true,
      showIf: { key: 'ofnaemi', equals: 'ja' },
    },
    { key: 'athugasemd', label: 'Athugasemd', type: 'langur_texti', placeholder: 'Valfrjálst' },
  ],
};

// ---------------------------------------------------------------------------
// Naglastofa
// ---------------------------------------------------------------------------

const NAILS_FLOW: IntakeFlow = {
  industry: 'naglastofa',
  title: 'Um neglurnar',
  intro: 'Nokkrar spurningar svo við tökum frá réttan tíma og höfum réttu litina til.',
  questions: [
    {
      key: 'thjonusta',
      label: 'Hvaða þjónustu viltu?',
      type: 'val',
      required: true,
      options: [
        { value: 'nyjar', label: 'Nýjar neglur (ásetning)', serviceHint: 'Gel-neglur' },
        { value: 'afylling', label: 'Áfylling', serviceHint: 'Gel-neglur' },
        { value: 'gelalakk', label: 'Gelalakk á eigin neglur', serviceHint: 'Handsnyrting' },
        { value: 'handsnyrting', label: 'Handsnyrting', serviceHint: 'Handsnyrting' },
        { value: 'fotsnyrting', label: 'Fótsnyrting', serviceHint: 'Handsnyrting', addsMinutes: 15 },
        { value: 'urtekt', label: 'Úrtekt (fjarlægja gamlar neglur)', addsMinutes: 20 },
        { value: 'vidgerd', label: 'Viðgerð á brotinni nögl' },
        { value: 'annad', label: 'Annað' },
      ],
    },
    {
      key: 'annad_lysing',
      label: 'Hvað hefurðu í huga?',
      type: 'langur_texti',
      required: true,
      showIf: { key: 'thjonusta', equals: 'annad' },
    },
    {
      key: 'tegund',
      label: 'Hvers konar neglur viltu?',
      type: 'val',
      required: true,
      showIf: { key: 'thjonusta', oneOf: ['nyjar', 'afylling'] },
      options: [
        { value: 'akryl', label: 'Akrýl', description: 'Sterkari, gott fyrir lengingu.' },
        { value: 'gel', label: 'Gel', description: 'Náttúrulegra útlit og sveigjanlegra.' },
        { value: 'dyft', label: 'Dýfðar (dip powder)' },
        { value: 'natturulegar', label: 'Á eigin neglur' },
        { value: 'veit_ekki', label: 'Veit ekki — mig vantar ráðgjöf' },
      ],
    },
    {
      key: 'lengd',
      label: 'Hversu langar?',
      type: 'val',
      showIf: { key: 'thjonusta', oneOf: ['nyjar', 'afylling'] },
      options: [
        { value: 'stuttar', label: 'Stuttar' },
        { value: 'midlungs', label: 'Miðlungs' },
        { value: 'langar', label: 'Langar', addsMinutes: 15 },
      ],
    },
    {
      key: 'form',
      label: 'Hvaða form?',
      type: 'val',
      showIf: { key: 'thjonusta', oneOf: ['nyjar', 'afylling'] },
      options: [
        { value: 'ferkantadar', label: 'Ferkantaðar' },
        { value: 'sporoskju', label: 'Sporöskjulaga' },
        { value: 'mondlu', label: 'Möndlulaga' },
        { value: 'coffin', label: 'Coffin / ballerina' },
        { value: 'stiletto', label: 'Stiletto', addsMinutes: 10 },
        { value: 'veit_ekki', label: 'Veit ekki — ráðleggið mér' },
      ],
    },
    {
      key: 'skraut',
      label: 'Viltu skraut eða mynstur?',
      type: 'fjolval',
      showIf: { key: 'thjonusta', oneOf: ['nyjar', 'afylling', 'gelalakk'] },
      options: [
        { value: 'ekkert', label: 'Ekkert — bara einn litur' },
        { value: 'franskar', label: 'Franskar' },
        { value: 'glimmer', label: 'Glimmer', addsMinutes: 10 },
        { value: 'steinar', label: 'Steinar', addsMinutes: 15 },
        { value: 'mynstur', label: 'Handmálað mynstur', addsMinutes: 25 },
        { value: 'ombre', label: 'Ombré', addsMinutes: 15 },
        { value: 'krómi', label: 'Króm eða áferð', addsMinutes: 10 },
      ],
    },
    {
      key: 'litur',
      label: 'Hvaða lit hefurðu í huga?',
      type: 'texti',
      showIf: { key: 'thjonusta', oneOf: ['nyjar', 'afylling', 'gelalakk'] },
      placeholder: 't.d. „nude“, „dökkrautt“, „ljósblátt“',
    },
    {
      key: 'mynd_til',
      label: 'Ertu með viðmiðunarmynd?',
      type: 'ja_nei',
      required: true,
      showIf: { key: 'thjonusta', oneOf: ['nyjar', 'afylling', 'gelalakk'] },
    },
    {
      key: 'mynd',
      label: 'Slóð á myndina',
      type: 'mynd',
      showIf: { key: 'mynd_til', equals: 'ja' },
      placeholder: 'https://…',
      help: 'Límdu inn slóð af Instagram eða Pinterest.',
    },
    {
      key: 'utlit_lysing',
      label: 'Lýstu því sem þig langar í',
      type: 'langur_texti',
      required: true,
      showIf: { key: 'mynd_til', equals: 'nei' },
      placeholder: 't.d. „mjúkir haustlitir, mattar, með einni glimmernögl“',
      help: 'Þú getur fengið tillögur út frá lýsingunni.',
      aiSuggest: { fromKey: 'utlit_lysing', subject: 'naglaútlit' },
    },
    {
      key: 'astand',
      label: 'Hvernig eru neglurnar núna?',
      type: 'val',
      showIf: { key: 'thjonusta', oneOf: ['nyjar', 'afylling', 'gelalakk'] },
      options: [
        { value: 'berar', label: 'Berar neglur' },
        { value: 'gamalt_gel', label: 'Gamalt gel eða akrýl á', addsMinutes: 20 },
        { value: 'lakk', label: 'Venjulegt lakk á' },
        { value: 'brotnar', label: 'Brotnar eða skemmdar', addsMinutes: 15 },
      ],
    },
    {
      key: 'ofnaemi',
      label: 'Ertu með þekkt ofnæmi (t.d. akrýl eða lím)?',
      type: 'ja_nei',
    },
    {
      key: 'ofnaemi_lysing',
      label: 'Hverju ertu með ofnæmi fyrir?',
      type: 'texti',
      required: true,
      showIf: { key: 'ofnaemi', equals: 'ja' },
    },
    { key: 'athugasemd', label: 'Athugasemd', type: 'langur_texti', placeholder: 'Valfrjálst' },
  ],
};

// ---------------------------------------------------------------------------
// Snyrtistofa
// ---------------------------------------------------------------------------

const BEAUTY_FLOW: IntakeFlow = {
  industry: 'snyrtistofa',
  title: 'Um meðferðina',
  intro: 'Svo meðferðin passi húðinni þinni.',
  questions: [
    {
      key: 'thjonusta',
      label: 'Hvaða meðferð viltu?',
      type: 'val',
      required: true,
      options: [
        { value: 'andlitsbad', label: 'Andlitsbað', serviceHint: 'Andlitsbað' },
        { value: 'hudgreining', label: 'Húðgreining og ráðgjöf', serviceHint: 'Húðgreining' },
        { value: 'vax', label: 'Vaxmeðferð', serviceHint: 'Vaxmeðferð' },
        { value: 'brunir', label: 'Augnabrúnir eða augnhár', serviceHint: 'Augnabrúnir' },
        { value: 'handsnyrting', label: 'Hand- eða fótsnyrting', serviceHint: 'Handsnyrting' },
        { value: 'annad', label: 'Annað' },
      ],
    },
    {
      key: 'annad_lysing',
      label: 'Hvað hefurðu í huga?',
      type: 'langur_texti',
      required: true,
      showIf: { key: 'thjonusta', equals: 'annad' },
    },
    {
      key: 'vax_svaedi',
      label: 'Hvaða svæði?',
      type: 'fjolval',
      required: true,
      showIf: { key: 'thjonusta', equals: 'vax' },
      options: [
        { value: 'fotleggir_heilir', label: 'Heilir fótleggir' },
        { value: 'fotleggir_halfir', label: 'Hálfir fótleggir' },
        { value: 'handleggir', label: 'Handleggir' },
        { value: 'bikini', label: 'Bikinílína' },
        { value: 'andlit', label: 'Andlit' },
        { value: 'bak', label: 'Bak' },
      ],
    },
    {
      key: 'hudgerd',
      label: 'Hvernig myndirðu lýsa húðinni þinni?',
      type: 'val',
      showIf: { key: 'thjonusta', oneOf: ['andlitsbad', 'hudgreining'] },
      options: [
        { value: 'thurr', label: 'Þurr' },
        { value: 'feit', label: 'Feit' },
        { value: 'blondud', label: 'Blönduð' },
        { value: 'vidkvaem', label: 'Viðkvæm' },
        { value: 'normal', label: 'Venjuleg' },
        { value: 'veit_ekki', label: 'Veit ekki' },
      ],
    },
    {
      key: 'hudvandamal',
      label: 'Er eitthvað sérstakt sem þú vilt vinna með?',
      type: 'fjolval',
      showIf: { key: 'thjonusta', oneOf: ['andlitsbad', 'hudgreining'] },
      options: [
        { value: 'bolur', label: 'Bólur eða óhreinindi' },
        { value: 'rodi', label: 'Roði' },
        { value: 'thurrkur', label: 'Þurrkur' },
        { value: 'oldrun', label: 'Öldrunarmerki' },
        { value: 'litamunur', label: 'Ójafn húðlitur' },
        { value: 'ekkert', label: 'Ekkert sérstakt' },
      ],
    },
    {
      key: 'ofnaemi',
      label: 'Ertu með þekkt ofnæmi eða húðsjúkdóm?',
      type: 'ja_nei',
      required: true,
    },
    {
      key: 'ofnaemi_lysing',
      label: 'Segðu okkur nánar',
      type: 'texti',
      required: true,
      showIf: { key: 'ofnaemi', equals: 'ja' },
    },
    {
      key: 'lyf',
      label: 'Notarðu húðlyf (t.d. retínól eða sýrur)?',
      type: 'ja_nei',
      showIf: { key: 'thjonusta', oneOf: ['andlitsbad', 'vax'] },
      help: 'Sum lyf gera húðina viðkvæmari fyrir meðferð.',
    },
    { key: 'athugasemd', label: 'Athugasemd', type: 'langur_texti', placeholder: 'Valfrjálst' },
  ],
};

// ---------------------------------------------------------------------------
// Pípulagnir
// ---------------------------------------------------------------------------

const PLUMBER_FLOW: IntakeFlow = {
  industry: 'pipulagnir',
  title: 'Um verkið',
  intro: 'Svo við mætum með réttu verkfærin og efnið.',
  questions: [
    {
      key: 'bradatilfelli',
      label: 'Er vatnsleki í gangi núna?',
      type: 'ja_nei',
      required: true,
      help: 'Ef já, hringdu líka — við forgangsröðum bráðatilfellum.',
    },
    {
      key: 'vatn_lokad',
      label: 'Hefurðu lokað fyrir vatnið?',
      type: 'ja_nei',
      showIf: { key: 'bradatilfelli', equals: 'ja' },
      help: 'Inntakskraninn er yfirleitt í þvottahúsi eða inntaksrými.',
    },
    {
      key: 'husnaedi',
      label: 'Hvers konar húsnæði?',
      type: 'val',
      required: true,
      options: [
        { value: 'ibud', label: 'Íbúð í fjölbýli' },
        { value: 'einbyli', label: 'Einbýli eða raðhús' },
        { value: 'fyrirtaeki', label: 'Atvinnuhúsnæði' },
        { value: 'sumarhus', label: 'Sumarhús' },
      ],
    },
    {
      key: 'veit_vandamal',
      label: 'Veistu hvað er að?',
      type: 'ja_nei',
      required: true,
      help: 'Ekkert mál þótt svarið sé nei — við hjálpum þér að lýsa því.',
    },
    {
      key: 'vandamal_lysing',
      label: 'Lýstu verkinu með þínum orðum',
      type: 'langur_texti',
      required: true,
      showIf: { key: 'veit_vandamal', equals: 'ja' },
      placeholder: 't.d. „Það þarf að skipta um blöndunartæki í eldhúsi, gamla er farin að leka.“',
    },
    {
      key: 'einkenni',
      label: 'Hvað tekurðu eftir?',
      type: 'fjolval',
      required: true,
      showIf: { key: 'veit_vandamal', equals: 'nei' },
      options: [
        { value: 'leki_vaskur', label: 'Leki undir vaski' },
        { value: 'leki_veggur', label: 'Leki í vegg eða lofti' },
        { value: 'leki_krani', label: 'Krani lekur eða dropar' },
        { value: 'leki_klosett', label: 'Klósett lekur eða rennur stöðugt' },
        { value: 'stifla_nidurfall', label: 'Stífla í niðurfalli' },
        { value: 'stifla_klosett', label: 'Klósett stíflað' },
        { value: 'hagt_ad_renna', label: 'Vatn rennur hægt niður' },
        { value: 'ekkert_heitt', label: 'Ekkert heitt vatn' },
        { value: 'lagur_thrystingur', label: 'Lágur vatnsþrýstingur' },
        { value: 'ofn_kaldur', label: 'Ofn hitnar ekki' },
        { value: 'hljod_lagnir', label: 'Hljóð eða högg í lögnum' },
        { value: 'lykt', label: 'Skólplykt' },
        { value: 'raki', label: 'Raki eða mygla' },
        { value: 'annad_einkenni', label: 'Annað' },
      ],
    },
    {
      key: 'einkenni_annad_lysing',
      label: 'Lýstu því nánar',
      type: 'langur_texti',
      required: true,
      showIf: { key: 'einkenni', oneOf: ['annad_einkenni'] },
    },
    {
      key: 'hvar',
      label: 'Hvar er vandamálið?',
      type: 'fjolval',
      required: true,
      options: [
        { value: 'eldhus', label: 'Eldhús' },
        { value: 'badherbergi', label: 'Baðherbergi' },
        { value: 'gestasalerni', label: 'Gestasalerni' },
        { value: 'thvottahus', label: 'Þvottahús' },
        { value: 'kjallari', label: 'Kjallari' },
        { value: 'uti', label: 'Utandyra' },
        { value: 'vitad_ekki', label: 'Veit ekki hvaðan það kemur' },
      ],
    },
    {
      key: 'hversu_lengi',
      label: 'Hversu lengi hefur þetta staðið?',
      type: 'val',
      options: DURATION_OPTIONS,
    },
    {
      key: 'adgangur',
      label: 'Hvernig komumst við inn?',
      type: 'val',
      required: true,
      options: ACCESS_OPTIONS,
    },
    {
      key: 'bilastaedi',
      label: 'Er bílastæði við húsið?',
      type: 'ja_nei',
      help: 'Við komum með verkfæri og efni í bílnum.',
    },
    { key: 'athugasemd', label: 'Athugasemd', type: 'langur_texti', placeholder: 'Valfrjálst' },
  ],
};

// ---------------------------------------------------------------------------
// Rafvirkjun
// ---------------------------------------------------------------------------

const ELECTRICIAN_FLOW: IntakeFlow = {
  industry: 'rafvirki',
  title: 'Um verkið',
  intro: 'Svo við mætum með réttan búnað.',
  questions: [
    {
      key: 'oryggi',
      label: 'Finnurðu brunalykt eða sérðu neista?',
      type: 'ja_nei',
      required: true,
      help: 'Ef já: sláðu út aðalrofa og hringdu strax. Þetta er ekki hægt að bóka í biðröð.',
    },
    {
      key: 'verk',
      label: 'Hvað þarftu að láta gera?',
      type: 'val',
      required: true,
      options: [
        { value: 'bilun', label: 'Bilanaleit — eitthvað virkar ekki', serviceHint: 'Útkall og bilanaleit' },
        { value: 'hledslustod', label: 'Uppsetning hleðslustöðvar', serviceHint: 'Uppsetning hleðslustöðvar' },
        { value: 'ljos', label: 'Uppsetning ljósa eða rofa', serviceHint: 'Ljósauppsetning' },
        { value: 'tafla', label: 'Töfluskipti', serviceHint: 'Töfluskipti' },
        { value: 'uttekt', label: 'Rafmagnsúttekt', serviceHint: 'Rafmagnsúttekt' },
        { value: 'annad', label: 'Annað' },
      ],
    },
    {
      key: 'annad_lysing',
      label: 'Lýstu verkinu',
      type: 'langur_texti',
      required: true,
      showIf: { key: 'verk', equals: 'annad' },
    },
    {
      key: 'veit_vandamal',
      label: 'Veistu hvað veldur biluninni?',
      type: 'ja_nei',
      required: true,
      showIf: { key: 'verk', equals: 'bilun' },
    },
    {
      key: 'bilun_lysing',
      label: 'Lýstu biluninni',
      type: 'langur_texti',
      required: true,
      showIf: { all: [{ key: 'verk', equals: 'bilun' }, { key: 'veit_vandamal', equals: 'ja' }] },
    },
    {
      key: 'einkenni',
      label: 'Hvað tekurðu eftir?',
      type: 'fjolval',
      required: true,
      showIf: { all: [{ key: 'verk', equals: 'bilun' }, { key: 'veit_vandamal', equals: 'nei' }] },
      options: [
        { value: 'oryggi_slaer', label: 'Öryggi slær út' },
        { value: 'ekkert_rafmagn', label: 'Ekkert rafmagn í hluta húss' },
        { value: 'blikkandi', label: 'Ljós blikka eða dofna' },
        { value: 'innstunga', label: 'Innstunga virkar ekki' },
        { value: 'rofi', label: 'Rofi virkar ekki' },
        { value: 'hiti', label: 'Innstunga eða rofi hitnar' },
        { value: 'stud', label: 'Ég fæ smá stuð við snertingu' },
        { value: 'taeki', label: 'Ákveðið tæki virkar ekki' },
        { value: 'annad_einkenni', label: 'Annað' },
      ],
    },
    {
      key: 'einkenni_annad_lysing',
      label: 'Lýstu því nánar',
      type: 'langur_texti',
      required: true,
      showIf: { key: 'einkenni', oneOf: ['annad_einkenni'] },
    },
    {
      key: 'hledslustod_tegund',
      label: 'Ertu þegar með hleðslustöð eða þarf að kaupa hana?',
      type: 'val',
      showIf: { key: 'verk', equals: 'hledslustod' },
      options: [
        { value: 'a_stodina', label: 'Ég á stöðina' },
        { value: 'vantar', label: 'Mig vantar stöð og ráðgjöf', addsMinutes: 30 },
      ],
    },
    {
      key: 'fjarlaegd_tafla',
      label: 'Hversu langt er frá rafmagnstöflu að hleðslustað?',
      type: 'val',
      showIf: { key: 'verk', equals: 'hledslustod' },
      options: [
        { value: 'stutt', label: 'Innan við 5 metrar' },
        { value: 'medal', label: '5–15 metrar', addsMinutes: 30 },
        { value: 'langt', label: 'Meira en 15 metrar', addsMinutes: 60 },
        { value: 'veit_ekki', label: 'Veit ekki' },
      ],
    },
    {
      key: 'husnaedi',
      label: 'Hvers konar húsnæði?',
      type: 'val',
      required: true,
      options: [
        { value: 'ibud', label: 'Íbúð í fjölbýli' },
        { value: 'einbyli', label: 'Einbýli eða raðhús' },
        { value: 'fyrirtaeki', label: 'Atvinnuhúsnæði' },
        { value: 'sumarhus', label: 'Sumarhús' },
      ],
    },
    {
      key: 'byggingarar',
      label: 'Hvenær var húsið byggt?',
      type: 'val',
      options: [
        { value: 'fyrir_1970', label: 'Fyrir 1970' },
        { value: '1970_2000', label: '1970–2000' },
        { value: 'eftir_2000', label: 'Eftir 2000' },
        { value: 'veit_ekki', label: 'Veit ekki' },
      ],
      help: 'Eldri raflagnir kalla stundum á meiri vinnu.',
    },
    { key: 'adgangur', label: 'Hvernig komumst við inn?', type: 'val', required: true, options: ACCESS_OPTIONS },
    { key: 'athugasemd', label: 'Athugasemd', type: 'langur_texti', placeholder: 'Valfrjálst' },
  ],
};

// ---------------------------------------------------------------------------
// Sjúkraþjálfun
// ---------------------------------------------------------------------------

const PHYSIO_FLOW: IntakeFlow = {
  industry: 'sjukrathjalfun',
  title: 'Um komuna',
  intro: 'Þetta hjálpar okkur að undirbúa fyrsta tímann. Farið er með allar upplýsingar sem trúnaðarmál.',
  questions: [
    {
      key: 'fyrsta_koma',
      label: 'Er þetta fyrsta koman þín til okkar?',
      type: 'ja_nei',
      required: true,
      options: undefined,
    },
    {
      key: 'tilvisun',
      label: 'Ertu með tilvísun frá lækni?',
      type: 'ja_nei',
      showIf: { key: 'fyrsta_koma', equals: 'ja' },
    },
    {
      key: 'svaedi',
      label: 'Hvar finnurðu til?',
      type: 'fjolval',
      required: true,
      options: [
        { value: 'hals', label: 'Háls' },
        { value: 'herdar', label: 'Herðar' },
        { value: 'oxl', label: 'Öxl' },
        { value: 'efra_bak', label: 'Efra bak' },
        { value: 'nedra_bak', label: 'Neðra bak' },
        { value: 'mjadmir', label: 'Mjaðmir' },
        { value: 'laeri', label: 'Læri' },
        { value: 'hne', label: 'Hné' },
        { value: 'kalfi', label: 'Kálfi' },
        { value: 'okkli', label: 'Ökkli eða fótur' },
        { value: 'olnbogi', label: 'Olnbogi' },
        { value: 'ulnlidur', label: 'Úlnliður eða hönd' },
      ],
    },
    {
      key: 'verkur',
      label: 'Hversu mikill er verkurinn að jafnaði?',
      type: 'val',
      required: true,
      options: [
        { value: 'vaegur', label: 'Vægur — truflar lítið' },
        { value: 'medal', label: 'Miðlungs — truflar daglegt líf' },
        { value: 'mikill', label: 'Mikill — takmarkar mig verulega' },
        { value: 'breytilegur', label: 'Mjög breytilegur' },
      ],
    },
    {
      key: 'hvenaer_byrjadi',
      label: 'Hvenær byrjaði þetta?',
      type: 'val',
      required: true,
      options: DURATION_OPTIONS,
    },
    {
      key: 'orsok',
      label: 'Veistu hvað olli þessu?',
      type: 'val',
      required: true,
      options: [
        { value: 'ithrottameidsl', label: 'Íþróttameiðsl' },
        { value: 'vinnuslys', label: 'Vinnuslys' },
        { value: 'bilslys', label: 'Bílslys' },
        { value: 'adgerd', label: 'Eftir aðgerð' },
        { value: 'smam_saman', label: 'Kom smám saman' },
        { value: 'veit_ekki', label: 'Veit ekki' },
      ],
    },
    {
      key: 'adgerd_lysing',
      label: 'Hvaða aðgerð og hvenær?',
      type: 'texti',
      required: true,
      showIf: { key: 'orsok', equals: 'adgerd' },
    },
    {
      key: 'versnar',
      label: 'Hvað gerir verkinn verri?',
      type: 'fjolval',
      options: [
        { value: 'kyrrseta', label: 'Kyrrseta' },
        { value: 'ganga', label: 'Ganga' },
        { value: 'lyfta', label: 'Lyfta' },
        { value: 'ithrottir', label: 'Íþróttir' },
        { value: 'morgnar', label: 'Á morgnana' },
        { value: 'kvold', label: 'Á kvöldin' },
        { value: 'svefn', label: 'Truflar svefn' },
      ],
    },
    {
      key: 'markmid',
      label: 'Hvað viltu geta gert aftur?',
      type: 'langur_texti',
      placeholder: 't.d. „hlaupið 5 km án verkja“ eða „lyft barninu mínu“',
      help: 'Við setjum meðferðaráætlunina upp út frá þessu.',
    },
    { key: 'athugasemd', label: 'Annað sem við ættum að vita', type: 'langur_texti', placeholder: 'Valfrjálst' },
  ],
};

// ---------------------------------------------------------------------------
// Nudd
// ---------------------------------------------------------------------------

const MASSAGE_FLOW: IntakeFlow = {
  industry: 'nudd',
  title: 'Um meðferðina',
  intro: 'Svo meðferðin nýtist þér sem best.',
  questions: [
    {
      key: 'tegund',
      label: 'Hvaða meðferð viltu?',
      type: 'val',
      required: true,
      options: [
        { value: 'klassiskt', label: 'Klassískt nudd', serviceHint: 'Klassískt nudd' },
        { value: 'djupvodva', label: 'Djúpvöðvanudd', serviceHint: 'Djúpvöðvanudd' },
        { value: 'bak_herdar', label: 'Bak og herðar', serviceHint: 'Bak og herðar' },
        { value: 'slokun', label: 'Slökunarnudd', serviceHint: 'Klassískt nudd' },
      ],
    },
    {
      key: 'svaedi',
      label: 'Hvaða svæði viltu að við einbeitum okkur að?',
      type: 'fjolval',
      required: true,
      options: [
        { value: 'hals_herdar', label: 'Háls og herðar' },
        { value: 'efra_bak', label: 'Efra bak' },
        { value: 'nedra_bak', label: 'Neðra bak' },
        { value: 'faetur', label: 'Fætur' },
        { value: 'handleggir', label: 'Handleggir' },
        { value: 'allt', label: 'Allur líkaminn' },
      ],
    },
    {
      key: 'thrystingur',
      label: 'Hversu fast viltu láta nudda?',
      type: 'val',
      required: true,
      options: [
        { value: 'mjukt', label: 'Mjúkt' },
        { value: 'medal', label: 'Miðlungs' },
        { value: 'fast', label: 'Fast' },
        { value: 'raedum', label: 'Ræðum það á staðnum' },
      ],
    },
    {
      key: 'medganga',
      label: 'Ertu ólétt?',
      type: 'ja_nei',
      help: 'Við notum aðra tækni og aðrar stellingar á meðgöngu.',
    },
    {
      key: 'heilsufar',
      label: 'Er eitthvað sem við þurfum að taka tillit til?',
      type: 'fjolval',
      options: [
        { value: 'meidsl', label: 'Nýleg meiðsl' },
        { value: 'adgerd', label: 'Nýleg aðgerð' },
        { value: 'hattbl', label: 'Háþrýstingur' },
        { value: 'ofnaemi_oliur', label: 'Ofnæmi fyrir olíum' },
        { value: 'hudvandamal', label: 'Húðvandamál' },
        { value: 'ekkert', label: 'Ekkert af þessu' },
      ],
    },
    {
      key: 'heilsufar_lysing',
      label: 'Segðu okkur nánar',
      type: 'langur_texti',
      required: true,
      showIf: { key: 'heilsufar', oneOf: ['meidsl', 'adgerd', 'hattbl', 'ofnaemi_oliur', 'hudvandamal'] },
    },
    { key: 'athugasemd', label: 'Athugasemd', type: 'langur_texti', placeholder: 'Valfrjálst' },
  ],
};

// ---------------------------------------------------------------------------
// Almennt
// ---------------------------------------------------------------------------

const GENERIC_FLOW: IntakeFlow = {
  industry: 'annad',
  title: 'Um erindið',
  intro: 'Segðu okkur aðeins frá því sem þig vantar.',
  questions: [
    {
      key: 'erindi',
      label: 'Hvað getum við gert fyrir þig?',
      type: 'langur_texti',
      required: true,
      placeholder: 'Lýstu erindinu stuttlega.',
    },
    {
      key: 'fyrsta_koma',
      label: 'Hefurðu komið til okkar áður?',
      type: 'ja_nei',
    },
    { key: 'athugasemd', label: 'Athugasemd', type: 'langur_texti', placeholder: 'Valfrjálst' },
  ],
};

// ---------------------------------------------------------------------------

const FLOWS: IntakeFlow[] = [
  GARAGE_FLOW,
  TYRE_FLOW,
  HAIR_FLOW,
  NAILS_FLOW,
  BEAUTY_FLOW,
  PLUMBER_FLOW,
  ELECTRICIAN_FLOW,
  PHYSIO_FLOW,
  MASSAGE_FLOW,
  GENERIC_FLOW,
];

const BY_INDUSTRY = new Map(FLOWS.map((flow) => [flow.industry, flow]));

/** The intake flow for an industry, falling back to the generic one. */
export function flowForIndustry(industry: string): IntakeFlow {
  return BY_INDUSTRY.get(industry) ?? GENERIC_FLOW;
}

export function allFlows(): IntakeFlow[] {
  return FLOWS;
}

/** Count of questions, used in the admin console's flow summary. */
export function flowSummary(industry: string): { total: number; conditional: number; required: number } {
  const flow = flowForIndustry(industry);
  return {
    total: flow.questions.length,
    conditional: flow.questions.filter((q) => q.showIf).length,
    required: flow.questions.filter((q) => q.required).length,
  };
}
