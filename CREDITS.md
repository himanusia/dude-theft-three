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
