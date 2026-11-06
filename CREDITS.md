# Credits & asset licences

## 3D content
All meshes, materials, and textures in this project are generated procedurally at runtime
(`src/city.js`, `src/character.js`, `src/car.js`, `src/ragdoll.js`, `src/utils.js`).
No third-party models or image files are used.

## Creative Commons Zero 1.0 (CC0 1.0 — Public Domain)

### Kenney Sound Effects
Downloaded from kenney.nl, CC0 1.0 Universal:

- *Impact Sounds* — punches, bodyfalls, footsteps, metal/glass hits, crash
- *Digital Audio* — pistol shot, pickup, UI click
- *Sci-Fi Sounds* — engine loop, explosion, rifle shot

Files: `audio/sfx/*.ogg`

### Ambience & Street Sound Effects (Indonesian Setting)
Downloaded from Wikimedia Commons / PDSounds, dedicated to the Public Domain under Creative Commons CC0 1.0 Universal or Public Domain:

- *Restaurant Ambience* (`audio/ambience/warung-ambience.ogg`) by stephan (PDSounds / Wikimedia Commons) — warung & roadside eatery dining chatter, tableware
- *Le marché d'Aligre* (`audio/ambience/pasar-market-ambience.ogg`) by aldor (PDSounds / Wikimedia Commons) — traditional street market / pasar vendor calls & crowd
- *Sunday in the city street noise1* (`audio/ambience/city-crowd-ambience.ogg`) by cori (PDSounds / Wikimedia Commons) — city street crowd murmur & urban pedestrian sounds
- *Moped driving by* (`audio/ambience/moped-passby.ogg`) by stephan (PDSounds / Wikimedia Commons) — moped & scooter pass-by sound
- *The horn of a Bluebird railcar* (`audio/ambience/moped-horn.ogg`) by NIRVAAN222222 (Wikimedia Commons) — moped / scooter squeaker horn
- *Car Horn* (`audio/ambience/angkot-horn.ogg`) by 15HPanska_Ruttner_Jan (Wikimedia Commons) — angkot minivan & vehicle horn
- *Bicycle-bell-1* (`audio/ambience/pedal-bell.ogg`) by Soundscape_Leuphana (Wikimedia Commons) — street hawker / bicycle bell
- *Rain (1)* (`audio/ambience/tropical-rain.ogg`) by ezwa (PDSounds / Wikimedia Commons) — tropical heavy rain downpour
- *Gamelan Pelog Kinanti madumurti (1931)* (`audio/ambience/gamelan-menu-loop.ogg`) published by Odeon Records (Wikimedia Commons) — traditional Indonesian gamelan musical recording (Public Domain)

