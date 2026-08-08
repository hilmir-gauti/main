/**
 * Industry presets.
 *
 * Onboarding asks for a company name and a trade, then everything else has a
 * sensible starting point: a service list with realistic Icelandic durations
 * and prices, opening hours that match how that trade actually works, website
 * copy, and a phone greeting. The operator adjusts rather than authors.
 *
 * Prices are VAT-inclusive ISK, in the range a small Reykjavík business would
 * charge. They are starting points shown in the wizard, always editable.
 */

import { VSK } from '../core/iceland.ts';

export interface PresetService {
  name: string;
  description: string;
  durationMin: number;
  priceIsk: number;
  bufferAfterMin?: number;
  vskRate?: number;
  capacity?: number;
}

export interface PresetHours {
  /** ISO weekday 1–7 → [openMin, closeMin] ranges, or [] for closed. */
  [weekday: number]: Array<[number, number]>;
}

/**
 * A stocked or made-to-order item, for trades that sell objects rather than
 * hours. Only the webstore industries define these.
 */
export interface PresetProduct {
  name: string;
  tagline: string;
  description: string;
  category: string;
  material: string;
  dimensions: string;
  priceIsk: number;
  madeToOrder?: boolean;
  leadTimeDays?: number;
  stock?: number;
}

export interface IndustryPreset {
  key: string;
  label: string;
  /** Plural, for headings: "Verkstæði sem við þjónustum". */
  emoji: string;
  /** Which website template to generate. */
  template: 'stofa' | 'verkstaedi' | 'idnadarmadur' | 'heilsa' | 'smidja' | 'almennt';
  tagline: string;
  about: string;
  /** Words used in the generated website's call-to-action. */
  bookVerb: string;
  /** What an end customer is called in this trade's copy. */
  services: PresetService[];
  /** Starting catalogue for trades that sell objects. Empty for the rest. */
  products?: PresetProduct[];
  hours: PresetHours;
  /** Whether bookings are normally tied to a named person. */
  staffled: boolean;
  defaultStaffTitle: string;
  /** Answering-machine greeting; {name} is replaced with the company name. */
  greeting: string;
  /** Extra onboarding questions worth asking for this trade. */
  questions: Array<{ key: string; label: string; hint: string }>;
}

const h = (open: number, close: number): [number, number] => [open * 60, close * 60];

/** Mon–Fri 09–18, Sat 10–14, closed Sunday. */
const RETAIL_HOURS: PresetHours = {
  1: [h(9, 18)], 2: [h(9, 18)], 3: [h(9, 18)], 4: [h(9, 18)], 5: [h(9, 18)], 6: [h(10, 14)], 7: [],
};

/** Mon–Fri 08–17 with a lunch break; weekends closed. */
const TRADE_HOURS: PresetHours = {
  1: [h(8, 12), h(13, 17)], 2: [h(8, 12), h(13, 17)], 3: [h(8, 12), h(13, 17)],
  4: [h(8, 12), h(13, 17)], 5: [h(8, 12), h(13, 16)], 6: [], 7: [],
};

