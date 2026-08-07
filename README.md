# Rafræn Þjónusta

Stjórnborð fyrir stafræna þjónustu við íslensk smáfyrirtæki — vefsíður, bókanir,
tölvupóstur og símsvörun.

Þú slærð inn nafn fyrirtækis, velur fag, hakar við það sem á að setja upp og
kerfið gerir afganginn: býr til þjónustulista og opnunartíma, smíðar þrjár
fullbúnar vefsíður til að velja úr, setur upp bókunarkerfi með spurningaflæði
sem hæfir faginu, og býr til verkefnalista með nákvæmlega því sem þarf að gera
handvirkt (DNS-færslur, Twilio-slóðir, Google-tenging).

Þetta er eins notanda kerfi. Aðgangurinn er einn — þinn.

---

## Innihald

- [Byrjað](#byrjað)
- [Keyrsluskrá (.exe)](#sem-forrit-exe)
- [Hvað kerfið gerir](#hvað-kerfið-gerir)
- [Spurningaflæði eftir fagi](#spurningaflæði-eftir-fagi)
- [Vefsíðugerð](#vefsíðugerð)
- [Bókanavélin](#bókanavélin)
- [Tengingar](#tengingar)
- [Uppbygging](#uppbygging)
- [Rekstur](#rekstur)
- [English summary](#english-summary)

---

## Byrjað

### Sem forrit (.exe)

Sæktu `RafraenThjonusta.exe` og tvísmelltu á hana. Forritið ræsir sig, opnar
vafrann og býður þér að stofna aðganginn þinn — engin uppsetning, enginn
gagnagrunnur að setja upp, engin skipanalína.

Til að smíða keyrsluskrána sjálf/ur:

```bash
npm install          # nauðsynlegt — smíðaverkfærin eru devDependencies
npm run exe          # Windows .exe í dist-exe/
npm run exe:all      # Windows, macOS og Linux
```

`npm install` verður að keyra fyrst, og aftur eftir hvert `git pull` sem bætir
við verkfærum. Sleppirðu því segir smíðin þér það beint.

Skriptið sækir Node-keyrsluumhverfi sem passar við þína Node-útgáfu (blobið og
keyrsluumhverfið verða að vera sama útgáfa). Keyrirðu Node-útgáfu sem er ekki
gefin út á nodejs.org — t.d. næturútgáfu — veldu aðra:

```bash
set RTH_NODE_VERSION=v22.14.0 && npm run exe     # Windows
RTH_NODE_VERSION=v22.14.0 npm run exe            # macOS/Linux
```

Gögnin þín eru geymd hjá þér:

| Kerfi | Staðsetning |
| --- | --- |
| Windows | `%APPDATA%\RafraenThjonusta` |
| macOS | `~/Library/Application Support/RafraenThjonusta` |
| Linux | `~/.local/share/rafraen-thjonusta` |

Þar er gagnagrunnurinn (`rafraen.sqlite`), myndaðar vefsíður og
stillingaskráin. **Taktu afrit af þessari möppu reglulega** — hún er allt
kerfið.

Keyrsluskráin er um 84 MB því hún inniheldur Node-keyrsluumhverfið sjálft.
Ekkert þarf að setja upp á vélinni.

> **Windows SmartScreen** — skráin er ekki undirrituð með kóðaskírteini, svo
> Windows sýnir viðvörun í fyrsta skipti. Veldu „More info“ og svo
> „Run anyway“. Til að losna við það þarf Authenticode-skírteini.

### Að uppfæra

Keyrsluskráin er frosin afrit af kóðanum — hún uppfærist ekki sjálf.

```bash
git pull
npm install
npm run exe
```

Keyrðu svo **nýju** skrána úr `dist-exe/`. Hafirðu afritað þá gömlu eitthvert
annað þarf að skipta henni út þar líka.

Til að sjá hvaða útgáfu þú ert að keyra: **Stillingar → Kerfið** sýnir
smíðatíma og commit, og sama kemur fram í svarta glugganum við ræsingu.

### Sem þjónn (fyrir hýsingu)

Krafa: **Node.js 22.5 eða nýrra** (kerfið notar innbyggða SQLite-einingu Node).

```bash
npm install                 # aðeins þýðingartól — engar keyrsluháðar einingar
cp .env.example .env        # fylltu út það sem þú átt; restin fer í þurrkeyrslu
npm run setup               # stofnar stjórnandaaðganginn þinn
npm run seed                # valfrjálst: þrír sýniviðskiptavinir með bókunum
npm run dev                 # ræsir á http://localhost:8080
```

Opnaðu **http://localhost:8080/stjornbord**.

### Í hýsingu allan sólarhringinn

`.exe`-skráin keyrir aðeins meðan tölvan þín er í gangi. Eigi símsvarinn að
svara og áminningar að fara út á nóttunni þarf kerfið að vera á netþjóni.

Í boði eru `Dockerfile` og `fly.toml` fyrir [Fly.io](https://fly.io):

```bash
fly launch --no-deploy --copy-config
fly volumes create rafraen_gogn --size 3 --region lhr
fly deploy
```

`APP_SECRET` þarf að setja á milli. Búðu gildið til í tveimur skrefum frekar en
einu — `$(...)` er bash-skipun sem Windows-skel víkkar ekki út, heldur sendir
áfram sem texta, og þá stöðvast ræsingin á of stuttu leyndarmáli:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
fly secrets set APP_SECRET=<límdu gildið hér>
```

Þetta virkar eins í CMD, PowerShell og bash. Leyndarmálið afkóðar geymd
aðgangsorð og OAuth-teikn, svo geymdu það — breytist það verða þau ólæsileg.

Breyttu `BASE_URL` í `fly.toml` í raunverulega slóðina áður en þú keyrir
`fly deploy` — Google-innskráning, Twilio-vefkrókar og bókunartenglar eru allir
smíðaðir út frá henni, og kerfið neitar að ræsa á `http://` í rekstri.

Opnaðu svo `https://<lén>/uppsetning` til að stofna stjórnandaaðganginn — það
er sama fyrsta-skiptis-ferli og í `.exe`-skránni, svo enginn skjár í skel þarf.

Tvennt í `fly.toml` má ekki hreyfa við: `auto_stop_machines = false`, því
bakgrunnsverkið sem sendir áminningar er tímamælir inni í ferlinu og hættir að
vinna sofni vélin; og **aðeins ein vél** (`fly scale count 1`), því
gagnagrunnurinn er SQLite-skrá sem þolir einn skrifara.

Sama mynd keyrir á Railway, Render eða hvaða VPS sem er — það eina sem skiptir
máli er varanlegur diskur á `/data` og eitt ferli.

> **Vercel gengur ekki fyrir stjórnborðið.** Skráakerfið þar er skrifvarið og
> ferli lifa ekki milli beiðna, en gagnagrunnurinn er skrá á diski og
> bakgrunnsverkið er tímamælir. Vefsíður viðskiptavina eiga hins vegar vel
> heima þar — sjá næsta kafla.

### Vefsíður viðskiptavina á Vercel

Mynduð vefsíða er ein sjálfstæð HTML-skrá án byggingarþreps, sem er nákvæmlega
það sem hraðnet á að hýsa. Settu `VERCEL_TOKEN` inn undir **Tengingar**, opnaðu
svo viðskiptavin → **Vefsíða** → **Setja í loftið á Vercel**.

Hver viðskiptavinur fær sitt eigið Vercel-verkefni (`rth-<slug>`). Sé lén skráð
á viðskiptavininn tengist það sjálfkrafa, og þær DNS-færslur sem eftir standa
birtast í skilaboðunum.

Bókunarviðmótið á síðunni kallar áfram á þetta stjórnborð, sem sendir þegar
`Access-Control-Allow-Origin` á opinbera bókunar-API-inu — það þarf því ekkert
að stilla til viðbótar. Vefsíðan er áfram aðgengileg héðan á `/v/<slug>` hvort
sem er, svo ytri hýsing er viðbót en aldrei forsenda.

### Þurrkeyrsla

Kerfið keyrir að fullu án nokkurra ytri reikninga. Vantar SMTP? Póstar eru
smíðaðir, skráðir og merktir `þurrkeyrsla` en ekki sendir. Vantar Twilio? Sama
með SMS. Þannig geturðu prófað allt bókunarferlið — þar með talið staðfestingar
og áminningar — áður en þú stofnar reikning nokkurs staðar.

Staða hverrar tengingar sést á `/stillingar`.

---

## Hvað kerfið gerir

### Fyrir þig (rekstraraðilann)

| Síða | Til hvers |
| --- | --- |
| `/stjornbord` | Staðan á öllum viðskiptavinum, hvað bíður aðgerða, frídagar framundan |
| `/vidskiptavinir/nyr` | Uppsetningarhjálpin — ein síða, allt sett upp |
| `/vidskiptavinir/:id/vefur` | Þrjár útlitstillögur hlið við hlið, veldu og birtu |
| `/vidskiptavinir/:id/verkefni` | Verkefnalisti með DNS-færslum, vefkrókum og pörunarkóðum |
| `/vidskiptavinir/:id/bokanir` | Dagbók með öllum svörum viðskiptavina |
| `/vidskiptavinir/:id/simtol` | Símtalaskrá með umritunum úr símsvara |
| `/samskipti` | Allur póstur og SMS sem kerfið hefur sent, með stöðu |

### Fyrir viðskiptavininn (fyrirtækið)

- Vefsíða á eigin léni með bókunarkerfi.
- Bókanir birtast í Google-dagatalinu þeirra; einkatímar í dagatalinu loka á
  bókanir á móti.
- Símsvari sem svarar á íslensku, bókar tíma og tekur skilaboð utan opnunartíma.
- Snjallsímaapp (iOS og Android) með tilkynningum um leið og bókun berst.

### Fyrir viðskiptavini þeirra (fólkið sem bókar)

- Bókun á íslensku með spurningum sem hæfa faginu.
- Staðfesting í tölvupósti og SMS, með afbókunartengli.
- Áminning sólarhring fyrir tímann.

---

## Spurningaflæði eftir fagi

Þetta er kjarninn í því sem greinir kerfið frá almennu bókunarkerfi. Hvert fag
hefur sitt spurningatré sem greinist eftir svörum.

**Bílaverkstæði**, sem dæmi:

```
Bílnúmer  →  Hvaða þjónustu þarftu?
                ├── Olíuskipti          → beint í tímaval
                ├── Bremsuskipti        → Hvar? (framan/aftan/bæði)
                │                       → Hvað? (klossar/diskar/vökvi)
                ├── Peruskipti          → Hvaða perur? (fjölval)
                └── Annað               → Veistu hvað er að?
                                            ├── Já  → lýstu því með þínum orðum
                                            └── Nei → Hvaða einkenni tekurðu eftir?
                                                        titringur í stýri
                                                        titringur í hjólum
                                                        hljóð innan úr farþegarými
                                                        hljóð undan vélarhlíf
                                                        hljóð frá hjólum
                                                        ískur þegar ég bremsa
                                                        viðvörunarljós  → hvaða ljós?
                                                        …
                                                     → Hvenær kemur það fram?
                                                     → Hversu lengi hefur það staðið?
                                                     → Er bíllinn ökufær?
```

Sömu hugsun er beitt á öll fögin:

| Fag | Dæmi um sérspurningar |
| --- | --- |
| Bílaverkstæði | Bílnúmer, tegund, einkennagreining, bílalán |
| Dekkjaverkstæði | Dekkjastærð, árstíð, fjöldi, geymsla |
| Hárgreiðslustofa | Sídd, þykkt, fyrri litun, heimalitun, óskalitur, viðmiðunarmynd |
| Naglastofa | Akrýl eða gel, lengd, form, skraut, viðmiðunarmynd |
| Snyrtistofa | Húðgerð, áherslusvæði, ofnæmi, húðlyf |
| Pípulagnir | Bráðatilfelli, hvort lokað sé fyrir vatn, einkenni, aðgangur |
| Rafvirkjun | Öryggisspurning (brunalykt), tegund verks, aldur húss |
| Sjúkraþjálfun | Svæði, verkjastig, orsök, markmið |
| Nudd | Svæði, þrýstingur, meðganga, heilsufar |

Þrennt gerist sjálfkrafa út frá svörunum:

1. **Rétt þjónusta er valin.** „Bremsuskipti“ ratar á bremsuviðgerð í verðskránni.
2. **Tímalengd lagast.** Sítt og þykkt hár í balayage bætir 100 mínútum við —
   og kerfið býður bara tíma sem raunverulega rúma það.
3. **Starfsmaðurinn fær nothæfa lýsingu.** Svörin birtast í stjórnborðinu, í
   appinu, í dagatalsfærslunni og í póstinum til fyrirtækisins.

### Þegar viðskiptavinurinn kann ekki að lýsa því

Í naglastofu- og hárgreiðsluflæðinu er spurt hvort viðmiðunarmynd sé til. Sé
svarið nei fær viðskiptavinurinn textareit og hnappinn **„Fá tillögur út frá
lýsingunni“** — gervigreind les lýsinguna og stingur upp á þremur útfærslum með
heiti og stuttri lýsingu, sem hann getur valið úr.

Sé enginn API-lykill uppsettur eru notaðar tilbúnar tillögur eftir fagi. Bókun
stöðvast aldrei vegna þess að gervigreind sé ekki tiltæk.

---

## Uppfletting eftir kennitölu

Í töfrasprotanum slærðu inn kennitölu fyrirtækisins og ýtir á **Sækja
upplýsingar**. Reitirnir fyllast sjálfkrafa og hver þeirra er merktur þeim sem
gaf gildið.

| Uppruni | Reitir |
|---|---|
| **Fyrirtækjaskrá** (Skatturinn) | Nafn, heimilisfang, póstnúmer, fag (úr ÍSAT-flokkun). Auk þess rekstrarform, ÍSAT-númer og VSK-númer til staðfestingar |
| **Lénaskrá** (ISNIC) | Lén, símanúmer, netfang |
| **Gervigreind** | Lýsing á fyrirtækinu, samin úr staðreyndunum að ofan |

Reitur sem þú hefur þegar fyllt út er aldrei yfirskrifaður.

### Gervigreind flettir ekki upp

Þetta er ástæðan fyrir uppruna-merkingunum. Spyrjirðu mállíkan „hvaða fyrirtæki
er með kennitölu 5501234567“ þá svarar það — með trúverðugu nafni, trúverðugu
símanúmeri og trúverðugu netfangi. Ekkert af því er flett upp; það er allt
samið. Skáldað símanúmer sem endar á vefsíðu viðskiptavinar er símanúmer
einhvers annars.

Þess vegna er röðin: skrár fyrst, líkan á eftir, og aðeins í þann eina reit sem
er raunverulegt ritverkefni. Finnist reitur hvergi stendur hann tómur og
ástæðan er sögð berum orðum — hann er aldrei fylltur með ágiskun.

### Eigandi léns er staðfestur

ISNIC leitar aðeins eftir léni, ekki kennitölu, svo lénið er ágiskað út frá
skráðu nafni fyrirtækisins og síðan **staðfest**. Sé skráður eigandi lénsins
ekki sama fyrirtæki er færslunni hent. `osp.is` gæti verið í eigu einhvers sem
tengist Hárgreiðslustofunni Ösp ekki neitt, og það er einmitt tilvikið sem
staðfestingin er til að stöðva.

Í mesta lagi þrjú lén eru reynd í hverri uppflettingu. Þetta er þægindi við
skráningu eins viðskiptavinar, ekki leit í gegnum skrána.

## Vefsíðugerð

Hver vefsíða er **ein sjálfstæð HTML-skrá** — engin utanaðkomandi leturgerð,
ekkert hreyfimyndasafn, engin ytri skrá. Það er forsenda þess að hægt sé að
birta hana á hraðneti og að hún opnist hratt á síma yfir 4G.

Innan þeirra marka er þetta í síðunum:

- **Stórt leturmál með karakter.** Engar vefletur eru sóttar, svo karakterinn
  kemur úr því hvernig kerfisletrið er stillt: þungar þyngdir, þétt stafabil og
  línuhæð undir 1 í fyrirsögnum. Fyrirsögnin er fyllt með litstigli.
- **Filmukorn** yfir alla síðuna. Þetta er ódýrasta bragðið í skránni og það
  sem gerir mest: stórir sléttir litstiglar lesast sem sniðmát af því að
  raunverulegir fletir eru aldrei fullkomlega sléttir.
- **Möskvabakgrunnur í hetjunni** — nokkrir hliðraðir geislastiglar sem gefa
  dýpt sem línulegur stigull gerir aldrei — og fagbundið mynstur: flæðandi
  þræðir fyrir stofur, hringir fyrir verkstæði, hornréttar lagnir fyrir
  iðnaðarmenn, púlslína fyrir heilsu.
- **Fljótandi haus** sem þéttist og fær móðugler, með lestrarrönd efst.
- **Þjónusturæma** sem líður hjá í fullri breidd. Hún segir ekkert nýtt —
  hlutverkið er taktur, því annars er síðan einn lóðréttur dálkur af köflum.
- **Dökkur bókunarkafli** í fullri breidd. Bókunin er ástæða síðunnar og fær
  sína eigin þyngd; bókunarviðmótið sjálft situr á ljósu spjaldi ofan á honum.
- **Númeruð þjónustuspjöld** með kastljósi sem eltir músina.
- **Tölur teljast upp** þegar þær koma í sýn.
- **Efni birtist við skrun**, með stigvaxandi töf innan hvers kafla.
- **Fastur bókunarborði** neðst á símum þegar hetjan er skrunuð úr sýn.
- **Algengar spurningar** svaraðar úr raunverulegum stillingum viðskiptavinarins
  — afbókunarfrestur og lágmarksfyrirvari eru tölurnar sem bókanavélin fylgir.

### Hreyfingar má slökkva á

Allar hreyfingar eru inni í `prefers-reduced-motion: no-preference`. Sá sem
hefur beðið stýrikerfið um minni hreyfingu fær kyrra síðu — ekki skerta.

Opinberanir eru sömuleiðis valkvæðar: klasinn sem felur efnið er settur á
síðuna af skriftunni sjálfri. Keyri hún ekki — lokað á skriftur, gamall vafri —
er ekkert falið og síðan er einfaldlega kyrr.

### Enginn litavalsreitur

Það var röng spurning. Þú ert að skrá fyrirtæki einhvers annars, veist sjaldnast
lit þess, og niðurstaðan var að flestar síður komu út í sjálfgefna bláa litnum.

Liturinn kemur núna úr tvennu, í þessari röð: **núverandi vefsíðu fyrirtækisins**
ef hún er til, og annars **faginu** — naglastofa og pípari opna ekki í sama tón.

### Sækja af núverandi vefsíðu

Sé lén skráð á viðskiptavininn birtist hnappurinn **Sækja af `<lén>`** á
vefsíðuflipanum. Hann les síðuna og tekur af henni kjörorð, lýsingu, síma,
netfang, einkennislit og verðskrá.

Útlitið er ekki tekið — það er einmitt tilgangurinn.

Innflutningur skrifar aldrei yfir reit sem þú hefur þegar fyllt út, og verðskrá
er aðeins flutt inn ef enginn þjónustulisti er til fyrir. Það sem fannst ekki er
sagt berum orðum í staðinn fyrir að vera þagað yfir.

## Útlitstillögur

Þegar uppsetningarhjálpin klárast eru smíðaðar **þrjár fullbúnar vefsíður** úr
sama efni — ekki þrjú litaþemu, heldur þrjár ólíkar hönnunarákvarðanir:

| Útlit | Lýsing |
| --- | --- |
| **Klassískt** | Ljóst og hreint, serif-fyrirsagnir, verðskrá í línum |
| **Nútímalegt** | Dökkur hluti efst, sterk leturgerð, skipt uppsetning, spjöld |
| **Hlýlegt** | Mjúkir litir, rúnnuð form, loftgott, listauppsetning |

Þú sérð þær hlið við hlið á `/vidskiptavinir/:id/vefur`, opnar hverja fyrir sig
í fullri stærð og velur. Valin síða fer í loftið á `/v/<auðkenni>` eða á léni
viðskiptavinarins.

Hver síða er **ein sjálfstæð HTML-skrá** með innfelldum stílum og skriftum:
engin ytri köll, ekkert byggingarþrep, engin JavaScript-eining. Það þýðir að
síðuna má hýsa hvar sem er — eða afhenda viðskiptavininum ef hann hættir.

Innifalið: þjónustulisti með verði, opnunartími, starfsfólk, bókunarkerfi,
kortatengill, `LocalBusiness` structured data fyrir Google, `sitemap.xml`,
`robots.txt`, favicon og bæði ljóst og dökkt þema.

---

## Bókanavélin

Kerfið styður tvö ólík rekstrarform:

**Bundið starfsfólki** (hárgreiðsla, sjúkraþjálfun) — hver bókun tilheyrir
nafngreindri manneskju. Laus tími hvers og eins er reiknaður sérstaklega og
niðurstöðurnar sameinaðar.

**Sameiginleg afkastageta** (verkstæði, dekkjaverkstæði) — enginn er bókaður
með nafni; það sem takmarkar er fjöldi lyfta eða stæða. Uppsetningarhjálpin
spyr „hversu mörg verk geta verið í gangi samtímis?“ og kerfið sér um afganginn.

Reiknað er tillit til:

- opnunartíma, þar með talið hádegishlés (tveir gluggar á sama degi)
- vinnutíma einstakra starfsmanna, sem takmarkast alltaf við opnunartíma stofunnar
- fría og sumarleyfa, bæði fyrir stofuna og einstaka starfsmenn
- **íslenskra lögbundinna frídaga**, reiknaðra en ekki uppflettra — þar með
  taldir páskatengdir dagar, sumardagurinn fyrsti (fyrsti fimmtudagur eftir 18.
  apríl) og frídagur verslunarmanna. Aðfangadagur og gamlársdagur stytta
  opnunartímann í hádegi
- biðtíma fyrir og eftir þjónustu (þrif, frágangur)
- lágmarksfyrirvara og hámarks bókunartíma fram í tímann
- upptekins tíma úr Google-dagatali starfsmanna

Tvíbókun er útilokuð: tíminn er staðfestur aftur innan sömu færslu og bókunin er
skrifuð, svo tveir sem smella á sama tímann á sama augnabliki geta ekki báðir
fengið hann.

---

## Tengingar

Allar tengingar eru settar upp á **`/stillingar`** í stjórnborðinu. Þar er
hverri þjónustu lýst, uppsetningarskrefin standa við hliðina á reitunum sem þau
skila, og staðan sést strax.

Ekkert þarf að setja í skrár. Gildin eru geymd í gagnagrunninum, leyndarmál
dulkóðuð með AES-256-GCM, og breytingar taka gildi án endurræsingar.

| Þjónusta | Til hvers | Vantar hana? |
| --- | --- | --- |
| Google Calendar | Bókanir í dagatal, einkatímar loka á bókanir | Bókanir virka, engin samstilling |
| SMTP | Staðfestingar, áminningar, skilaboð úr símsvara | Póstar skráðir í þurrkeyrslu |
| Twilio | Símsvörun og SMS | Símsvörun óvirk, SMS í þurrkeyrslu |
| Expo | Tilkynningar í app | Tilkynningar skráðar en ekki sendar |
| Anthropic | Tillögur og textagerð | Tilbúnar tillögur notaðar |

Umhverfisbreytur virka áfram fyrir hýsingu (sjá `.env.example`). Gildi sem er
slegið inn í stjórnborðinu hefur forgang — sá sem fyllir út reit býst við að
það gildi, ekki að breyta sem var sett fyrir mánuðum síðan yfirtaki það.

### Í hvaða röð borgar sig að tengja

1. **Ekkert** — kerfið er fullnothæft í þurrkeyrslu. Prófaðu allt bókunarferlið fyrst.
2. **SMTP** — mest virði fyrir minnsta fyrirhöfn. Staðfestingar og áminningar
   fara að berast. Gmail app-lykilorð tekur fimm mínútur.
3. **Google Calendar** — næst mest virði. Krefst OAuth-uppsetningar í Google
   Cloud Console, um fimmtán mínútur, gert einu sinni fyrir alla viðskiptavini.
4. **Anthropic** — ein lína, ef þú vilt tillögur fyrir naglastofur og hárgreiðslu.
5. **Twilio** — flóknast, því vefkrókar þurfa að ná í vélina utan frá. Skildu
   það eftir þar til hitt er komið í gagnið.

### Tölvupóstur á eigin léni

Kerfið getur ekki stofnað Google Workspace eða Proton reikning fyrir þig — það
krefst manneskju sem samþykkir skilmála og borgar. Það sem það gerir er að
fjarlægja alla hina fyrirhöfnina:

1. Býr til **nákvæmar DNS-færslur** fyrir Google Workspace eða Proton — MX, SPF,
   DKIM og DMARC, með réttum gildum fyrir lénið.
2. Merkir sérstaklega þær færslur sem **þjónustuaðilinn verður að gefa upp**
   (DKIM-lyklar, staðfestingarkóðar) svo þú vitir hverju þú átt að leita að.
3. **Athugar færslurnar í beinni** með DNS-uppflettingu og segir þér hver þeirra
   er ekki komin í gildi.

SPF er stillt á `~all` en ekki `-all`: lítil fyrirtæki senda alltaf póst úr
óvæntum áttum (bókhaldskerfi, vefform) og hörð höfnun eyðir slíkum póstum
þegjandi. DMARC er `quarantine`, sem gefur öryggið án þess að henda pósti.

### Þegar prófunarpóstur mistekst

Undir **Stillingar → Tengingar** er hnappurinn *Senda prófunarpóst*. Mistakist
sendingin birtist niðurstaðan á sömu síðu: hvað þarf að laga, og undir
*Svar þjónsins* nákvæmlega það sem póstþjónninn sagði.

Langalgengasta orsökin er Gmail. Google hafnar venjulegu lykilorði reikningsins
fyrir SMTP og svarar `535 5.7.8 Username and Password not accepted`. Lausnin er
alltaf sú sama:

1. Kveiktu á **tveggja þátta auðkenningu** á Google-reikningnum — app-lykilorð
   eru ekki í boði án hennar.
2. Farðu á [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   og búðu til nýtt app-lykilorð.
3. Límdu 16 stafa lykilorðið í **Lykilorð**, með fullt netfang í
   **Notandanafn** og sama netfang í **Sendandanetfang**.

Hinar villurnar sem kerfið þekkir og gefur ráð við: lokað port eða eldveggur
(`ETIMEDOUT`), rangt stafað þjónsheiti (`ENOTFOUND`), Proton Bridge ekki í gangi
(`ECONNREFUSED`), TLS-stilling sem passar ekki við portið (465 vill *TLS strax*,
587 vill STARTTLS), og sendandanetfang sem þjónninn leyfir ekki (`550`).

### Símsvörun

Símsvarinn talar íslensku með Polly-röddinni **Dóru** (Twilio velur annars
enskumælandi rödd sem les íslenskan texta — ónothæft).

Hann tekur bæði við tökkum og tali, býður að bóka tíma, les upp opnunartíma,
gefur samband við starfsmann og tekur skilaboð utan opnunartíma. Umritun
skilaboða berst í tölvupósti og sem tilkynning í appið.

Ef eitthvað klikkar — óþekkt viðskiptavinur, villa í kerfinu, ekkert svar —
endar símtalið alltaf á skiljanlegri íslenskri setningu og skilaboðum, aldrei á
enskri villutilkynningu frá Twilio.

---

## Uppbygging

```
src/
├── core/            Grunnur: gagnagrunnur, tími, íslenskar reglur, dulkóðun
│   ├── db.ts            node:sqlite með færslum og skemafærslum
│   ├── time.ts          Tímabelti, íslensk dagsetningarsnið
│   ├── iceland.ts       Kennitölur, símanúmer, krónur, póstnúmer
│   ├── holidays.ts      Lögbundnir frídagar, reiknaðir
│   ├── intervals.ts     Tímabilareikningur — undirstaða bókanavélarinnar
│   └── html.ts          Sjálfvirk vörn gegn XSS
├── domain/          Viðskiptareglur, engin ytri köll
│   ├── booking/         Bókanavélin og lífsferill bókana
│   ├── intake/          Spurningaflæði eftir fagi
│   ├── industries.ts    Forstillingar: þjónustur, verð, opnunartími
│   └── provisioning.ts  Uppsetningarferlið
├── integrations/    Allt sem talar við umheiminn
│   ├── google/          OAuth og dagatalssamstilling
│   ├── email/           SMTP-biðlari, sniðmát, DNS-uppsetning
│   ├── voice/           TwiML og símsvari
│   ├── push/            Tækjapörun og Expo-tilkynningar
│   └── subscribers.ts   Tengir atburði við hliðarverkanir
├── website/         Vefsíðugerð og útlitsútgáfur
├── admin/           Stjórnborðið
├── publicapi/       Bókunarviðmót vefsíðna
└── mobileapi/       Viðmót snjallsímaappsins

src/desktop/         Ræsing sem skjáborðsforrit (gagnamappa, port, vafri)
build/make-exe.mjs   Smíðar keyrsluskrá: esbuild → SEA-blob → Node-keyrslu

mobile/              Expo-app fyrir iOS og Android
tests/               139 prófanir
```

### Engar keyrsluháðar einingar

Kerfið hefur **engar `dependencies`** — aðeins TypeScript til þýðingar.
Gagnagrunnurinn er innbyggða SQLite-eining Node, vefþjónninn er `node:http`,
SMTP-biðlarinn er skrifaður beint ofan á `node:net`/`node:tls`.

Þetta er meðvituð ákvörðun fyrir kerfi sem einn maður rekur: ekkert
`npm audit`-viðhald, engar einingar sem hætta að virka, og uppsetningin er
`git clone` og `npm install` sem sækir eina einingu.

### Prófanir

```bash
npm test
```

139 prófanir: bókanavélin (biðtímar, hlé, frídagar, afkastageta, tvíbókun),
spurningaflæðin (allar greinar bílaverkstæðisins), íslenskar reglur (kennitölur,
símanúmer, krónur), tímabeltisumreikningur, SMTP-skeytasmíði, og prófun frá enda
til enda sem ræsir raunverulegan vefþjón og fer í gegnum allt ferlið:
innskráning → uppsetningarhjálp → vefsíðuval → birting → bókun með greinóttu
flæði → afkastageta → afbókun.

---

## Rekstur

```bash
npm run build      # þýðir í dist/
npm start          # keyrir dist/index.js
```

Í rekstri þarf:

- `APP_SECRET` (annars neitar kerfið að ræsa)
- `BASE_URL` með `https://` (session-kökur eru merktar `Secure`)
- Afrit af `data/rafraen.sqlite` — allt kerfið er í þeirri einu skrá

Bakgrunnsverk sér um áminningar, dagatalssamstillingu og tiltekt. Það keyrir
innan sama ferlis; ekkert þarf að setja upp sérstaklega.

### Öryggi

- Lykilorð eru geymd með scrypt; setur eru geymdar sem HMAC, aldrei í hráu formi
- Aðgangslyklar þriðja aðila eru dulkóðaðir með AES-256-GCM áður en þeir fara í
  gagnagrunninn
- CSRF-vörn á öllum aðgerðum, ásamt `SameSite`-kökum og uppruna-athugun
- Innskráningartilraunir eru takmarkaðar bæði eftir IP-tölu og reikningi
- Twilio-vefkrókar eru undirskriftarstaðfestir — símsvarinn getur stofnað
  bókanir, svo óstaðfest slóð væri opin fyrir misnotkun
- Allur texti frá viðskiptavinum er sjálfkrafa varinn gegn XSS í gegnum
  `html`-sniðmátið

---

## English summary

**Rafræn Þjónusta** is a single-operator control plane for providing digital
services to small Icelandic businesses: generated websites, booking systems,
email provisioning and an Icelandic-speaking phone receptionist.

You enter a company name, pick a trade, tick the features you want, and the
system creates a service catalogue with realistic prices, opening hours, three
complete website designs to choose between, a trade-specific branching intake
questionnaire, and a checklist containing exactly the values needed for the
manual steps (DNS records, webhook URLs, pairing codes).

The interface and all customer-facing output are in Icelandic, because that is
who it serves. The code and comments are in English.

Notable properties:

- **Zero runtime dependencies.** Node's built-in SQLite, `node:http`, and an
  SMTP client written directly on `node:net`/`node:tls`.
- **Everything degrades gracefully.** Missing credentials put an integration in
  dry-run mode rather than breaking the platform, so the whole system is usable
  before any external account exists.
- **Icelandic domain rules are implemented properly** — kennitala checksums,
  +354 phone classification, ISK/VSK handling, and public holidays computed
  (including Easter-derived dates, sumardagurinn fyrsti and frídagur
  verslunarmanna) rather than hard-coded.
- **139 tests**, including an end-to-end run against a real HTTP server.

See `.env.example` for configuration and `mobile/README.md` for the phone app.