License: Creative Commons CC0 1.0 Universal Public Domain Dedication (http://creativecommons.org/publicdomain/zero/1.0/) / Public Domain.
Files: `audio/ambience/*.ogg`

## Creative Commons Attribution 4.0 (CC BY 4.0)

### Music — Kevin MacLeod
- "Funkorama" — free-roam theme (`audio/bgm/funk.mp3`)
- "Killers" — wanted-level theme (`audio/bgm/chase.mp3`), tense pursuit cue
- "Wallpaper" — unused variant ready for menus (`audio/bgm/calm.mp3`)

Source: incompetech.com. Licensed under Creative Commons Attribution 4.0 International.
Attribution text (keep this if you redistribute):

> "Funkorama", "Killers", "Wallpaper" — Kevin MacLeod (incompetech.com), CC BY 4.0
> Licensed under Creative Commons: By Attribution 4.0 License
> http://creativecommons.org/licenses/by/4.0/

Files: `audio/bgm/*.mp3`

## Synthesized
Police siren and tyre screech are generated with the WebAudio API at runtime (no file).

## Trademark note
This is a non-commercial fan prototype inspired by *Dude Theft Wars* (Poxel Studios).
It is not affiliated with, endorsed by, or distributed by Poxel Studios.

## Reference photography (shape study, not shipped)

- **Angkot body** — modelled after photos of a Suzuki Carry minibus conversion on Wikimedia
  Commons, *New Suzuki Carry angkot karoseri Panca Tunggal* by Haysnawri10, CC BY-SA 4.0
  (https://commons.wikimedia.org/wiki/File:New_Suzuki_Carry_angkot_karoseri_Panca_Tunggal.jpg)
  and *Mikrotrans* by Baqotun0023, CC BY-SA 4.0
  (https://commons.wikimedia.org/wiki/File:Mikrotrans.jpg). Used to match the one-box body,
  short nose, raked windscreen, three-window glass band, sliding door and running board.
  The 3D geometry is generated in code; no photograph is redistributed.

- **Glodok gateway** — modelled from *Gateway to Glodok Chinatown, Jakarta* (Wikimedia Commons,
  CC BY-SA 3.0) for the paifang structure, grey pillars, terracotta roof and three signboards.
- **Ancol waterfront** — modelled from *Ancol Beach, Jakarta, Indonesia* (Wikimedia Commons,
  CC BY-SA 4.0) for the sand strip, calm water, timber pier on pilings, tall mast and the
  yellow/blue feather flags.

## Reference photography — TransJakarta bus and halte

Studied for the procedural models in `src/vehicles/transjakarta.ts` and `src/world/halte.ts`.
Local copies sit in `reference/assets/` at reduced resolution — `reference/` is gitignored, so the
photographs are not redistributed with the repository or the build.

- **TransJakarta articulated bus** — *Harmoni Central Busway Transjakarta 1.JPG* by
  Gunawan Kartapranata, Wikimedia Commons, **CC BY-SA 4.0**
  (https://commons.wikimedia.org/wiki/File:Harmoni_Central_Busway_Transjakarta_1.JPG),
  file `reference/assets/transjakarta-articulated-harmoni.jpg`. Used for the red body, the
  unbroken dark window band, the bellows, the three-axle layout, the roof AC pod and the white
  "transjakarta" script.
- **Bus nose / halte** — *Transjakarta Articulated Bus Halte Rawasari 1.JPG* by Gunawan
  Kartapranata, Wikimedia Commons, **CC BY-SA 4.0**
  (https://commons.wikimedia.org/wiki/File:Transjakarta_Articulated_Bus_Halte_Rawasari_1.JPG),
  file `reference/assets/transjakarta-halte-rawasari.jpg`. Used for the windscreen rake, the
  twin wipers, the front valance and plate, and the shelter's platform edge and roof overhang.
- **Halte interior** — *Platform of the Bundaran HI Transjakarta BRT Station.jpg* by
  RasyaAbhirama13, Wikimedia Commons, **CC BY-SA 3.0**
  (https://commons.wikimedia.org/wiki/File:Platform_of_the_Bundaran_HI_Transjakarta_BRT_Station.jpg),
  file `reference/assets/transjakarta-halte-platform.jpg`. Used for the bench against the glass,
  the queue rail, the route board and the ceiling.

All three are licensed CC BY-SA; the derived 3D geometry is original code and the photographs
are not redistributed with the build. The red steel shelter frame follows the older TransJakarta
palette (and the brief) — the stations in the photographs are grey/blue.

## 3D models

- **Cars** — Kenney Car Kit (CC0 1.0, kenney.nl): `sedan`, `sedan-sports`, `taxi`, `police`, `van`,
  `suv`. Licence text ships with the models in `public/models/cars/KENNEY-LICENSE.txt`. Scaled to
  the game's own car dimensions at load time; the angkot stays a custom body built from the
  reference photographs below.

## Reference photography — street kit (`src/world/streetkit.ts`)

Studied before modelling each part; local copies sit in `reference/assets/` at web resolution.
`reference/` is gitignored, so none of these photographs are redistributed with the repository or the
build. Every 3D mesh is original code.

- `reference/assets/street-ref-1.jpg` — *Marka Jalan Garis Putih Di Jalan Arumbinang Kebumen* by
  **DARMAS BS 9**, Wikimedia Commons, **CC BY-SA 4.0**
  (https://commons.wikimedia.org/wiki/File:Marka_Jalan_Garis_Putih_Di_Jalan_Arumbinang_Kebumen.jpg).
  Drove `buildRoadSegment`: white (not yellow) dashed centre line roughly 10-12 cm wide with a 3 m
  dash / 5 m gap, no painted edge line on a kampung street, matt dark asphalt.
  Comparison: `screenshots/proof/streetkit-road-compare.png`.
- `reference/assets/street-ref-2.jpg` — *JalanJenderalSudirmanJakarta* by **Sanko**, Wikimedia
  Commons, **CC BY-SA 3.0**
  (https://commons.wikimedia.org/wiki/File:JalanJenderalSudirmanJakarta.jpg).
  Drove the 20 m arterial layout: raised kerbed median with planting, white edge lines and lane
  dividers, and the red-block trotoar beside it.
  Comparison: `screenshots/proof/streetkit-road-arterial-compare.png`.
- `reference/assets/street-ref-3.jpg` — *Pejalan Kaki di Trotoar*, **Government of Indonesia**,
  Wikimedia Commons, **public domain**
  (https://commons.wikimedia.org/wiki/File:Pejalan_Kaki_di_Trotoar.jpg).
  Drove `buildKerbWalk`: long rectangular pavers laid in bands, a yellow tactile strip about 0.3-0.4 m
  wide through the walk, and a narrow linear drain channel at the planter edge.
  Comparison: `screenshots/proof/streetkit-kerb-compare.png`.
- `reference/assets/street-ref-4.jpg` — *Lemabang Intersection - Palembang, SS (24 April 2023)* by
  **Firzafp**, Wikimedia Commons, **CC BY-SA 4.0**
  (https://commons.wikimedia.org/wiki/File:Lemabang_Intersection_-_Palembang,_SS_(24_April_2023).jpg).
  Drove `buildSignalIntersection`: four arms, a wide kerb return at each corner, longitudinal zebra
  stripes, a white stop line, a black-and-yellow striped pole base, and controller cabinets on a
  plinth on the pavement.
  Comparison: `screenshots/proof/streetkit-junction-compare.png`.
- `reference/assets/street-ref-5.jpg` — *Lampu Lalu Lintas Atau Lampu Apill Sesuai Fungsinya* by
  **SATELITBM**, Wikimedia Commons, **CC BY-SA 4.0**
  (https://commons.wikimedia.org/wiki/File:Lampu_Lalu_Lintas_Atau_Lampu_Apill_Sesuai_Fungsinya.jpg).
  Drove `buildTrafficLight`: slim tubular cantilever mast arm, a vertical three-aspect head (red,
  amber, green) hung under the arm with short hoods, and roughly 6 m to the head.
  Comparison: `screenshots/proof/streetkit-signal-compare.png`.
- `reference/assets/street-ref-6.jpg` — *A utility pole in a street in Klaten* by **NawanP**,
  Wikimedia Commons, **CC BY 4.0**
  (https://commons.wikimedia.org/wiki/File:A_utility_pole_in_a_street_in_Klaten.jpg).
  Drove `buildUtilityPole`: tapered concrete pole, steel crossarm with ribbed porcelain insulators,
  a pole-mounted transformer on a bracket, and slack catenary jumper leads (8-10 cable runs).
  Comparison: `screenshots/proof/streetkit-furniture-compare.png`.

Street name blades in the kit are plesetan (`JL. TAMRIN RAYA`, `GANG KELINCI`), like every other sign
in this city; no real street name is reproduced.

## Reference photography (compared side by side, not redistributed as texture)

- `reference/assets/pospolisi-ref-1.jpg` — *Pos Polisi Alun-alun Jombang* by Wikimedia Commons
  contributor, **CC BY 4.0**. Used to model `src/world/pospolisi.ts`
  (blue sign board over a blue booth, white office with terracotta roof, bollards).
  Comparison: `screenshots/proof/pospolisi-compare.png`.

- `reference/assets/padang-ref-0.jpg` — *Rumah Makan Padang Sederhana*, panoramio, Wikimedia Commons,
  **CC BY 3.0**. Used to model `src/world/rumahpadang.ts` (gonjong roof, carved band, glazed
  upper facade, red name plate). Comparison: `screenshots/proof/padang-compare.png`.

- `reference/assets/ruko-ref-0.jpg` — *Komplek Pertokoan Jalan Pekiringan, Kota Cirebon*, Wikimedia
  Commons, **CC BY-SA 4.0**. Used for the ground-floor shop-row texture in `src/world/city.ts`
  (banner fascias, striped awnings, mixed shutters and lit glazing, air-con units, kerb grime).
  Comparison: `screenshots/proof/ruko-compare.png`.

- `reference/assets/masjid-ref-0.jpg` — *Masjid Al-Istiqomah, Kampung Melayu*, panoramio/Wikimedia
  Commons, **CC BY 3.0**. Used to model `src/world/masjid.ts`: timber fascia bands, white balcony
  railing, tall dark glazing, pointed arch over the entrance, stone steps, green side gate.
  Comparison: `screenshots/proof/masjid-compare.png`.

- `reference/assets/pasar-ref-0.jpg` — *Traditional market of Kalibaru Wetan, Banyuwangi*, Wikimedia
  Commons, **CC BY-SA 4.0**. Used to model `src/world/pasar.ts`: exposed timber trusses under a zinc
  roof, green directional board with red arrows, yellow banner, trestle stall tables, plastic stools.
  Comparison: `screenshots/proof/pasar-compare.png`.

- `reference/assets/terminal-ref-0.jpg` — *Jalur keberangkatan Terminal Senen, 2023.jpg* by Naufal P,
  Wikimedia Commons, **CC BY-SA 4.0**
  (https://commons.wikimedia.org/wiki/File:Jalur_keberangkatan_Terminal_Senen,_2023.jpg).
  Working copy of `terminal-senen-lanes.jpg` from Asset Pack 2. Used to model `src/world/terminal.ts`:
  the wide bare concrete apron and its expansion joints, the grey steel lattice gantry spanning every
  departure bay, the low kerbed boarding platform, the plastic water barriers between bays, and a blue
  city bus with a white/blue angkot berthed nose-in beside it. No photograph is redistributed with the
  build; the geometry and every sign texture are generated in code, and the operator name is a plesetan.
  Comparison: `screenshots/proof/terminal-compare.png`.

### Asset Pack 2 — Jakarta Urban Asset Expansion (`docs/reference-packs/asset-pack-2.md`)

- `reference/assets/masjid-al-musyawarah-01.jpg` — *Masjid Al-Musyawarah Kelapa Gading (Desember 2024) 01.jpg* by Fasyakamil, Wikimedia Commons, **CC BY-SA 4.0** (https://commons.wikimedia.org/wiki/File:Masjid_Al-Musyawarah_Kelapa_Gading_(Desember_2024)_01.jpg). Used for contemporary Jakarta neighbourhood mosque elevation, turquoise dome, and minaret.
- `reference/assets/masjid-al-musyawarah-02.jpg` — *Masjid Al-Musyawarah Kelapa Gading (Desember 2024) 02.jpg* by Fasyakamil, Wikimedia Commons, **CC BY-SA 4.0** (https://commons.wikimedia.org/wiki/File:Masjid_Al-Musyawarah_Kelapa_Gading_(Desember_2024)_02.jpg). Used for courtyard plaza paving, boundary wall railings, and shaded entry arcade.
- `reference/assets/pasar-klender-facade.jpg` — *PasarKlender1.jpg* by Midori, Wikimedia Commons, **CC BY-SA 3.0** (https://commons.wikimedia.org/wiki/File:PasarKlender1.jpg). Used for traditional municipal market hall facade, PD Pasar Jaya signage, clerestory ventilation roof, and ground-floor rolling door kiosks.
- `reference/assets/pasar-klender-interior.jpg` — *PasarKlender5.jpg* by Midori, Wikimedia Commons, **CC BY-SA 3.0** (https://commons.wikimedia.org/wiki/File:PasarKlender5.jpg). Used for interior market stalls (*los pasar*), tiled display benches, pedestrian aisles, overhead trusses, and hanging tarpaulins.
- `reference/assets/terminal-senen-lanes.jpg` — *Jalur keberangkatan Terminal Senen, 2023.jpg* by Naufal P, Wikimedia Commons, **CC BY-SA 4.0** (https://commons.wikimedia.org/wiki/File:Jalur_keberangkatan_Terminal_Senen,_2023.jpg). Used for bus terminal departure lanes, raised passenger boarding islands with hazard stripes, queue railings, and cantilevered canopy.
- `reference/assets/terminal-senen-shelter.jpg` — *Metrotrans and Mikrotrans in Senen bus station, 2023.jpg* by Naufal P, Wikimedia Commons, **CC BY-SA 4.0** (https://commons.wikimedia.org/wiki/File:Metrotrans_and_Mikrotrans_in_Senen_bus_station,_2023.jpg). Used for modern transit shelter bay, orange TransJakarta Metrotrans low-floor bus, and cyan JakLingko Mikrotrans angkot minivan.
- `reference/assets/kurir-delivery-01.jpg` — *Grab Delivery 1.jpg* by Waqas1000000000, Wikimedia Commons, **CC BY-SA 4.0** (https://commons.wikimedia.org/wiki/File:Grab_Delivery_1.jpg). Used for app-based motorbike delivery courier, green insulated cargo box, reflective rider jacket, and handlebar phone mount.
- `reference/assets/kurir-delivery-02.jpg` — *Grab Delivery 2.jpg* by Waqas1000000000, Wikimedia Commons, **CC BY-SA 4.0** (https://commons.wikimedia.org/wiki/File:Grab_Delivery_2.jpg). Used for delivery box rear mounting rigging, tie-down bungee straps, Indonesian license plate, and rear moped ergonomics.
- `reference/assets/pos-ronda-01.jpg` — *Pos Ronda Geneng, Jombang-3.jpg* by Indonesiagood, Wikimedia Commons, **CC BY 4.0** (https://commons.wikimedia.org/wiki/File:Pos_Ronda_Geneng,_Jombang-3.jpg). Used for neighbourhood security post (*pos ronda* / *gardu siskamling*), limasan roof, perimeter bench seating, hanging bamboo *kentongan*, and civic plinth.

- `reference/assets/ronda-ref-0.jpg` — *Pos Ronda Geneng, Jombang*, Wikimedia Commons, **CC BY 4.0**.
  Used to model `src/world/ronda.ts`: maroon steel posts, zinc roof with a dark red fascia, raised
  concrete platform, bunk with bolster, yellow RT/RW notice, blue-and-white kerb blocks.
  Comparison: `screenshots/proof/ronda-compare.png`.

## Reference photography — kaki lima carts (`src/world/kakilima.ts`)

No cart photograph is redistributed with the build: every panel, spoke and sign texture is generated
in code, and the names are plesetan. The two photographs below were used as a shape study only, and
they live in the gitignored `reference/` tree.

- `reference/assets/kakilima-jakarta-01.jpg` — *Kakilima street vendors in Jakarta.jpg* by Gunawan
  Kartapranata, Wikimedia Commons, **CC BY-SA 3.0**
  (https://commons.wikimedia.org/wiki/File:Kakilima_street_vendors_in_Jakarta.jpg).
  Used for: the two-wheel proportions (0.66–0.70 m spoked wheels with a black pneumatic tyre, steel
  rim and hub, axle ~0.33 m up), wheels mounted outboard of the cabinet, the timber/cabinet body with
  a painted lower band, the rectangular tarp awning on posts, and the straight push bar at waist
  height.
- `reference/assets/bakso-vendor-01.jpg` — *Tukang Bakso.jpg* by Agustinusraharjo, Wikimedia Commons,
  **CC BY-SA 4.0** (https://commons.wikimedia.org/wiki/File:Tukang_Bakso.jpg).
  Used for: the axle sitting ~75% of the body length from the vendor's end, the pair of braced legs
  under that end, the tubular two-arm push handle projecting ~0.3 m past the rear face, and the
  glassed display case over the cooking surface.

Frame study: `screenshots/proof/gerobak-bakso.png`, `gerobak-nasgor.png`, `gerobak-sate.png`
(camera framing and measurements in `screenshots/proof/gerobak-framing.json`).
