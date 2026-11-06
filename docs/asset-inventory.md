# Inventaris aset — referensi, lisensi, bukti

Dibuat supaya tiap aset bisa diaudit: apa yang dipakai sebagai referensi, lisensinya, dan
screenshot mana yang membuktikan hasil render dibandingkan side-by-side.

| Aset | Modul | Referensi | Bukti |
|---|---|---|---|
| Minimarket INDOMERET | `src/world/minimarket.ts` | referensi foto minimarket (CC BY 4.0) | `screenshots/proof/minimarket-compare.png` |
| Pos polisi (POS LANTAS / POLSEK THAMRIN) | `src/world/pospolisi.ts` | Pos Alun-alun Satlantas, Wikimedia — CC BY 4.0 | `screenshots/proof/pospolisi-compare.png` |
| Rumah makan Padang (SADERHANA) | `src/world/rumahpadang.ts` | Rumah Makan Padang Sederhana, panoramio — CC BY 3.0 | `screenshots/proof/padang-compare.png` |
| Masjid kampung (MASJID AL-IKHLAS) | `src/world/masjid.ts` | Masjid Al-Istiqomah Kampung Melayu — CC BY 3.0 | `screenshots/proof/masjid-compare.png` |
| Pasar daerah (PASAR DAERAH KALIMATI) | `src/world/pasar.ts` | Pasar Daerah Kalibaru Wetan, Banyuwangi — CC BY-SA 4.0 | `screenshots/proof/pasar-compare.png` |
| Baris ruko lantai dasar (tekstur) | `src/world/city.ts (shopfrontMat)` | Komplek Pertokoan Jl. Pekiringan, Cirebon — CC BY-SA 4.0 | `screenshots/proof/ruko-compare.png` |
| Halte TransJakarta | `src/world/halte.ts` | halte BRT (Wikimedia) | `screenshots/proof/transjakarta-3q.png` |
| Bus TransJakarta artikulasi | `src/vehicles/transjakarta.ts` | bus gandeng TransJakarta (Wikimedia) | `screenshots/proof/transjakarta-3q.png` |
| Bajaj | `src/vehicles/bajaj.ts` | bajaj Glodok (CC BY-SA) | `screenshots/proof/bajaj-fix.png` |
| Ojek + pengendara | `src/vehicles/ojek.ts` | ojek pangkalan (CC BY-SA) | `screenshots/proof/ojek-street.png` |
| Kaki lima: bakso / nasgor / sate | `src/world/kakilima.ts` | gerobak kaki lima (Wikimedia) | `screenshots/proof/kakilima.png` |
| SPPG dapur gizi + KOPERDES MERAH PUTEH | `src/world/kakilima.ts` | bangunan koperasi/SPPG (Wikimedia) | `screenshots/proof/kakilima.png` |
| Jalan layang (toll deck) | `src/world/layang.ts` | geometri jalan layang Jakarta | `screenshots/proof/ruko-b.png` |
| KRL layang + Stasiun Manggis | `src/world/krl.ts` | KRL/stasiun (Wikimedia) | `screenshots/proof/krl.png` |
| MRT + stasiun | `src/world/mrt.ts` | sistem MRT Jakarta (bentuk umum) | `screenshots/proof/mrt.png` |
| Interior reusable (minimarket/warteg/bengkel/kopi) | `src/world/interior.ts` | interior ruko Indonesia | `screenshots/proof/04-interior.png` |
| Ikon senjata pixel | `src/ui/hud.ts (drawWeaponIcon)` | GTA San Andreas HUD | `screenshots/proof/hud-weapon-ak.png, hud-weapon-pistol.png` |
| Pause menu | `index.html` | GTA V pause (tata letak) | `screenshots/proof/pause-desktop.png` |

## Belum ada (jujur, bukan klaim)

- Terminal bus (halte keberangkatan + jalur angkot)
- Kurir ojek dengan kotak pengiriman (gaya hijau/oranye)
- Gardu ronda (pos keamanan kampung)
- NPC pedagang yang benar-benar berjualan di kaki lima
- MRT: stasiun masih terhalang blok kalau dilihat dari trotoar (kartu `t_b6aad5af`)

## Cara memeriksa

```bash
node tests/world/audit.mjs      # tidak ada yang melayang/terkubur
node tests/ui/responsive.mjs   # HUD di 7 viewport
node tests/run-all.mjs         # semua suite
```
