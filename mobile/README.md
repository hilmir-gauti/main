# Rafræn Þjónusta — app fyrir eigendur

Snjallsímaapp fyrir viðskiptavini Rafrænnar Þjónustu. Sama kóðagrunn keyrir bæði
á iOS og Android í gegnum Expo.

## Hvað appið gerir

- **Pörun með kóða** — eigandinn slær inn sex stafa kóða úr stjórnborðinu, ekkert
  lykilorð og enginn aðgangur að öðrum viðskiptavinum.
- **Dagbók dagsins** — bókanir dagsins með tíma, viðskiptavini og þjónustu.
- **Svör úr bókunarferlinu** — bílnúmer, einkenni, óskir um útlit og annað sem
  viðskiptavinurinn svaraði þegar hann bókaði. Þetta er ástæðan fyrir því að
  appið nýtist á gólfinu: bifvélavirkinn sér númerið og einkennin áður en bíllinn
  mætir.
- **Tilkynningar** — ýtitilkynning um leið og bókun berst, hvort sem hún kom af
  vefsíðunni eða úr símsvaranum.
- **Aðgerðir** — staðfesta, merkja mætt, ljúka, afbóka og hringja í viðskiptavin.

## Uppsetning

```bash
cd mobile
npm install
```

Stilltu slóðina á þjóninn í `app.json`:

```json
"extra": { "apiBase": "https://stjornbord.mitt-len.is" }
```

Keyrðu svo:

```bash
npx expo start
```

Skannaðu QR-kóðann með Expo Go til að prófa á síma.

## Útgáfa í App Store og Google Play

Ýtitilkynningar krefjast raunverulegrar smíði (ekki Expo Go):

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build --platform ios
eas build --platform android
```

`eas build:configure` býr til `projectId` sem Expo notar til að beina
tilkynningum á rétt tæki. Þjónninn sendir í gegnum Expo Push API, svo ekki þarf
að setja upp APNs-skilríki eða FCM-lykla handvirkt.

## Vefútgáfa

Ef eigandinn vill ekki setja upp app er hægt að keyra sama viðmót í vafra:

```bash
npx expo start --web
```

Þá er `kerfi` skráð sem `vefur` við pörun og tilkynningar fara í tölvupóst í
staðinn.

## Viðmót þjónsins

| Slóð | Aðferð | Lýsing |
| --- | --- | --- |
| `/api/app/para` | POST | Skiptir pörunarkóða út fyrir tækjalykil |
| `/api/app/yfirlit` | GET | Bókanir dagsins og lykiltölur |
| `/api/app/dagur/:dagsetning` | GET | Bókanir tiltekins dags |
| `/api/app/framundan` | GET | Næstu bókanir |
| `/api/app/bokun/:id` | POST | Staðfesta, mætt, lokið, mætti ekki, afboka |
| `/api/app/tilkynningar` | POST | Uppfærir push-lykil eftir enduruppsetningu |

Allar slóðir nema `/api/app/para` krefjast `Authorization: Bearer <tækjalykill>`.
Lykillinn er bundinn við eitt fyrirtæki og veitir engan annan aðgang.
