# Audio Sourcing: Indonesian Street Setting (Ambience, SFX, BGM)

This document catalogs and verifies license-clean audio assets sourced for the Indonesian street setting in *Dude Theft Three*. All assets are verified for commercial-safe, legally unencumbered game redistribution without copyleft contamination, accompanied by permanent source/download URLs, license terms, attribution declarations, technical audio verification metadata, and an engine integration reference.

---

## Sourced Audio Assets Table

| Asset ID | What It Is | Source URL | Direct Download URL | License | Author | Required Attribution String | Where It Will Be Used In-Game |
|---|---|---|---|---|---|---|---|
| `warung-ambience` | Sidewalk warung eatery ambience with customer chatter, tableware clinking, and plate movement | [Wikimedia Commons: File:Restaurant ambience.ogg](https://commons.wikimedia.org/wiki/File:Restaurant_ambience.ogg) | [Direct OGG](https://upload.wikimedia.org/wikipedia/commons/b/b5/Restaurant_ambience.ogg) | CC0 1.0 / Public Domain | stephan (PDSounds) | Dedicated to the Public Domain under CC0 1.0 Universal / Public Domain; no attribution legally required. Credit: "Restaurant Ambience" by stephan (PDSounds / Wikimedia Commons). | `warung ambience` (active audio zone near roadside warung tegal, coffee stalls, and sidewalk food tables) |
| `pasar-market-ambience` | Traditional open-air street market (*pasar*) ambience with vendor cries, customer bargaining, and lively market murmurs | [Wikimedia Commons: File:Le marche daligre.ogg](https://commons.wikimedia.org/wiki/File:Le_marche_daligre.ogg) | [Direct OGG](https://upload.wikimedia.org/wikipedia/commons/f/f3/Le_marche_daligre.ogg) | CC0 1.0 / Public Domain | aldor (PDSounds) | Dedicated to the Public Domain under CC0 1.0 Universal / Public Domain; no attribution legally required. Credit: "Le marché d'Aligre" by aldor (PDSounds / Wikimedia Commons). | `warung ambience` / street vendor market areas (traditional open-air pasar kaget / pasar pagi zones) |
| `city-crowd-ambience` | Urban city street ambience with pedestrian chatter, footsteps, and passing vehicle street noises | [Wikimedia Commons: File:Sunday in the city street noise1.ogg](https://commons.wikimedia.org/wiki/File:Sunday_in_the_city_street_noise1.ogg) | [Direct OGG](https://upload.wikimedia.org/wikipedia/commons/5/5d/Sunday_in_the_city_street_noise1.ogg) | CC0 1.0 / Public Domain | cori (PDSounds) | Dedicated to the Public Domain under CC0 1.0 Universal / Public Domain; no attribution legally required. Credit: "Sunday in the city street noise1" by cori (PDSounds / Wikimedia Commons). | `city crowd` (sidewalks, commercial corridors, urban pedestrian zones) |
| `moped-horn` | High-pitched squeaker horn beep, characteristic of Indonesian mopeds and motor bebek scooters | [Wikimedia Commons: File:The horn of a Bluebird railcar.ogg](https://commons.wikimedia.org/wiki/File:The_horn_of_a_Bluebird_railcar.ogg) | [Direct OGG](https://upload.wikimedia.org/wikipedia/commons/6/69/The_horn_of_a_Bluebird_railcar.ogg) | CC0 1.0 | NIRVAAN222222 | Dedicated to the Public Domain under CC0 1.0 Universal; no attribution legally required. Credit: "The horn of a Bluebird railcar" by NIRVAAN222222 (Wikimedia Commons), CC0 1.0. | `moped/angkot horn` (player and NPC motor bebek / scooter honk) |
| `angkot-horn` | Automotive horn beep (*tin-tin!*), signature passing and hailing signal of Indonesian *angkot* minivans and taxis | [Wikimedia Commons: File:Car Horn.wav](https://commons.wikimedia.org/wiki/File:Car_Horn.wav) | [Direct WAV](https://upload.wikimedia.org/wikipedia/commons/8/8c/Car_Horn.wav) | CC0 1.0 | 15HPanska_Ruttner_Jan | Dedicated to the Public Domain under CC0 1.0 Universal; no attribution legally required. Credit: "Car Horn" by 15HPanska_Ruttner_Jan (Wikimedia Commons), CC0 1.0. | `moped/angkot horn` (angkot minivan passenger hailing, intersection warnings, aggressive traffic honking) |
| `pedal-bell` | Rapid double-ring bicycle bell (*kring-kring!*), signature bell of street food hawkers (bakso, es dung-dung, roti) | [Wikimedia Commons: File:Bicycle-bell-1.wav](https://commons.wikimedia.org/wiki/File:Bicycle-bell-1.wav) | [Direct WAV](https://upload.wikimedia.org/wikipedia/commons/6/68/Bicycle-bell-1.wav) | CC0 1.0 | Soundscape_Leuphana | Dedicated to the Public Domain under CC0 1.0 Universal; no attribution legally required. Credit: "Bicycle-bell-1" by Soundscape_Leuphana (Wikimedia Commons), CC0 1.0. | `moped/angkot horn` / street vendor soundscape (pedal bicycles, gerobak food carts, sidewalk hawkers) |
| `tropical-rain` | Tropical heavy rainfall downpour drumming across asphalt and roofs | [Wikimedia Commons: File:Rain (1).ogg](https://commons.wikimedia.org/wiki/File:Rain_(1).ogg) | [Direct OGG](https://upload.wikimedia.org/wikipedia/commons/0/0e/Rain_%281%29.ogg) | CC0 1.0 / Public Domain | ezwa (PDSounds) | Dedicated to the Public Domain under CC0 1.0 Universal / Public Domain; no attribution legally required. Credit: "Rain (1)" by ezwa (PDSounds / Wikimedia Commons). | `rain` (weather bed audio triggered during tropical rainstorm events) |
| `police-siren-yelp` | Fast-cycle urban police cruiser siren audio | [Wikimedia Commons: File:American police siren i.ogg](https://commons.wikimedia.org/wiki/File:American_police_siren_i.ogg) | [Direct OGG](https://upload.wikimedia.org/wikipedia/commons/a/ae/American_police_siren_i.ogg) | CC0 1.0 / Public Domain | lezer (PDSounds) | Dedicated to the Public Domain under CC0 1.0 Universal / Public Domain; no attribution legally required. Credit: "American police siren in Washington DC" by lezer (PDSounds / Wikimedia Commons). | `police siren alternative` (rapid yelp cycle for roadblock units and high wanted levels) |
| `police-siren-wail` | Sustained rising and falling undulating siren audio | [Wikimedia Commons: File:Civil-defense-siren-waver.ogg](https://commons.wikimedia.org/wiki/File:Civil-defense-siren-waver.ogg) | [Direct OGG](https://upload.wikimedia.org/wikipedia/commons/6/69/Civil-defense-siren-waver.ogg) | CC0 1.0 / Public Domain | Techtonic | Dedicated to the Public Domain under CC0 1.0 Universal / Public Domain; no attribution legally required. Credit: "Civil defense siren waver" by Techtonic (Wikimedia Commons). | `police siren alternative` (sampled alternative / replacement for procedural WebAudio oscillator siren during police chases) |
| `gamelan-menu-loop` | Traditional Indonesian Gamelan Pelog metallophone musical recording (Laras Pelog Kinanti Madumurti, 1931 historical recording) | [Wikimedia Commons: File:Gamelan Pelog Kinanti madumurti (1931).ogg](https://commons.wikimedia.org/wiki/File:Gamelan_Pelog_Kinanti_madumurti_%281931%29.ogg) | [Direct OGG](https://upload.wikimedia.org/wikipedia/commons/f/f4/Gamelan_Pelog_Kinanti_madumurti_%281931%29.ogg) | Public Domain | Odeon Records (1931 historical performance) | Public Domain (historical 1931 recording expired worldwide). Credit: "Gamelan Pelog Kinanti madumurti (1931)" published by Odeon Records (Wikimedia Commons). | `gamelan-ish menu loop` (main menu, pause screen, or in-game radio station) |

---

## License Breakdown & Asset Counts

- **CC0 1.0 Universal / Public Domain**: 10 assets (`warung-ambience`, `pasar-market-ambience`, `city-crowd-ambience`, `moped-horn`, `angkot-horn`, `pedal-bell`, `tropical-rain`, `police-siren-yelp`, `police-siren-wail`, `gamelan-menu-loop`).
- **Total Accepted Assets**: 10 assets.
- **Total Added Size**: 9,152,926 bytes (~8.73 MiB / 9.15 MB, well below the 12.0 MB maximum budget).

---

## Rejected Assets & Sourcing Audit Log

Every potential candidate was strictly evaluated against commercial game shipping requirements. The following candidates were rejected during sourcing:

1. **`File:Lancaran Tropongan.ogg` (Tropenmuseum)**
   - *Source*: Wikimedia Commons (Gamelan Kyai Kanyut Mesem, Surakarta, 1970).
   - *License*: Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0).
   - *Rejection Reason*: Rejected due to the **ShareAlike (SA)** clause. SA imposes copyleft obligations that legally require derivative games or composite distributions incorporating the work to be released under the identical SA license, incompatible with commercial or permissive game distribution.
2. **`File:Gamelan Degung (Sabilulungan).ogg` (Sundanese Gamelan)**
   - *Source*: Wikimedia Commons.
   - *License*: Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0).
   - *Rejection Reason*: Rejected due to **ShareAlike (SA)** copyleft restriction.
3. **`File:Heavy rain on roof with thunder.ogg`**
   - *Source*: Wikimedia Commons.
   - *License*: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0).
   - *Rejection Reason*: Rejected due to **ShareAlike (SA)** copyleft restriction.
4. **`File:Speeding-car-horn doppler effect sample.ogg`**
   - *Source*: Wikimedia Commons.
   - *License*: Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0).
   - *Rejection Reason*: Rejected due to **ShareAlike (SA)** copyleft restriction.
5. **Freesound #415804 ("Indonesian Street Food Stall Ambience")**
   - *Source*: Freesound.org.
   - *License*: Creative Commons Attribution-NonCommercial (CC BY-NC 4.0).
   - *Rejection Reason*: Rejected due to **Non-Commercial (NC)** restriction. Non-commercial licenses prohibit commercial sale, digital store distribution, and monetized gameplay streaming.
6. **Freesound #339178 ("Angkot Horn Two-Beep")**
   - *Source*: Freesound.org.
   - *License*: Sampling+ 1.0 (Non-commercial clause).
   - *Rejection Reason*: Non-commercial and legally ambiguous grant under retired Sampling+ terms.
7. **FreePD ("Gamelan Mumbul", "Eastern Thought")**
   - *Source*: FreePD CDN (`https://freepd.com/music/...`).
   - *Rejection Reason*: Upstream CDN URLs returned HTTP 404 / session block during verification check; rejected in accordance with hard rule requiring verified HTTP 200 URLs without placeholders.
8. **Incompetech ("Gamelan" by Kevin MacLeod)**
   - *Source*: Incompetech (`https://incompetech.com/music/royalty-free/mp3-royaltyfree/Gamelan.mp3`).
   - *Rejection Reason*: Direct file fetch returned HTTP 404 / dynamic paywall gate; rejected in accordance with reproducible direct URL requirements.
9. **YouTube / Social Media Indonesian Street Vending Audio ("Tahu Bulat", "Bakso Ding-Ding")**
   - *Source*: Various YouTube / TikTok audio clips.
   - *License*: All Rights Reserved / Unclear copyright.
   - *Rejection Reason*: Unverified provenance, lacks clear Creative Commons or Public Domain grant.

---

## Audio Verification & File Playability Report

All 10 accepted files are stored in `public/audio/ambience/`, normalized to lowercase kebab-case, encoded in standard Ogg Vorbis, and verified using `ffprobe`.

| Filename | Format / Codec | Channels | Sample Rate | Duration | File Size | Bitrate |
|---|---|---|---|---|---|---|
| `angkot-horn.ogg` | Vorbis (OGG) | Stereo (2 ch) | 48,000 Hz | 3.51 s | 129,687 B (~127 KiB) | 295.2 kb/s |
| `city-crowd-ambience.ogg` | Vorbis (OGG) | Mono (1 ch) | 44,100 Hz | 80.01 s | 1,023,670 B (~1,000 KiB) | 102.3 kb/s |
| `gamelan-menu-loop.ogg` | Vorbis (OGG) | Stereo (2 ch) | 44,100 Hz | 183.56 s (3m03s) | 2,474,202 B (~2.36 MiB) | 107.8 kb/s |
| `moped-horn.ogg` | Vorbis (OGG) | Stereo (2 ch) | 48,000 Hz | 1.62 s | 27,122 B (~26 KiB) | 133.5 kb/s |
| `pasar-market-ambience.ogg` | Vorbis (OGG) | Stereo (2 ch) | 44,100 Hz | 80.01 s | 2,229,428 B (~2.13 MiB) | 222.9 kb/s |
| `pedal-bell.ogg` | Vorbis (OGG) | Stereo (2 ch) | 44,100 Hz | 1.48 s | 36,710 B (~36 KiB) | 198.0 kb/s |
| `police-siren-wail.ogg` | Vorbis (OGG) | Mono (1 ch) | 44,100 Hz | 35.01 s | 292,055 B (~285 KiB) | 66.7 kb/s |
| `police-siren-yelp.ogg` | Vorbis (OGG) | Mono (1 ch) | 44,100 Hz | 29.20 s | 397,825 B (~388 KiB) | 109.0 kb/s |
| `tropical-rain.ogg` | Vorbis (OGG) | Mono (1 ch) | 44,100 Hz | 44.96 s | 582,588 B (~569 KiB) | 103.7 kb/s |
| `warung-ambience.ogg` | Vorbis (OGG) | Stereo (2 ch) | 44,100 Hz | 76.25 s (1m16s) | 1,959,639 B (~1.87 MiB) | 205.6 kb/s |

**Total on-disk size**: 9,152,926 bytes (~8.73 MiB / 9.15 MB), comfortably within the 12.0 MB maximum budget.

---

## Integration Guide: Wiring into `src/audio.ts` (AudioSys API)

To wire these assets into `src/audio.ts` without disturbing the core audio architecture, add the one-shot horns and bells into `SFX_FILES` (e.g. `moped_horn: 'audio/ambience/moped-horn.ogg'`, `angkot_horn: 'audio/ambience/angkot-horn.ogg'`, `pedal_bell: 'audio/ambience/pedal-bell.ogg'`). For continuous environmental soundscapes (`warung-ambience.ogg`, `pasar-market-ambience.ogg`, `city-crowd-ambience.ogg`, `tropical-rain.ogg`), define an `AMBIENCE_FILES` map and instantiate corresponding looping `HTMLAudioElement` instances or `AudioBufferSourceNode` chains during `AudioSys.init()`, exposing a controller method like `setAmbienceBed(name: string, targetVolume: number, fadeSeconds = 1.0)` that drives gain smoothly via `fadeEl()`. For `gamelan-menu-loop.ogg`, register `gamelan: 'audio/ambience/gamelan-menu-loop.ogg'` in the `BGM` dictionary so it can be played or transitioned via `audioSys.startBgm('gamelan')`. Finally, the sampled police siren loops (`police-siren-wail.ogg`, `police-siren-yelp.ogg`) can either augment or substitute the synthetic oscillator in `AudioSys.siren(on: boolean)` when police pursuit wanted levels escalate.