export const INDUSTRIES: IndustryPreset[] = [
  {
    key: 'hargreidslustofa',
    label: 'Hárgreiðslustofa',
    emoji: '💇',
    template: 'stofa',
    tagline: 'Klipping og litun í hjarta bæjarins',
    about:
      'Við leggjum metnað í persónulega þjónustu og vandaða vinnu. Hjá okkur færðu ráðgjöf um hárgerð og útlit sem hentar þér — hvort sem það er einföld klipping eða heildarbreyting.',
    bookVerb: 'Bóka tíma',
    staffled: true,
    defaultStaffTitle: 'Hársnyrtir',
    services: [
      { name: 'Klipping — dömur', description: 'Þvottur, klipping og blástur.', durationMin: 60, priceIsk: 12900, bufferAfterMin: 10 },
      { name: 'Klipping — herrar', description: 'Klipping og snyrting.', durationMin: 30, priceIsk: 7900, bufferAfterMin: 5 },
      { name: 'Klipping — börn', description: 'Fyrir 12 ára og yngri.', durationMin: 30, priceIsk: 5900, bufferAfterMin: 5 },
      { name: 'Litun', description: 'Heillitun með ráðgjöf um litaval.', durationMin: 120, priceIsk: 24900, bufferAfterMin: 15 },
      { name: 'Strípur', description: 'Ljósar eða dökkar strípur, hálfur eða heill haus.', durationMin: 150, priceIsk: 32900, bufferAfterMin: 15 },
      { name: 'Blástur og uppsetning', description: 'Fyrir veislur og viðburði.', durationMin: 45, priceIsk: 11900 },
      { name: 'Permanent', description: 'Varanleg liðun.', durationMin: 120, priceIsk: 27900, bufferAfterMin: 15 },
    ],
    hours: RETAIL_HOURS,
    greeting:
      'Góðan dag og velkomin til {name}. Þú getur bókað tíma, fengið upplýsingar um opnunartíma eða skilið eftir skilaboð.',
    questions: [
      { key: 'staff_count', label: 'Hversu margir hársnyrtar starfa hjá ykkur?', hint: 'Hver fær sitt eigið dagatal og lausa tíma.' },
      { key: 'walk_ins', label: 'Takið þið á móti fólki án tímapantana?', hint: 'Hefur áhrif á hversu þétt bókanir eru settar.' },
    ],
  },
  {
    key: 'snyrtistofa',
    label: 'Snyrtistofa',
    emoji: '💅',
    template: 'stofa',
    tagline: 'Húðmeðferðir og snyrting í rólegu umhverfi',
    about:
      'Við bjóðum upp á húðgreiningu og meðferðir sem eru sniðnar að þinni húð. Markmiðið er einfalt: að þú farir út úr dyrunum með betri húð og betri líðan.',
    bookVerb: 'Bóka meðferð',
    staffled: true,
    defaultStaffTitle: 'Snyrtifræðingur',
    services: [
      { name: 'Andlitsbað', description: 'Djúphreinsun, gufa og maski.', durationMin: 60, priceIsk: 15900, bufferAfterMin: 10 },
      { name: 'Húðgreining og ráðgjöf', description: 'Kortlagning á húðgerð og meðferðaráætlun.', durationMin: 30, priceIsk: 5900 },
      { name: 'Vaxmeðferð — fótleggir', description: 'Heilir fótleggir.', durationMin: 45, priceIsk: 9900, bufferAfterMin: 10 },
      { name: 'Augnabrúnir og augnhár', description: 'Litun og plokkun.', durationMin: 30, priceIsk: 6900 },
      { name: 'Handsnyrting', description: 'Naglasnyrting og handmeðferð.', durationMin: 45, priceIsk: 9900 },
      { name: 'Gel-neglur', description: 'Ásetning eða áfylling.', durationMin: 90, priceIsk: 16900, bufferAfterMin: 10 },
    ],
    hours: RETAIL_HOURS,
    greeting:
      'Góðan dag, þetta er {name}. Þú getur bókað meðferð, fengið upplýsingar um verð eða skilið eftir skilaboð.',
    questions: [
      { key: 'staff_count', label: 'Hversu margir snyrtifræðingar starfa hjá ykkur?', hint: 'Hver fær sitt eigið dagatal.' },
      { key: 'rooms', label: 'Hversu mörg meðferðarherbergi eru til staðar?', hint: 'Stýrir hversu margar meðferðir geta verið í gangi samtímis.' },
    ],
  },
  {
    key: 'naglastofa',
    label: 'Naglastofa',
    emoji: '💅',
    template: 'stofa',
    tagline: 'Neglur sem endast',
    about:
      'Við sérhæfum okkur í nöglum — akrýl, gel og allt þar á milli. Komdu með hugmynd eða mynd, eða leyfðu okkur að stinga upp á einhverju sem passar þér.',
    bookVerb: 'Bóka tíma',
    staffled: true,
    defaultStaffTitle: 'Naglafræðingur',
    services: [
      { name: 'Nýjar neglur — gel', description: 'Ásetning með gel-tækni.', durationMin: 120, priceIsk: 17900, bufferAfterMin: 10 },
      { name: 'Nýjar neglur — akrýl', description: 'Ásetning með akrýl.', durationMin: 120, priceIsk: 17900, bufferAfterMin: 10 },
      { name: 'Áfylling', description: 'Áfylling á gel eða akrýl.', durationMin: 90, priceIsk: 13900, bufferAfterMin: 10 },
      { name: 'Gelalakk', description: 'Gelalakk á eigin neglur.', durationMin: 60, priceIsk: 9900 },
      { name: 'Handsnyrting', description: 'Naglasnyrting og handmeðferð.', durationMin: 45, priceIsk: 8900 },
      { name: 'Fótsnyrting', description: 'Naglasnyrting og fótameðferð.', durationMin: 60, priceIsk: 11900 },
      { name: 'Úrtekt', description: 'Fjarlæging á gömlum gel- eða akrýlnöglum.', durationMin: 30, priceIsk: 4900 },
    ],
    hours: RETAIL_HOURS,
    greeting: 'Góðan dag, þetta er {name}. Þú getur bókað tíma eða skilið eftir skilaboð.',
    questions: [
      { key: 'staff_count', label: 'Hversu margir naglafræðingar starfa hjá ykkur?', hint: 'Hver fær sitt eigið dagatal.' },
      { key: 'stations', label: 'Hversu mörg vinnuborð eru til staðar?', hint: 'Stýrir samtímabókunum.' },
    ],
  },
  {
    key: 'bilaverkstaedi',
    label: 'Bílaverkstæði',
    emoji: '🔧',
    template: 'verkstaedi',
    tagline: 'Viðgerðir og þjónusta fyrir allar gerðir bíla',
    about:
      'Við sinnum reglubundnu viðhaldi, smurþjónustu og viðgerðum. Þú færð verðmat áður en vinna hefst og upplýsingar um stöðuna á meðan bíllinn er hjá okkur.',
    bookVerb: 'Bóka verkstæðistíma',
    staffled: false,
    defaultStaffTitle: 'Bifvélavirki',
    services: [
      { name: 'Smurþjónusta', description: 'Olíuskipti og síuskipti.', durationMin: 45, priceIsk: 18900, capacity: 2 },
      { name: 'Skoðunarþjónusta', description: 'Yfirferð fyrir aðalskoðun.', durationMin: 60, priceIsk: 14900, capacity: 2 },
      { name: 'Bremsuviðgerð', description: 'Klossar og diskar, að framan eða aftan.', durationMin: 180, priceIsk: 54900 },
      { name: 'Tímareimaskipti', description: 'Skipti á tímareim og strekkjara.', durationMin: 300, priceIsk: 129000 },
      { name: 'Dekkjaskipti', description: 'Umfelgun og jafnvægisstilling á fjórum dekkjum.', durationMin: 45, priceIsk: 12900, capacity: 2 },
      { name: 'Bilanagreining', description: 'Lestur á villuboðum og greining.', durationMin: 60, priceIsk: 16900 },
    ],
    hours: TRADE_HOURS,
    greeting:
      'Góðan dag, {name}. Þú getur bókað tíma á verkstæðið, fengið upplýsingar um opnunartíma eða skilið eftir skilaboð og við hringjum til baka.',
    questions: [
      { key: 'bays', label: 'Hversu margar lyftur eða viðgerðarstæði eru á verkstæðinu?', hint: 'Ræður hversu mörg verk geta verið í gangi samtímis.' },
      { key: 'courtesy_car', label: 'Bjóðið þið upp á bílalán á meðan viðgerð stendur?', hint: 'Birtist á vefsíðunni og í bókunarferlinu.' },
      { key: 'pickup', label: 'Sækið þið bíla til viðskiptavina?', hint: 'Bætist við sem valkostur í bókun.' },
    ],
  },
  {
    key: 'dekkjaverkstaedi',
    label: 'Dekkjaverkstæði',
    emoji: '🛞',
    template: 'verkstaedi',
    tagline: 'Dekkjaskipti og geymsla — fljót og góð þjónusta',
    about:
      'Við skiptum um dekk, gerum við sprungin dekk og geymum sumar- og vetrardekkin þín yfir vertíðina. Á háannatíma borgar sig að bóka tíma fyrirfram.',
    bookVerb: 'Bóka dekkjaskipti',
    staffled: false,
    defaultStaffTitle: 'Dekkjamaður',
    services: [
      { name: 'Umfelgun — 4 dekk', description: 'Skipt um dekk á felgum og jafnvægisstillt.', durationMin: 45, priceIsk: 14900, capacity: 3 },
      { name: 'Dekkjaskipti á felgum', description: 'Skipt um heil hjól.', durationMin: 20, priceIsk: 6900, capacity: 3 },
      { name: 'Viðgerð á sprungnu dekki', description: 'Bætt eða innsetning.', durationMin: 30, priceIsk: 5900, capacity: 2 },
      { name: 'Dekkjageymsla — vertíð', description: 'Geymsla á fjórum dekkjum yfir vertíðina.', durationMin: 15, priceIsk: 12900, capacity: 3 },
    ],
    hours: {
      1: [h(8, 18)], 2: [h(8, 18)], 3: [h(8, 18)], 4: [h(8, 18)], 5: [h(8, 18)], 6: [h(10, 14)], 7: [],
    },
    greeting: 'Góðan dag, {name}. Bókaðu dekkjaskipti eða skildu eftir skilaboð.',
    questions: [
      { key: 'bays', label: 'Hversu mörg dekkjastæði eru í notkun?', hint: 'Ræður hversu marga bíla má bóka á sama tíma.' },
      { key: 'storage', label: 'Bjóðið þið dekkjageymslu?', hint: 'Bætist við þjónustulistann og vefsíðuna.' },
    ],
  },
  {
    key: 'pipulagnir',
    label: 'Pípulagnir',
    emoji: '🔩',
    template: 'idnadarmadur',
    tagline: 'Pípulagningaþjónusta fyrir heimili og fyrirtæki',
    about:
      'Við sinnum bæði bráðaþjónustu og skipulögðum verkum — allt frá lekum krana upp í endurnýjun á lögnum. Löggiltur pípulagningameistari sér um öll verk.',
    bookVerb: 'Panta pípara',
    staffled: false,
    defaultStaffTitle: 'Pípulagningamaður',
    services: [
      { name: 'Útkall — almennt', description: 'Skoðun og minni háttar viðgerð á staðnum.', durationMin: 90, priceIsk: 24900 },
      { name: 'Lekaleit', description: 'Leit að leka með myndavél og rakamælingu.', durationMin: 120, priceIsk: 34900 },
      { name: 'Uppsetning á blöndunartæki', description: 'Skipt um krana eða blöndunartæki.', durationMin: 60, priceIsk: 18900 },
      { name: 'Salernisuppsetning', description: 'Uppsetning eða skipti á salerni.', durationMin: 120, priceIsk: 32900 },
      { name: 'Stífluþjónusta', description: 'Losun á stíflu í niðurfalli eða frárennsli.', durationMin: 90, priceIsk: 27900 },
      { name: 'Ofnaþjónusta', description: 'Loftun, skipti eða uppsetning ofna.', durationMin: 120, priceIsk: 29900 },
    ],
    hours: TRADE_HOURS,
    greeting:
      'Góðan dag, þetta er {name}. Ef um bráðatilfelli er að ræða skaltu ýta á núll til að fá samband. Annars getur þú bókað tíma eða skilið eftir skilaboð.',
    questions: [
      { key: 'emergency', label: 'Sinnið þið bráðaútköllum utan opnunartíma?', hint: 'Símsvarinn áframsendir bráðatilfelli á þig.' },
      { key: 'area', label: 'Hvaða svæði þjónustið þið?', hint: 'Birtist á vefsíðunni, t.d. „höfuðborgarsvæðið og Suðurnes“.' },
      { key: 'callout_fee', label: 'Er fast útkallsgjald?', hint: 'Birtist í verðskrá.' },
    ],
  },
  {
    key: 'rafvirki',
    label: 'Rafvirkjun',
    emoji: '⚡',
    template: 'idnadarmadur',
    tagline: 'Löggilt rafvirkjaþjónusta',
    about:
      'Við tökum að okkur raflagnir í nýbyggingum, endurnýjun á eldri lögnum, uppsetningu á hleðslustöðvum og almenna bilanaleit.',
    bookVerb: 'Panta rafvirkja',
    staffled: false,
    defaultStaffTitle: 'Rafvirki',
    services: [
      { name: 'Útkall og bilanaleit', description: 'Greining á rafmagnsbilun.', durationMin: 90, priceIsk: 23900 },
      { name: 'Uppsetning hleðslustöðvar', description: 'Hleðslustöð fyrir rafbíl, með tengingu við töflu.', durationMin: 240, priceIsk: 89000 },
      { name: 'Ljósauppsetning', description: 'Uppsetning á ljósum og rofum.', durationMin: 90, priceIsk: 21900 },
      { name: 'Töfluskipti', description: 'Endurnýjun á rafmagnstöflu.', durationMin: 300, priceIsk: 129000 },
      { name: 'Rafmagnsúttekt', description: 'Ástandsskoðun á raflögnum með skýrslu.', durationMin: 120, priceIsk: 34900 },
    ],
    hours: TRADE_HOURS,
    greeting: 'Góðan dag, {name}. Bókaðu tíma eða skildu eftir skilaboð og við höfum samband.',
    questions: [
      { key: 'area', label: 'Hvaða svæði þjónustið þið?', hint: 'Birtist á vefsíðunni.' },
      { key: 'emergency', label: 'Sinnið þið bráðaútköllum?', hint: 'Símsvarinn áframsendir bráðatilfelli.' },
    ],
  },
  {
    key: 'sjukrathjalfun',
    label: 'Sjúkraþjálfun',
    emoji: '🧑‍⚕️',
    template: 'heilsa',
    tagline: 'Sjúkraþjálfun og endurhæfing',
    about:
      'Við vinnum með þér að því að ná fullum styrk eftir meiðsli eða aðgerð. Fyrsti tími er alltaf greining þar sem við setjum upp áætlun saman.',
    bookVerb: 'Bóka tíma',
    staffled: true,
    defaultStaffTitle: 'Sjúkraþjálfari',
    services: [
      { name: 'Fyrsta koma — greining', description: 'Ítarleg skoðun og meðferðaráætlun.', durationMin: 60, priceIsk: 13900, vskRate: VSK.exempt },
      { name: 'Meðferðartími', description: 'Framhaldstími í meðferð.', durationMin: 30, priceIsk: 8900, vskRate: VSK.exempt },
      { name: 'Sjúkranudd', description: 'Djúpvöðvameðferð.', durationMin: 45, priceIsk: 11900, vskRate: VSK.exempt },
      { name: 'Æfingaráðgjöf', description: 'Uppsetning á æfingaprógrammi.', durationMin: 45, priceIsk: 10900, vskRate: VSK.exempt },
    ],
    hours: {
      1: [h(8, 17)], 2: [h(8, 17)], 3: [h(8, 17)], 4: [h(8, 17)], 5: [h(8, 16)], 6: [], 7: [],
    },
    greeting:
      'Góðan dag, þetta er {name}. Þú getur bókað tíma eða skilið eftir skilaboð. Athugið að símsvarinn tekur ekki við heilsufarsupplýsingum.',
    questions: [
      { key: 'staff_count', label: 'Hversu margir sjúkraþjálfarar starfa hjá ykkur?', hint: 'Hver fær sitt eigið dagatal.' },
      { key: 'referral', label: 'Þarf tilvísun frá lækni?', hint: 'Birtist í bókunarferlinu.' },
    ],
  },
  {
    key: 'nudd',
    label: 'Nuddstofa',
    emoji: '💆',
    template: 'heilsa',
    tagline: 'Nudd og slökun',
    about:
      'Við bjóðum upp á klassískt nudd, djúpvöðvanudd og slökunarmeðferðir. Segðu okkur hvað er að angra þig og við sníðum meðferðina að því.',
    bookVerb: 'Bóka nudd',
    staffled: true,
    defaultStaffTitle: 'Nuddari',
    services: [
      { name: 'Klassískt nudd — 60 mín', description: 'Heilnudd.', durationMin: 60, priceIsk: 13900, bufferAfterMin: 15 },
      { name: 'Klassískt nudd — 90 mín', description: 'Lengri heilmeðferð.', durationMin: 90, priceIsk: 18900, bufferAfterMin: 15 },
      { name: 'Djúpvöðvanudd', description: 'Markviss meðferð á spennusvæðum.', durationMin: 60, priceIsk: 15900, bufferAfterMin: 15 },
      { name: 'Bak og herðar — 30 mín', description: 'Stutt meðferð á efri baki.', durationMin: 30, priceIsk: 8900, bufferAfterMin: 10 },
    ],
    hours: RETAIL_HOURS,
    greeting: 'Góðan dag, {name}. Bókaðu nudd eða skildu eftir skilaboð.',
    questions: [
      { key: 'staff_count', label: 'Hversu margir nuddarar starfa hjá ykkur?', hint: 'Hver fær sitt eigið dagatal.' },
      { key: 'rooms', label: 'Hversu mörg nuddherbergi eru til staðar?', hint: 'Stýrir samtímabókunum.' },
    ],
  },
  {
    key: 'tresmidi',
    label: 'Trésmíði og hönnun',
    emoji: '🪵',
    template: 'smidja',
    tagline: 'Handsmíðaðir hlutir úr gæðaviði',
    about:
      'Við hönnum og smíðum handgerðar vörur úr gæðaefnum þar sem lögð er áhersla á vandaða smíði, fallegt útlit og endingargæði. Hver vara er unnin af alúð og því eru engin tvö eintök alveg eins. Við tökum einnig að okkur séróskir þegar það er mögulegt.',
    bookVerb: 'Bóka ráðgjöf',
    staffled: false,
    defaultStaffTitle: 'Smiður',
    // A workshop that sells objects still books the one thing that needs a
    // person and a calendar: the conversation before a commission.
    services: [
      { name: 'Ráðgjöf um sérsmíði', description: 'Farið yfir hugmynd, efnisval, stærð og verð.', durationMin: 30, priceIsk: 0 },
      { name: 'Mátun og uppsetning', description: 'Mæling á staðnum fyrir innréttingu eða húsgagn.', durationMin: 90, priceIsk: 19900 },
    ],
    products: [
      {
        name: 'Skurðarbretti með epoxý',
        tagline: 'Eik og rauð epoxý-á',
        description:
          'Skurðarbretti úr gegnheilli eik með rennandi epoxý-á í gegn og safarauf meðfram brúninni. Slípað í fjórum umferðum og olíuborið með matvælaöruggri viðarolíu.',
        category: 'Skurðarbretti',
        material: 'Eik og epoxý',
        dimensions: '30 × 40 cm',
        priceIsk: 40000,
        madeToOrder: true,
        leadTimeDays: 21,
      },
      {
        name: 'Skurðarbretti — endaviður',
        tagline: 'Hnota, álmur og eik',
        description:
          'Endaviðarbretti límt úr hnotu, álmi og eik. Endaviður hlífir hnífseggjum og lokast aftur eftir hvert skurðarfar, sem gerir brettið að því eina sem eldhús þarf.',
        category: 'Skurðarbretti',
        material: 'Hnota, álmur og eik',
        dimensions: '35 × 45 cm',
        priceIsk: 46000,
        madeToOrder: true,
        leadTimeDays: 21,
      },
      {
        name: 'Framreiðslubretti',
        tagline: 'Hlynur með skálínum',
        description:
          'Handsmíðað framreiðslubretti með skálaga mynstri úr hlyn og lituðu epoxý. Hannað til að setja beint á borðið — ostar, brauð og það sem gestirnir grípa með sér.',
        category: 'Framreiðsla',
        material: 'Hlynur og epoxý',
        dimensions: '28 × 38 cm',
        priceIsk: 32000,
        stock: 2,
      },
      {
        name: 'Brauðbretti með rimlum',
        tagline: 'Eik með mylsnuskúffu',
        description:
          'Rimlabretti úr eik með útdraganlegri skúffu undir. Mylsnan fellur niður á milli rimlanna og borðið helst hreint.',
        category: 'Framreiðsla',
        material: 'Eik og reykt eik',
        dimensions: '25 × 35 cm',
        priceIsk: 24900,
        stock: 3,
      },
      {
        name: 'Taflborð',
        tagline: 'Hnota og hlynur',
        description:
          'Taflborð límt úr hnotu og hlyn með innfelldri kantlist. Reitirnir eru 50 mm og borðið er olíuborið beggja vegna svo það vindi sig ekki.',
        category: 'Taflborð',
        material: 'Hnota og hlynur',
        dimensions: '45 × 45 cm',
        priceIsk: 54000,
        madeToOrder: true,
        leadTimeDays: 28,
      },
      {
        name: 'Kattabæli',
        tagline: 'Hús sem má sjást í stofunni',
        description:
          'Lokað bæli úr birki á eikarfótum, með mjúkri dýnu sem má taka úr og þvo. Smíðað fyrir köttinn en teiknað fyrir stofuna.',
        category: 'Fyrir dýrin',
        material: 'Birki og eik',
        dimensions: '55 × 40 × 40 cm',
        priceIsk: 39000,
        madeToOrder: true,
        leadTimeDays: 21,
      },
      {
        name: 'Handklæðastandur',
        tagline: 'Eik fyrir baðherbergið',
        description:
          'Standur úr olíuborinni eik með þremur slám. Þolir raka baðherbergisins og þarf hvorki skrúfur í vegg né verkfæri við samsetningu.',
        category: 'Baðherbergi',
        material: 'Olíuborin eik',
        dimensions: '80 × 45 × 35 cm',
        priceIsk: 27900,
        stock: 4,
      },
      {
        name: 'Sófaborð með epoxý-á',
        tagline: 'Hnota með lifandi brún',
        description:
          'Sófaborð úr hnotu með lifandi brún og hvítri epoxý-á sem rennur eftir borðinu endilöngu. Fæturnir eru krosslagðir úr sama viði. Hvert borð er smíðað úr einni plötu, svo mynstrið endurtekur sig aldrei.',
        category: 'Húsgögn',
        material: 'Hnota, hlynur og epoxý',
        dimensions: 'L 116 · B 62 · H 42 cm',
        priceIsk: 250000,
        madeToOrder: true,
        leadTimeDays: 45,
      },
    ],
    hours: {
      1: [h(9, 17)], 2: [h(9, 17)], 3: [h(9, 17)], 4: [h(9, 17)], 5: [h(9, 16)], 6: [h(11, 14)], 7: [],
    },
    greeting:
      'Góðan dag, þetta er {name}. Þú getur skoðað vörurnar á vefnum, spurt um sérsmíði eða skilið eftir skilaboð og við hringjum til baka.',
    questions: [
      { key: 'sersmidi', label: 'Takið þið að ykkur sérsmíði?', hint: 'Birtist á vefsíðunni og opnar fyrirspurnarform.' },
      { key: 'sending', label: 'Sendið þið vörur um landið?', hint: 'Stýrir afhendingarvalkostum í körfunni.' },
      { key: 'efni', label: 'Hvaða viðartegundir vinnið þið helst með?', hint: 'Notað í vörulýsingar, t.d. „eik, hnota og álmur“.' },
    ],
  },
  {
    key: 'annad',
    label: 'Annað',
    emoji: '🏢',
    template: 'almennt',
    tagline: 'Persónuleg þjónusta',
    about: 'Segðu okkur hvað þú þarft og við finnum lausn sem hentar.',
    bookVerb: 'Bóka tíma',
    staffled: false,
    defaultStaffTitle: 'Starfsmaður',
    services: [
      { name: 'Ráðgjafartími', description: 'Fyrsta samtal og þarfagreining.', durationMin: 30, priceIsk: 9900 },
      { name: 'Þjónustutími', description: 'Almennur bókaður tími.', durationMin: 60, priceIsk: 15900 },
    ],
    hours: TRADE_HOURS,
    greeting: 'Góðan dag, þetta er {name}. Þú getur bókað tíma eða skilið eftir skilaboð.',
    questions: [
      { key: 'services', label: 'Hvaða þjónustu bjóðið þið?', hint: 'Við setjum upp þjónustulista út frá svarinu.' },
    ],
  },
];

const BY_KEY = new Map(INDUSTRIES.map((i) => [i.key, i]));

export function industryPreset(key: string): IndustryPreset {
  return BY_KEY.get(key) ?? BY_KEY.get('annad')!;
}

export function industryLabel(key: string): string {
  return industryPreset(key).label;
}
