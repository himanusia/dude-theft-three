# Jakarta — what the map promises, and the assets it needs

The map (`docs/map-jakarta-design.png`, data in `src/jakartamap.ts`) is the source of truth.
Everything below is derived from it: if a landmark is on the poster, it needs an asset, and a
street in a district needs the props that make that district recognisable.

Scale rule: the city is **not 1:1**. A 52 m block stands in for a few hundred metres of real
Jakarta, arterials run at ~1/5 real length, and districts keep the shape of the area rather
than its survey.

## Landmarks (slots already placed on the map)

| # | Landmark | District | Asset needed | Status |
|---|---|---|---|---|
| 1 | Monas | Gambir | stepped marble base, tapering shaft, gold flame, open square, flag ring | built |
| 2 | Bundaran HI | Thamrin | roundabout, Welcome Monument column + bowl, fountain ring, hotel towers behind | built |
| 3 | Stadhuis | Kota Tua | white colonial hall, red clay roof, clock tower, cobbled square, shophouse row | built |
| 4 | Gapura Glodok | Glodok | paifang: grey pillars, tiled roof, three plaques | built |
| 5 | Pantai Ancol | Ancol | sand, water plane, timber pier, feather flags, **ferris wheel silhouette** | pier/flags built, ferris wheel missing |
| 6 | Pasar Tanah Abang | Tanah Abang | multi-storey market block, tarpaulin canopies, loading bays | stalls only |
| 7 | Terminal Blok M | Blok M | bus shed, angkot bays, queue railings | missing |
| 8 | Kemang row | Kemang | low cafe row, verandas, street trees, signage | missing |

## District assets (street level)

| District | What has to exist for it to read |
|---|---|
| Kota Tua | cobblestone paving, colonial shutters, red clay roofs, museum sign, street lamps |
| Glodok | lantern strings, gold-shop signage, shophouse awnings, gates, narrow lanes |
| Ancol | sand, shallow water, pier, flags, palms, beach stalls |
| Gambir | open plaza, flag poles, low government blocks, wide pavements |
| Thamrin | glass towers, hotel signage, raised crossings, busway stops |
| Tanah Abang | market canopies, fabric bales, hand carts, dense signage |
| Kampung | 4 m gang, tiled gable roofs, laundry lines, warung fronts, parked motorbikes |
| Kemang | cafe verandas, low fences, tree canopy, hanging signs |
| Blok M | terminal shed, angkot queue, kiosks, pedestrian bridge |

## Vehicles — the "ini Indo banget" list

| Asset | Why it matters | Status |
|---|---|---|
| Angkot (Colt L300 / Carry) | the single most recognisable Jakarta vehicle | built from reference photos |
| Bajaj | three-wheeler, orange/blue hood, Glodok and Tanah Abang | missing |
| Ojek / motorbike | parked clusters on every corner | missing |
| Kopaja / Metromini | older bus, Kota Tua to Blok M | missing |
| Truck bak terbuka | goods into Tanah Abang | missing |
| Sedan/taxi/van/police | general traffic | built (Kenney CC0) |

## Street furniture

Warung carts (bakso, siomay, kopi keliling), traffic lights on the Jakarta "jogging" pole,
yellow `PKL` tents, blue `POSKAMLING` hut, mosque and musholla, `HALTE` bus stop sign,
`TAMAN`/`DILARANG PARKIR` signs, street-name plates, `GANG` alley signs, tangga banjir.

## Signage (all plesetan, never the real brand)

`ALFAMURTI`, `INDOMERET`, `MARTABAK MART`, `WARTEG BAHARI`, `WARTEG SIAP JIWO`, `KOPI TUBRUK`,
`BAKSO PAK TJE`, `LAUNDRY KILAT`, `APOTEK SINAR SEHAT`, `BENGKEL JAYA MOTOR`, `PANGKAS RAMBUT`,
`TOKO EMAS SUMBER REJEKI`, `GROSIR KAIN 88`.

## What the world generator has to change

1. Blocks are placed **along the road network**, not on a fixed grid: the ring road, the
   Thamrin–Sudirman spine and the radials in `src/jakartamap.ts` become the frame.
2. Blocks inside water, rivers or the road corridor are dropped.
3. District styling is chosen by **point-in-polygon** on the same district shapes as the poster.
4. Landmarks are placed at the coordinates in `LANDMARKS`, not at hand-picked grid cells.
