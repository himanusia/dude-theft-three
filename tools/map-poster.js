/*
 * Browser-side poster renderer for the Jakarta map.
 *
 * Evaluated by tools/render-map-design.mjs inside the running game page, so every shape comes
 * from the live module namespace (window.__game.jakartaMap / .jakartaStreets / .terrainHeight):
 * the poster cannot drift from the world because there is no second copy of the data.
 *
 * Cartographic layers, bottom to top:
 *   paper -> sea (deep water, depth bands, coastal shelf) -> terrain hillshade + hypsometric
 *   tint -> contours -> district wash -> canals -> local streets -> arterials -> toll ring
 *   -> landmark pins -> POI glyphs -> labels -> neatline, legend, scale bar, north arrow.
 *
 * Widths are real metres projected by the same scale factor as the geometry, so a 20 m arterial
 * is 2.5x an 8 m neighbourhood street on the paper, exactly as it is in the world.
 */
(() => {
  'use strict';

  const G = window.__game;
  if (!G || !G.jakartaMap || typeof G.terrainHeight !== 'function') {
    throw new Error('window.__game.terrainHeight / jakartaMap missing — did src/main.ts change?');
  }
  const M = G.jakartaMap;
  const HGT = G.terrainHeight;
  const STREETS = (G.jakartaStreets && G.jakartaStreets.LOCAL_STREETS) || [];

  // ------------------------------------------------------------------ palette
  const C = {
    paper: '#f5f0e4',
    ink: '#22231e',
    inkSoft: '#494a40',
    inkMute: '#7b7768',
    seaDeep: '#527f9c',
    seaMid: '#79a5bd',
    seaShelf: '#a6c6d5',
    coast: '#39637a',
    canal: '#7fb0c6',
    canalEdge: '#4f7f97',
    arterial: '#fffdf5',
    arterialCase: 'rgba(104,92,68,.62)',
    local: 'rgba(253,250,240,.94)',
    localCase: 'rgba(158,146,120,.42)',
    toll: '#bf613a',
    tollCase: '#8b4a29',
    contour: 'rgba(118,96,62,.42)',
    contourIndex: 'rgba(104,82,50,.66)',
  };

  // hypsometric ramp: metres above sea level -> land colour. The delta is nearly white so the
  // relief reads as relief rather than as a dark stain.
  const RAMP = [
    [-4, [219, 213, 193]],
    [2, [226, 220, 200]],
    [8, [220, 215, 186]],
    [18, [211, 203, 167]],
    [30, [199, 187, 145]],
    [44, [186, 171, 124]],
    [60, [170, 154, 106]],
    [90, [150, 134, 90]],
  ];

  const SANS = "'Helvetica Neue', Helvetica, 'Segoe UI', system-ui, sans-serif";
  const SERIF = "Baskerville, 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";

  const POI_LABEL = {
    halte: 'Halte',
    terminal: 'Terminal',
    pasar: 'Pasar',
    minimarket: 'Minimarket',
    masjid: 'Masjid',
    pos: 'Pos polisi',
    kaki5: 'Kaki lima',
  };
  const POI_ORDER = ['halte', 'terminal', 'pasar', 'minimarket', 'masjid', 'pos', 'kaki5'];

  // ------------------------------------------------------------------ geometry
  const bbox = (pts) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of pts) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    return { x0, x1, z0, z1 };
  };

  const centroid = (pts) => {
    let x = 0, z = 0;
    for (const p of pts) { x += p[0]; z += p[1]; }
    return [x / pts.length, z / pts.length];
  };

  const inside = (x, z, poly) => M.pointInPoly(x, z, poly);

  const segDist = (px, pz, ax, az, bx, bz) => {
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
    return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
  };

  const polyEdgeDist = (x, z, poly) => {
    let d = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      d = Math.min(d, segDist(x, z, poly[j][0], poly[j][1], poly[i][0], poly[i][1]));
    }
    return d;
  };

  /** a point well inside the polygon (grid pole of inaccessibility) — a better label anchor
   *  than the centroid, which falls outside concave districts like Kampung */
  const labelAnchor = (poly) => {
    const b = bbox(poly);
    let best = centroid(poly);
    let bestD = inside(best[0], best[1], poly) ? polyEdgeDist(best[0], best[1], poly) : -1;
    const N = 22;
    for (let i = 1; i < N; i++) {
      for (let j = 1; j < N; j++) {
        const x = b.x0 + ((b.x1 - b.x0) * i) / N;
        const z = b.z0 + ((b.z1 - b.z0) * j) / N;
        if (!inside(x, z, poly) || M.isWater(x, z)) continue;
        const d = polyEdgeDist(x, z, poly);
        if (d > bestD) { bestD = d; best = [x, z]; }
      }
    }
    return best;
  };

  const overlap = (a, b) => !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);

  // ------------------------------------------------------------------ text
  const spacing = (c, px) => { try { c.letterSpacing = px + 'px'; } catch (e) { /* older canvas */ } };

  function text(c, str, x, y, o) {
    c.save();
    if (o.font) c.font = o.font;
    c.textAlign = o.align || 'left';
    c.textBaseline = 'alphabetic';
    if (o.spacing != null) spacing(c, o.spacing);
    if (o.halo) {
      c.lineJoin = 'round';
      c.strokeStyle = o.halo;
      c.lineWidth = o.haloWidth || 3.4;
      c.strokeText(str, x, y);
    }
    c.fillStyle = o.fill || C.ink;
    c.fillText(str, x, y);
    const w = c.measureText(str).width;
    c.restore();
    return w;
  }

  function fitText(c, str, maxW) {
    if (c.measureText(str).width <= maxW) return str;
    let s = str;
    while (s.length > 6 && c.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s.trimEnd() + '…';
  }

  // ------------------------------------------------------------------ glyphs
  function star(c, x, y, r1, r2, n) {
    c.beginPath();
    for (let i = 0; i < n * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / n;
      const r = i % 2 ? r2 : r1;
      if (i) c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      else c.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    c.closePath();
  }

  function polyShape(c, x, y, r, sides, rot) {
    c.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = rot + (i * 2 * Math.PI) / sides;
      if (i) c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      else c.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    c.closePath();
  }

  const POI_FILL = {
    halte: '#2f6f9f',
    terminal: '#1d4f74',
    pasar: '#b4472f',
    minimarket: '#2b7f6c',
    masjid: '#3a6440',
    pos: '#1f3350',
    kaki5: '#c08a1c',
  };

  /** small, distinct glyph per POI kind; the paper-coloured halo keeps it legible on a road */
  function poiGlyph(c, kind, x, y, r, halo) {
    const shape = () => {
      switch (kind) {
        case 'halte':
          c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); break;
        case 'terminal':
          c.beginPath(); c.rect(x - r * 0.95, y - r * 0.95, r * 1.9, r * 1.9); break;
        case 'pasar':
          c.beginPath(); c.moveTo(x, y - r * 1.2); c.lineTo(x + r * 1.12, y + r * 0.78);
          c.lineTo(x - r * 1.12, y + r * 0.78); c.closePath(); break;
        case 'minimarket': {
          const w = r * 1.18, h = r * 0.95, k = 1.8;
          c.beginPath();
          c.moveTo(x - w + k, y - h); c.lineTo(x + w - k, y - h);
          c.quadraticCurveTo(x + w, y - h, x + w, y - h + k);
          c.lineTo(x + w, y + h - k); c.quadraticCurveTo(x + w, y + h, x + w - k, y + h);
          c.lineTo(x - w + k, y + h); c.quadraticCurveTo(x - w, y + h, x - w, y + h - k);
          c.lineTo(x - w, y - h + k); c.quadraticCurveTo(x - w, y - h, x - w + k, y - h);
          c.closePath(); break;
        }
        case 'masjid':
          c.beginPath(); c.arc(x, y + r * 0.22, r * 1.03, Math.PI, 0);
          c.lineTo(x + r * 1.03, y + r * 0.74); c.lineTo(x - r * 1.03, y + r * 0.74);
          c.closePath(); break;
        case 'pos':
          star(c, x, y, r * 1.2, r * 0.5, 5); break;
        case 'kaki5':
          polyShape(c, x, y, r * 1.12, 6, -Math.PI / 2); break;
        default:
          c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
      }
    };
    if (halo !== false) {
      c.save();
      c.lineJoin = 'round';
      shape();
      c.strokeStyle = C.paper;
      c.lineWidth = Math.max(2.2, r * 0.8);
      c.stroke();
      c.restore();
    }
    shape();
    c.fillStyle = POI_FILL[kind] || '#444';
    c.fill();

    // one white mark inside, so the kinds stay apart at 11 px
    c.save();
    c.fillStyle = 'rgba(255,253,246,.94)';
    c.strokeStyle = 'rgba(255,253,246,.94)';
    c.lineCap = 'round';
    if (kind === 'halte') {
      c.fillRect(x - r * 0.62, y - r * 0.2, r * 1.24, r * 0.4);
    } else if (kind === 'terminal') {
      c.fillRect(x - r * 0.35, y - r * 0.35, r * 0.7, r * 0.7);
    } else if (kind === 'pasar') {
      c.lineWidth = Math.max(1, r * 0.24);
      c.beginPath(); c.moveTo(x - r * 0.52, y + r * 0.32); c.lineTo(x + r * 0.52, y + r * 0.32); c.stroke();
    } else if (kind === 'minimarket') {
      c.fillRect(x - r * 0.17, y - r * 0.48, r * 0.34, r * 0.96);
    } else if (kind === 'masjid') {
      c.beginPath(); c.arc(x, y + r * 0.2, r * 0.28, 0, Math.PI * 2); c.fill();
      c.fillRect(x - r * 0.06, y - r * 0.98, r * 0.12, r * 0.3);
    } else if (kind === 'pos') {
      c.beginPath(); c.arc(x, y, r * 0.24, 0, Math.PI * 2); c.fill();
    } else if (kind === 'kaki5') {
      c.beginPath(); c.arc(x, y, r * 0.28, 0, Math.PI * 2); c.fill();
    }
    c.restore();
  }

  // ------------------------------------------------------------------ projection
  /** frame of side fw px showing a world window of side fw/scale metres, centred on (cx, cz) */
  function viewFor(S, pad, cx, cz, scale) {
    const fw = S - pad * 2;
    const half = fw / (2 * scale);
    return {
      S, pad, fx0: pad, fy0: pad, fx1: S - pad, fy1: S - pad, fw, fh: fw,
      scale, worldCx: cx, worldCz: cz,
      wx0: cx - half, wx1: cx + half, wz0: cz - half, wz1: cz + half,
      X: (x) => pad + (x - (cx - half)) * scale,
      Y: (z) => pad + (z - (cz - half)) * scale,
    };
  }

  // ------------------------------------------------------------------ height field
  function heightField(view, N) {
    const dx = (view.wx1 - view.wx0) / N;
    const dz = (view.wz1 - view.wz0) / N;
    let cur = new Float32Array(N * N);
    let max = -Infinity, min = Infinity;
    for (let j = 0; j < N; j++) {
      const z = view.wz0 + (j + 0.5) * dz;
      for (let i = 0; i < N; i++) {
        const x = view.wx0 + (i + 0.5) * dx;
        const h = HGT(x, z);
        cur[j * N + i] = h;
        if (!M.isWater(x, z)) { if (h > max) max = h; if (h < min) min = h; }
      }
    }
    // one 3x3 pass: softens the sample lattice without erasing the 70 m drainage octave, which
    // is the only fine relief texture the delta has
    for (let pass = 0; pass < 2; pass++) {
      const out = new Float32Array(N * N);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          let s = 0, n = 0;
          for (let jj = -1; jj <= 1; jj++) {
            const j2 = j + jj;
            if (j2 < 0 || j2 >= N) continue;
            for (let ii = -1; ii <= 1; ii++) {
              const i2 = i + ii;
              if (i2 < 0 || i2 >= N) continue;
              s += cur[j2 * N + i2]; n++;
            }
          }
          out[j * N + i] = s / n;
        }
      }
      cur = out;
    }
    return { H: cur, N, dx, dz, max, min };
  }

  function rampColor(h) {
    if (h <= RAMP[0][0]) return RAMP[0][1];
    for (let i = 1; i < RAMP.length; i++) {
      if (h <= RAMP[i][0]) {
        const [h0, c0] = RAMP[i - 1];
        const [h1, c1] = RAMP[i];
        const t = (h - h0) / (h1 - h0);
        return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
      }
    }
    return RAMP[RAMP.length - 1][1];
  }

  /** hillshade lit from the north-west at ~40 deg, vertical scale exaggerated 6x so a 5 % delta
   *  slope still shows. Baked into an RGBA tile with alpha 0 over the bay. */
  function reliefTile(view, field) {
    const { H, N, dx, dz } = field;
    const cv = document.createElement('canvas');
    cv.width = N; cv.height = N;
    const c = cv.getContext('2d');
    const img = c.createImageData(N, N);
    const v = [-0.62, 0.66, -0.42];
    const vm = Math.hypot(v[0], v[1], v[2]);
    const L = [v[0] / vm, v[1] / vm, v[2] / vm];
    const ZF = 9;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const x = view.wx0 + (i + 0.5) * dx;
        const z = view.wz0 + (j + 0.5) * dz;
        if (M.isWater(x, z)) { img.data[k * 4 + 3] = 0; continue; }
        const iL = Math.max(0, i - 1), iR = Math.min(N - 1, i + 1);
        const jU = Math.max(0, j - 1), jD = Math.min(N - 1, j + 1);
        const gx = (H[j * N + iR] - H[j * N + iL]) / ((iR - iL) * dx);
        const gz = (H[jD * N + i] - H[jU * N + i]) / ((jD - jU) * dz);
        let nx = -gx * ZF, nz = -gz * ZF, ny = 1;
        const nm = Math.hypot(nx, ny, nz);
        nx /= nm; ny /= nm; nz /= nm;
        const lam = nx * L[0] + ny * L[1] + nz * L[2];
        // flat ground prints at its ramp colour; faces turned from the light fall to 0.74,
        // faces turned into it rise to 1.16
        const shade = Math.max(0.74, Math.min(1.16, 1 + (lam - 0.661) * 1.05));
        const base = rampColor(H[k]);
        img.data[k * 4] = Math.min(255, base[0] * shade);
        img.data[k * 4 + 1] = Math.min(255, base[1] * shade);
        img.data[k * 4 + 2] = Math.min(255, base[2] * shade);
        img.data[k * 4 + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    return cv;
  }

  // ------------------------------------------------------------------ contours
  function contourPath(view, field, level) {
    const { H, N, dx, dz } = field;
    const p = new Path2D();
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const h00 = H[j * N + i], h10 = H[j * N + i + 1];
        const h01 = H[(j + 1) * N + i], h11 = H[(j + 1) * N + i + 1];
        let bits = 0;
        if (h00 > level) bits |= 1;
        if (h10 > level) bits |= 2;
        if (h11 > level) bits |= 4;
        if (h01 > level) bits |= 8;
        if (bits === 0 || bits === 15) continue;
        const x0 = view.wx0 + i * dx, z0 = view.wz0 + j * dz;
        const x1 = x0 + dx, z1 = z0 + dz;
        const lerp = (a, b, va, vb) => a + ((b - a) * (level - va)) / (vb - va || 1e-6);
        const top = [lerp(x0, x1, h00, h10), z0];
        const right = [x1, lerp(z0, z1, h10, h11)];
        const bottom = [lerp(x0, x1, h01, h11), z1];
        const left = [x0, lerp(z0, z1, h00, h01)];
        const seg = (a, b) => {
          p.moveTo(view.X(a[0]), view.Y(a[1]));
          p.lineTo(view.X(b[0]), view.Y(b[1]));
        };
        switch (bits) {
          case 1: case 14: seg(left, top); break;
          case 2: case 13: seg(top, right); break;
          case 3: case 12: seg(left, right); break;
          case 4: case 11: seg(right, bottom); break;
          case 6: case 9: seg(top, bottom); break;
          case 7: case 8: seg(left, bottom); break;
          case 5: seg(left, top); seg(right, bottom); break;
          case 10: seg(left, bottom); seg(top, right); break;
        }
      }
    }
    return p;
  }

  // ------------------------------------------------------------------ shape helpers
  /** the coastline is a hand-drawn zigzag; smoothing it through the same vertices keeps the
   *  shape but stops the shelf bands printing as a sawtooth */
  function coastlinePath(view, close) {
    const P = M.COASTLINE.map(([x, z]) => [view.X(x), view.Y(z)]);
    const p = new Path2D();
    p.moveTo(P[0][0], P[0][1]);
    for (let i = 1; i < P.length - 1; i++) {
      const mx = (P[i][0] + P[i + 1][0]) / 2;
      const my = (P[i][1] + P[i + 1][1]) / 2;
      p.quadraticCurveTo(P[i][0], P[i][1], mx, my);
    }
    p.lineTo(P[P.length - 1][0], P[P.length - 1][1]);
    if (close) {
      p.lineTo(view.X(view.wx1 + 600), view.Y(view.wz1 + 600));
      p.lineTo(view.X(view.wx0 - 600), view.Y(view.wz1 + 600));
      p.closePath();
    }
    return p;
  }

  const polyPath = (view, pts) => {
    const p = new Path2D();
    pts.forEach(([x, z], i) => (i ? p.lineTo(view.X(x), view.Y(z)) : p.moveTo(view.X(x), view.Y(z))));
    p.closePath();
    return p;
  };

  const linePath = (view, pts) => {
    const p = new Path2D();
    pts.forEach(([x, z], i) => (i ? p.lineTo(view.X(x), view.Y(z)) : p.moveTo(view.X(x), view.Y(z))));
    return p;
  };

  // ------------------------------------------------------------------ legend pieces
  function box(c, x, y, w, h, title) {
    c.save();
    c.fillStyle = 'rgba(247,243,234,.95)';
    c.fillRect(x, y, w, h);
    c.strokeStyle = 'rgba(34,35,30,.8)';
    c.lineWidth = 1.3;
    c.strokeRect(x, y, w, h);
    c.strokeStyle = 'rgba(34,35,30,.3)';
    c.lineWidth = 0.7;
    c.strokeRect(x + 4, y + 4, w - 8, h - 8);
    c.restore();
    if (title) text(c, title, x + 16, y + 27, { font: `600 10.5px ${SANS}`, fill: C.inkMute, spacing: 2.2 });
    return { x, y, w, h };
  }

  function keyBox(c, x, y) {
    const w = 250, h = 296;
    const r = box(c, x, y, w, h, 'KETERANGAN');
    let cx = x + 18;
    let cy = y + 56;
    const lx = cx + 26;
    for (const kind of POI_ORDER) {
      poiGlyph(c, kind, cx + 6, cy - 4, 5.6);
      text(c, POI_LABEL[kind], lx, cy, { font: `500 12.5px ${SANS}`, fill: C.inkSoft });
      cy += 20.5;
    }
    // linework keys
    cy += 6;
    c.save();
    c.strokeStyle = 'rgba(34,35,30,.25)';
    c.lineWidth = 0.8;
    c.beginPath(); c.moveTo(x + 16, cy - 12); c.lineTo(x + w - 16, cy - 12); c.stroke();
    c.restore();
    const lineRow = (draw, label) => {
      c.save(); draw(); c.restore();
      text(c, label, lx, cy + 1, { font: `500 12px ${SANS}`, fill: C.inkSoft });
      cy += 20;
    };
    lineRow(() => {
      c.strokeStyle = C.arterialCase; c.lineWidth = 9; c.lineCap = 'butt';
      c.beginPath(); c.moveTo(cx - 4, cy - 4); c.lineTo(cx + 16, cy - 4); c.stroke();
      c.strokeStyle = C.arterial; c.lineWidth = 6.5;
      c.beginPath(); c.moveTo(cx - 4, cy - 4); c.lineTo(cx + 16, cy - 4); c.stroke();
    }, 'Arterial 10–20 m');
    lineRow(() => {
      c.strokeStyle = C.tollCase; c.lineWidth = 9;
      c.beginPath(); c.moveTo(cx - 4, cy - 4); c.lineTo(cx + 16, cy - 4); c.stroke();
      c.strokeStyle = C.toll; c.lineWidth = 6;
      c.beginPath(); c.moveTo(cx - 4, cy - 4); c.lineTo(cx + 16, cy - 4); c.stroke();
      c.strokeStyle = 'rgba(250,245,232,.95)'; c.lineWidth = 1.2; c.setLineDash([3, 3]);
      c.beginPath(); c.moveTo(cx - 4, cy - 4); c.lineTo(cx + 16, cy - 4); c.stroke();
    }, 'Tol ring dalam kota');
    lineRow(() => {
      c.strokeStyle = C.localCase; c.lineWidth = 5;
      c.beginPath(); c.moveTo(cx - 4, cy - 4); c.lineTo(cx + 16, cy - 4); c.stroke();
      c.strokeStyle = C.local; c.lineWidth = 3.4;
      c.beginPath(); c.moveTo(cx - 4, cy - 4); c.lineTo(cx + 16, cy - 4); c.stroke();
    }, 'Jalan lingkungan 8 m');
    lineRow(() => {
      c.strokeStyle = C.canal; c.lineWidth = 6;
      c.beginPath(); c.moveTo(cx - 4, cy - 4); c.lineTo(cx + 16, cy - 4); c.stroke();
    }, 'Kanal · sungai');
    lineRow(() => {
      c.strokeStyle = C.contourIndex; c.lineWidth = 1.3;
      c.beginPath(); c.moveTo(cx - 4, cy - 4); c.lineTo(cx + 16, cy - 4); c.stroke();
    }, 'Kontur tiap 5 m');
    return r;
  }

  function landmarkBox(c, x, y) {
    const w = 374;
    const rowH = 32;
    const h = 40 + rowH * M.LANDMARKS.length + 6;
    box(c, x, y, w, h, 'LANDMARK');
    c.save();
    c.font = `500 11px ${SANS}`;
    M.LANDMARKS.forEach((l, i) => {
      const ry = y + 54 + i * rowH;
      const px = x + 22;
      c.beginPath();
      c.arc(px, ry - 4, 7.5, 0, Math.PI * 2);
      c.fillStyle = '#f3c53c';
      c.fill();
      c.strokeStyle = C.ink;
      c.lineWidth = 1.2;
      c.stroke();
      text(c, String(i + 1), px, ry - 1, { font: `700 9px ${SANS}`, fill: C.ink, align: 'center' });
      text(c, l.name, px + 16, ry, { font: `600 12.5px ${SANS}`, fill: C.inkSoft });
      c.font = `400 10.5px ${SANS}`;
      const brief = fitText(c, l.brief, w - 52);
      text(c, brief, px + 16, ry + 13, { font: `400 10.5px ${SANS}`, fill: C.inkMute });
    });
    c.restore();
    return { x, y, w, h };
  }

  function scaleBar(c, xRight, yBottom, scale, metres) {
    const len = metres * scale;
    const w = len + 56;
    const h = 84;
    const x = xRight - w;
    const y = yBottom - h;
    box(c, x, y, w, h, null);
    text(c, 'SKALA', x + 15, y + 23, { font: `600 10px ${SANS}`, fill: C.inkMute, spacing: 2 });
    const bx = x + 28;
    const by = y + 40;
    const bh = 8;
    for (let i = 0; i < 4; i++) {
      c.fillStyle = i % 2 ? '#f7f3ea' : C.ink;
      c.fillRect(bx + (len / 4) * i, by, len / 4, bh);
    }
    c.save();
    c.strokeStyle = C.ink;
    c.lineWidth = 1.1;
    c.strokeRect(bx, by, len, bh);
    c.beginPath();
    c.moveTo(bx + len / 2, by - 3); c.lineTo(bx + len / 2, by);
    c.stroke();
    c.restore();
    const ly = by + bh + 16;
    text(c, '0', bx, ly, { font: `500 11px ${SANS}`, fill: C.inkSoft, align: 'center' });
    text(c, `${metres / 2}`, bx + len / 2, ly, { font: `500 11px ${SANS}`, fill: C.inkSoft, align: 'center' });
    text(c, `${metres} m`, bx + len, ly, { font: `500 11px ${SANS}`, fill: C.inkSoft, align: 'center' });
  }

  // ------------------------------------------------------------------ panel
  /**
   * opts: { poiNames, landmarks: 'legend'|'names', titlePlate, title, subtitle, note,
   *         hillN, barMetres, credit }
   */
  function renderPanel(S, pad, cx, cz, scale, opts) {
    opts = opts || {};
    const view = viewFor(S, pad, cx, cz, scale);
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const c = cv.getContext('2d');
    const { fx0, fy0, fx1, fy1, fw, fh, X, Y } = view;

    // legend layout first: contour labels and district names both have to dodge these boxes
    const keyW = 250, keyH = 296;
    const keyRect = { x: fx0 + 22, y: fy1 - 22 - keyH, w: keyW, h: keyH };
    const lmH = 40 + 32 * M.LANDMARKS.length + 6;
    const lmRect = opts.landmarks === 'names'
      ? null
      : { x: keyRect.x + keyW + 16, y: fy1 - 22 - lmH, w: 374, h: lmH };
    const inLegend = (px, py, m) => {
      const pad = m || 0;
      for (const r of (lmRect ? [keyRect, lmRect] : [keyRect])) {
        if (px > r.x - pad && px < r.x + r.w + pad && py > r.y - pad && py < r.y + r.h + pad) return true;
      }
      return false;
    };

    c.fillStyle = C.paper;
    c.fillRect(0, 0, S, S);

    c.save();
    c.beginPath();
    c.rect(fx0, fy0, fw, fh);
    c.clip();

    // ---------------- sea
    const seaGrad = c.createLinearGradient(0, Y(view.wz0), 0, Y(M.SHORE_Z));
    seaGrad.addColorStop(0, C.seaDeep);
    seaGrad.addColorStop(0.6, C.seaMid);
    seaGrad.addColorStop(1, C.seaShelf);
    c.fillStyle = seaGrad;
    c.fillRect(fx0, fy0, fw, fh);

    // depth bands parallel to the shore: stroke the coastline with decreasing widths
    const shore = coastlinePath(view, false);
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'butt';
    for (const [w, style] of [
      [112, 'rgba(166,198,213,.24)'],
      [70, 'rgba(166,198,213,.30)'],
      [40, 'rgba(207,226,231,.38)'],
      [18, 'rgba(207,226,231,.52)'],
    ]) {
      c.strokeStyle = style;
      c.lineWidth = w;
      c.stroke(shore);
    }
    c.restore();

    // ---------------- terrain
    const field = heightField(view, opts.hillN || 240);
    const tile = reliefTile(view, field);
    const land = coastlinePath(view, true);

    c.fillStyle = '#e2dcc6';
    c.fill(land);
    c.save();
    c.clip(land);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(tile, fx0, fy0, fw, fh);
    c.restore();

    // islands are reclaimed slabs: flat fill, no hillshade (they sit at sea level)
    for (const isl of M.ISLANDS) {
      const p = polyPath(view, isl);
      c.save();
      c.strokeStyle = 'rgba(207,226,231,.28)';
      c.lineWidth = 9;
      c.stroke(p);
      c.restore();
      c.fillStyle = '#d5cdb6';
      c.fill(p);
      // fine hatch: these are land under reclamation, not finished city
      c.save();
      c.clip(p);
      c.strokeStyle = 'rgba(120,105,78,.20)';
      c.lineWidth = 0.8;
      const bb = bbox(isl);
      for (let d = (bb.x0 - bb.z1); d < (bb.x1 - bb.z0); d += 14) {
        const ax = bb.x0, az = bb.x0 - d;
        c.beginPath();
        c.moveTo(X(ax), Y(az));
        c.lineTo(X(bb.x1), Y(bb.x1 - d));
        c.stroke();
      }
      c.restore();
      c.strokeStyle = 'rgba(33,68,88,.95)';
      c.lineWidth = 2;
      c.stroke(p);
    }
    if (!opts.poiNames) {
      const isl = M.ISLANDS[1];
      const [ix, iz] = centroid(isl);
      text(c, 'pulau reklamasi', X(ix), Y(iz) + 52, {
        font: `italic 400 11.5px ${SERIF}`, fill: 'rgba(255,255,255,.72)', align: 'center', spacing: 0.6,
      });
    }

    // ---------------- coastline
    c.save();
    c.strokeStyle = C.coast;
    c.lineWidth = 2.2;
    c.lineJoin = 'round';
    c.stroke(shore);
    c.strokeStyle = 'rgba(255,255,255,.55)';
    c.lineWidth = 0.9;
    c.stroke(shore);
    c.restore();

    // ---------------- contours, on land only, from the smoothed field
    c.save();
    c.clip(land);
    const maxH = Math.max(10, field.max);
    for (let level = 5; level <= maxH + 5; level += 5) {
      const index = level % 25 === 0;
      c.strokeStyle = index ? C.contourIndex : C.contour;
      c.lineWidth = index ? 1.9 : 1.05;
      c.stroke(contourPath(view, field, level));
    }
    // Contour labels: a cartographer picks the station, so these two are placed at world points
    // that are open ground - no street, canal, district grid or legend box within 40 px.
    // The label snaps to the nearest crossing of its own level.
    const CONT_STATIONS = { 25: [820, 880], 50: [-30, 1090] };
    for (const key of Object.keys(CONT_STATIONS)) {
      const level = +key;
      if (level > field.max) continue;
      const [tx, tz] = CONT_STATIONS[level];
      const targetX = X(tx), targetY = Y(tz);
      let best = null;
      let bestD = Infinity;
      const consider = (wx, wz) => {
        const px = X(wx);
        const py = Y(wz) - 9;
        if (px > fx1 - 80 || px < fx0 + 60 || py > fy1 - 40 || py < fy0 + 10) return;
        if (inLegend(px, py, 20)) return;
        const d = Math.hypot(px - targetX, py - targetY);
        if (d < bestD) { bestD = d; best = { px, py }; }
      };
      for (let j = 0; j < field.N; j++) {
        const wz = view.wz0 + (j + 0.5) * field.dz;
        for (let i = 0; i < field.N; i++) {
          const a = field.H[j * field.N + i];
          // crossing along x: the contour runs up the page
          if (i < field.N - 1) {
            const b = field.H[j * field.N + i + 1];
            if ((a - level) * (b - level) < 0) {
              const t = (level - a) / (b - a);
              consider(view.wx0 + (i + 0.5 + t) * field.dx, wz);
            }
          }
          // crossing along z: the contour runs across the page
          if (j < field.N - 1) {
            const b = field.H[(j + 1) * field.N + i];
            if ((a - level) * (b - level) < 0) {
              const t = (level - a) / (b - a);
              consider(view.wx0 + (i + 0.5) * field.dx, wz + t * field.dz);
            }
          }
        }
      }
      if (best) {
        text(c, `${level} m`, best.px, best.py, {
          font: `600 12px ${SANS}`, fill: 'rgba(78,60,32,.95)',
          halo: 'rgba(248,244,235,.96)', haloWidth: 3.4, align: 'center',
        });
      }
    }
    c.restore();

    // ---------------- district wash
    const anchors = {};
    for (const d of M.DISTRICTS) {
      const p = polyPath(view, d.poly);
      c.save();
      c.globalAlpha = 0.16;
      c.fillStyle = d.color;
      c.fill(p);
      c.restore();
      c.save();
      c.strokeStyle = 'rgba(84,70,50,.45)';
      c.lineWidth = 1;
      c.setLineDash([9, 4]);
      c.stroke(p);
      c.restore();
      anchors[d.id] = labelAnchor(d.poly);
    }

    // ---------------- built blocks, straight from city.blocks
    const BLOCKS = (G.city && G.city.blocks) || [];
    c.save();
    c.clip(land);
    for (const b of BLOCKS) {
      if (b.type === 'landmark') continue;
      const h = b.size / 2;
      const p = polyPath(view, [
        [b.x - h, b.z - h], [b.x + h, b.z - h], [b.x + h, b.z + h], [b.x - h, b.z + h],
      ]);
      c.fillStyle = b.type === 'park' ? 'rgba(92,118,76,.22)' : 'rgba(120,100,72,.17)';
      c.fill(p);
      c.strokeStyle = 'rgba(96,82,60,.38)';
      c.lineWidth = 0.9;
      c.stroke(p);
    }
    c.restore();

    // ---------------- canals, real widths (clipped to land so they end at the shore)
    c.save();
    c.clip(land);
    c.lineJoin = 'round';
    c.lineCap = 'round';
    for (const r of M.RIVERS) {
      const p = linePath(view, r.path);
      const w = Math.max(3, r.width * scale);
      c.strokeStyle = 'rgba(247,243,234,.9)';   // tanggul kerb
      c.lineWidth = w + 3.4;
      c.stroke(p);
      c.strokeStyle = C.canal;
      c.lineWidth = w;
      c.stroke(p);
      c.strokeStyle = C.canalEdge;
      c.lineWidth = Math.max(0.9, w * 0.15);
      c.stroke(p);
    }
    c.restore();

    // ---------------- local streets (8 m)
    const localRuns = STREETS.map((st) => [linePath(view, st.path), st.width]);
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'butt';
    c.strokeStyle = C.localCase;
    for (const [p, w] of localRuns) { c.lineWidth = Math.max(1.6, w * scale + 1.5); c.stroke(p); }
    c.strokeStyle = C.local;
    for (const [p, w] of localRuns) { c.lineWidth = Math.max(1.2, w * scale); c.stroke(p); }
    c.restore();

    // ---------------- arterials
    const artW = (a) => Math.max(2.2, a.width * scale);
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'butt';
    c.strokeStyle = C.arterialCase;
    for (const a of M.ARTERIALS) { c.lineWidth = artW(a) + 2.4; c.stroke(linePath(view, a.path)); }
    c.strokeStyle = C.arterial;
    for (const a of M.ARTERIALS) { c.lineWidth = artW(a); c.stroke(linePath(view, a.path)); }
    c.strokeStyle = 'rgba(150,120,74,.32)';
    c.setLineDash([7, 7]);
    c.lineWidth = Math.max(0.8, scale * 1.1);
    for (const a of M.ARTERIALS) if (a.width >= 13) c.stroke(linePath(view, a.path));
    c.restore();

    // ---------------- toll ring in its own colour, with a median
    const ring = linePath(view, M.RING_ROAD);
    const ringW = Math.max(3, 16 * scale);
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'butt';
    c.strokeStyle = C.tollCase;
    c.lineWidth = ringW + 2.6;
    c.stroke(ring);
    c.strokeStyle = C.toll;
    c.lineWidth = ringW;
    c.stroke(ring);
    c.strokeStyle = 'rgba(250,245,232,.92)';
    c.lineWidth = Math.max(1, ringW * 0.15);
    c.setLineDash([9, 9]);
    c.stroke(ring);
    c.restore();

    // ---------------- landmark pins
    const pinR = opts.poiNames ? 14 : 12.5;
    const pins = M.LANDMARKS.map((l, i) => ({ x: X(l.x), y: Y(l.z), i, name: l.name }));
    for (const p of pins) {
      c.beginPath();
      c.arc(p.x, p.y + 1.5, pinR, 0, Math.PI * 2);
      c.fillStyle = 'rgba(60,50,35,.16)';
      c.fill();
      c.beginPath();
      c.arc(p.x, p.y, pinR, 0, Math.PI * 2);
      c.fillStyle = '#f3c53c';
      c.fill();
      c.strokeStyle = C.ink;
      c.lineWidth = 1.8;
      c.stroke();
      text(c, String(p.i + 1), p.x, p.y + pinR * 0.37, {
        font: `700 ${Math.round(pinR * 1.1)}px ${SANS}`, fill: C.ink, align: 'center',
      });
    }

    // ---------------- POIs, displaced so nothing prints on top of anything
    const poiR = opts.poiNames ? 9.5 : 7.5;
    const pts = M.POIS.map((p) => {
      const x = X(p.x), y = Y(p.z);
      return { kind: p.kind, name: p.name, hx: x, hy: y, x, y };
    }).filter((p) => p.x > fx0 + 4 && p.x < fx1 - 4 && p.y > fy0 + 4 && p.y < fy1 - 4);
    const fixed = pins.map((p) => ({ x: p.x, y: p.y, r: pinR + 1.5 }));
    const sep = poiR * 2 + 3.4;
    for (let it = 0; it < 200; it++) {
      for (let a = 0; a < pts.length; a++) {
        for (let b = a + 1; b < pts.length; b++) {
          let dx = pts[b].x - pts[a].x, dy = pts[b].y - pts[a].y;
          const d = Math.hypot(dx, dy) || 0.001;
          if (d < sep) {
            const push = (sep - d) / 2;
            dx /= d; dy /= d;
            pts[a].x -= dx * push; pts[a].y -= dy * push;
            pts[b].x += dx * push; pts[b].y += dy * push;
          }
        }
      }
      for (const p of pts) {
        for (const f of fixed) {
          let dx = p.x - f.x, dy = p.y - f.y;
          let d = Math.hypot(dx, dy);
          const min = f.r + poiR + 2;
          if (d < 0.5) {
            // exactly coincident (the map reuses one coordinate for a landmark and its POI):
            // push on a fixed angle so the pin does not hide the glyph or vice versa
            dx = 0; dy = 1; d = 0.001;
            p.x = f.x; p.y = f.y + min;
            continue;
          }
          if (d < min) { p.x = f.x + (dx / d) * min; p.y = f.y + (dy / d) * min; }
        }
      }
      for (const p of pts) {
        p.x += (p.hx - p.x) * 0.03;
        p.y += (p.hy - p.y) * 0.03;
        const d = Math.hypot(p.x - p.hx, p.y - p.hy);
        if (d > 28) {
          p.x = p.hx + ((p.x - p.hx) / d) * 28;
          p.y = p.hy + ((p.y - p.hy) / d) * 28;
        }
      }
    }
    // leader lines for everything that moved
    c.save();
    for (const p of pts) {
      if (Math.hypot(p.x - p.hx, p.y - p.hy) < 4) continue;
      c.strokeStyle = 'rgba(60,60,50,.5)';
      c.lineWidth = 0.9;
      c.beginPath(); c.moveTo(p.hx, p.hy); c.lineTo(p.x, p.y); c.stroke();
      c.fillStyle = 'rgba(60,60,50,.75)';
      c.beginPath(); c.arc(p.hx, p.hy, 1.4, 0, Math.PI * 2); c.fill();
    }
    c.restore();
    for (const p of pts) poiGlyph(c, p.kind, p.x, p.y, poiR);

    const placed = pts.map((p) => ({ x: p.x - poiR - 1.5, y: p.y - poiR - 1.5, w: poiR * 2 + 3, h: poiR * 2 + 3 }));

    const lmNames = new Set(M.LANDMARKS.map((l) => l.name.toLowerCase()));
    const placeLabel = (str, p, fs, weight, color, pad2) => {
      const wpx = (() => { c.save(); c.font = `${weight} ${fs}px ${SANS}`; const w = c.measureText(str).width; c.restore(); return w; })();
      const gap = pad2 || 6;
      const cands = [
        [p.x + (p.r || 0) + gap, p.y + fs * 0.34, 'left'],
        [p.x - (p.r || 0) - gap, p.y + fs * 0.34, 'right'],
        [p.x, p.y - (p.r || 0) - gap * 0.7, 'center'],
        [p.x, p.y + (p.r || 0) + fs + gap * 0.4, 'center'],
      ];
      let best = null;
      for (const [tx, ty, align] of cands) {
        const x0 = align === 'left' ? tx : align === 'right' ? tx - wpx : tx - wpx / 2;
        const bx = { x: x0 - 2, y: ty - fs + 1.5, w: wpx + 4, h: fs + 3.5 };
        const out = bx.x < fx0 + 6 || bx.x + bx.w > fx1 - 6 || bx.y < fy0 + 6 || bx.y + bx.h > fy1 - 6;
        if (out) continue;
        if (!placed.some((q) => overlap(bx, q))) { best = { tx, ty, align, bx }; break; }
      }
      if (!best) {
        const [tx, ty, align] = cands[0];
        const x0 = align === 'left' ? tx : align === 'right' ? tx - wpx : tx - wpx / 2;
        const bx = { x: x0 - 2, y: ty - fs + 1.5, w: wpx + 4, h: fs + 3.5 };
        if (bx.x < fx0 + 4 || bx.x + bx.w > fx1 - 4 || bx.y < fy0 + 4 || bx.y + bx.h > fy1 - 4) return;
        best = { tx, ty, align, bx };
      }
      placed.push(best.bx);
      text(c, str, best.tx, best.ty, {
        font: `${weight} ${fs}px ${SANS}`, fill: color, align: best.align,
        halo: 'rgba(247,243,234,.94)', haloWidth: 3.6, spacing: 0.1,
      });
    };

    // landmark names on the zoom panel: the pins carry names there, numbers would need a key
    if (opts.landmarks === 'names' || opts.landmarks === 'both') {
      for (const p of pins) {
        p.r = pinR;
        placeLabel(p.name, p, 13.5, 600, '#2b2c25', 7);
      }
    }

    if (opts.poiNames) {
      for (const p of pts) {
        p.r = poiR;
        // a POI that carries the same name as a landmark (Pasar Tanah Abang, Terminal Blok M)
        // gets one label, not two
        if (lmNames.has(p.name.toLowerCase())) continue;
        placeLabel(p.name, p, 12.5, 600, '#35382d', 7);
      }
    }

    c.restore(); // unclip content

    // ================================================================ chrome
    const reserved = [keyRect];

    if (lmRect) reserved.push(lmRect);
    for (const p of pins) reserved.push({ x: p.x - pinR - 3, y: p.y - pinR - 3, w: pinR * 2 + 6, h: pinR * 2 + 6 });

    // ---------------- district names
    const labelFs = opts.poiNames ? 20 : 16.5;
    const labelSp = opts.poiNames ? 2.8 : 2.2;
    const titleBlock = opts.titlePlate
      ? { x: fx0 + 16, y: fy0 + 16, w: Math.min(fw * 0.52, 640), h: 104 }
      : { x: fx0 + 24, y: fy0 + 58, w: 470, h: 100 };
    reserved.push(titleBlock);
    if (!opts.poiNames) reserved.push({ x: fx1 - 190, y: fy0 + 40, w: 150, h: 100 }); // north arrow

    for (const d of M.DISTRICTS) {
      const [ax, az] = anchors[d.id];
      const label = d.name.toUpperCase();
      c.save();
      c.font = `600 ${labelFs}px ${SANS}`;
      spacing(c, labelSp);
      const w = c.measureText(label).width;
      c.restore();
      const tries = [[0, 0], [0, -42], [0, 42], [0, -84], [-78, 0], [78, 0], [0, 84],
        [-78, -42], [78, 42], [0, -126], [0, 126], [-78, 84], [78, -84]];
      let pos = null;
      for (const [ox, oy] of tries) {
        const bx = {
          x: X(ax) + ox - w / 2 - 7, y: Y(az) + oy - labelFs + 2,
          w: w + 14, h: labelFs + 9,
        };
        const out = bx.x < fx0 + 10 || bx.x + bx.w > fx1 - 10 || bx.y < fy0 + 10 || bx.y + bx.h > fy1 - 10;
        if (!out && !reserved.some((q) => overlap(bx, q))) {
          pos = [X(ax) + ox, Y(az) + oy]; reserved.push(bx); break;
        }
      }
      if (!pos) {
        // if the district's own anchor is off this panel (Kota Tua on the core sheet), drop the
        // label instead of clamping it under the title plate
        const off = X(ax) < fx0 - 30 || X(ax) > fx1 + 30 || Y(az) < fy0 - 30 || Y(az) > fy1 + 30;
        if (off) continue;
        const cxL = Math.min(Math.max(X(ax), fx0 + 14 + w / 2), fx1 - 14 - w / 2);
        const cyL = Math.min(Math.max(Y(az), fy0 + 26 + labelFs), fy1 - 24);
        pos = [cxL, cyL];
        reserved.push({ x: cxL - w / 2 - 7, y: cyL - labelFs + 2, w: w + 14, h: labelFs + 9 });
      }
      text(c, label, pos[0], pos[1], {
        font: `600 ${labelFs}px ${SANS}`, fill: 'rgba(36,37,30,.88)', align: 'center',
        halo: 'rgba(248,244,235,.96)', haloWidth: 5, spacing: labelSp,
      });
    }

    // ---------------- title
    const sub = typeof opts.subtitle === 'function'
      ? opts.subtitle({ maxH: field.max, minH: field.min, dataW })
      : (opts.subtitle || '');
    if (opts.titlePlate) {
      const plateW = Math.min(fw * 0.56, 660);
      c.save();
      c.fillStyle = 'rgba(247,243,234,.95)';
      c.fillRect(fx0 + 16, fy0 + 16, plateW, 104);
      c.strokeStyle = 'rgba(34,35,30,.8)';
      c.lineWidth = 1.3;
      c.strokeRect(fx0 + 16, fy0 + 16, plateW, 104);
      c.restore();
      text(c, opts.title || 'JAKARTA', fx0 + 40, fy0 + 76, {
        font: `400 44px ${SERIF}`, fill: C.ink, spacing: 4.5,
      });
      text(c, sub, fx0 + 41, fy0 + 103, { font: `500 13px ${SANS}`, fill: C.inkMute });
    } else {
      text(c, opts.title || 'JAKARTA', fx0 + 34, fy0 + 104, {
        font: `400 ${opts.titleSize || 76}px ${SERIF}`, fill: C.ink, spacing: 8,
      });
      c.save();
      c.strokeStyle = 'rgba(34,35,30,.65)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(fx0 + 37, fy0 + 124);
      c.lineTo(fx0 + 37 + Math.min(440, fw * 0.42), fy0 + 124);
      c.stroke();
      c.restore();
      text(c, sub, fx0 + 37, fy0 + 149, { font: `500 15px ${SANS}`, fill: 'rgba(55,56,46,.88)', spacing: 0.3 });
      if (opts.note) {
        text(c, opts.note, fx0 + 37, fy0 + 172, { font: `400 13px ${SANS}`, fill: 'rgba(70,70,58,.66)', spacing: 0.4 });
      }
    }

    // sea name
    if (!opts.poiNames) {
      text(c, 'T E L U K   J A K A R T A', fx0 + fw * 0.53, fy0 + 262, {
        font: `italic 400 21px ${SERIF}`, fill: 'rgba(255,255,255,.75)', align: 'center',
      });
    }

    // north arrow
    const nx = fx1 - (opts.poiNames ? 76 : 96);
    const ny = fy0 + (opts.poiNames ? 74 : 84);
    const nr = opts.poiNames ? 24 : 30;
    c.save();
    if (opts.poiNames) {
      c.fillStyle = 'rgba(247,243,234,.92)';
      c.beginPath(); c.arc(nx, ny, nr + 14, 0, Math.PI * 2); c.fill();
      c.strokeStyle = 'rgba(34,35,30,.55)';
      c.lineWidth = 1;
      c.stroke();
    }
    c.translate(nx, ny);
    c.beginPath();
    c.moveTo(0, -nr);
    c.lineTo(nr * 0.42, nr * 0.55);
    c.lineTo(0, nr * 0.28);
    c.lineTo(-nr * 0.42, nr * 0.55);
    c.closePath();
    c.fillStyle = C.ink;
    c.fill();
    c.strokeStyle = C.ink;
    c.lineWidth = 1.2;
    c.stroke();
    c.beginPath();
    c.moveTo(0, -nr);
    c.lineTo(0, nr * 0.28);
    c.strokeStyle = C.paper;
    c.lineWidth = 0.8;
    c.stroke();
    c.restore();
    text(c, 'N', nx, ny - nr - 9, { font: `600 13px ${SANS}`, fill: C.ink, align: 'center', spacing: 1.5 });

    // what lies beyond the frame
    if (!opts.poiNames) {
      text(c, 'DEPOK · BOGOR  ▾', fx0 + fw * 0.56, fy1 - 30, {
        font: `italic 400 13px ${SERIF}`, fill: C.inkMute, align: 'center',
      });
    }

    // ---------------- legend + scale
    keyBox(c, keyRect.x, keyRect.y);
    if (lmRect) landmarkBox(c, lmRect.x, lmRect.y, false);
    scaleBar(c, fx1 - 24, fy1 - 22, scale, opts.barMetres || 500);
    text(c, opts.credit || 'bukan 1:1 · digambar dari src/world/jakartamap.ts', fx1 - 24, fy1 - 116, {
      font: `400 11px ${SANS}`, fill: C.inkMute, align: 'right',
    });

    // ---------------- neatline, last so nothing bleeds over it
    c.save();
    c.strokeStyle = C.ink;
    c.lineWidth = 1.6;
    c.strokeRect(fx0, fy0, fw, fh);
    c.strokeStyle = 'rgba(34,35,30,.45)';
    c.lineWidth = 0.7;
    c.strokeRect(fx0 + 4.5, fy0 + 4.5, fw - 9, fh - 9);
    c.restore();

    // corner ticks outside the neatline
    c.save();
    c.strokeStyle = 'rgba(34,35,30,.55)';
    c.lineWidth = 1.1;
    const t = 12;
    for (const [px, py, sx, sy] of [[fx0, fy0, -1, -1], [fx1, fy0, 1, -1], [fx0, fy1, -1, 1], [fx1, fy1, 1, 1]]) {
      c.beginPath(); c.moveTo(px + sx * 3, py); c.lineTo(px + sx * (t + 3), py); c.stroke();
      c.beginPath(); c.moveTo(px, py + sy * 3); c.lineTo(px, py + sy * (t + 3)); c.stroke();
    }
    c.restore();

    return { canvas: cv, field, view };
  }

  // ------------------------------------------------------------------ entry
  // extents from the real geometry, so the poster and the world agree
  const all = [];
  for (const d of M.DISTRICTS) for (const p of d.poly) all.push(p);
  for (const a of M.ARTERIALS) for (const p of a.path) all.push(p);
  for (const p of M.RING_ROAD) all.push(p);
  for (const p of M.COASTLINE) all.push(p);
  for (const isl of M.ISLANDS) for (const p of isl) all.push(p);
  for (const r of M.RIVERS) for (const p of r.path) all.push(p);
  const B = bbox(all);
  const dataW = B.x1 - B.x0;
  const dataH = B.z1 - B.z0;

  // main poster: one square framing the whole data extent plus bay for the title block
  const S1 = 2000;
  const PAD1 = 64;
  const halfMain = 1215;                    // metres from centre to frame edge
  const scale1 = (S1 - PAD1 * 2) / (halfMain * 2);
  const main = renderPanel(S1, PAD1, 0, -20, scale1, {
    title: 'JAKARTA',
    subtitle: (st) => `lebar ${(st.dataW / 1000).toFixed(1).replace('.', ',')} km barat–timur · dataran delta 0–${Math.round(st.maxH)} m dpl · kontur tiap 5 m`,
    note: '9 distrik · 8 landmark · 14 titik kehidupan jalan · bukan 1:1',
    hillN: 240,
    landmarks: 'legend',
    barMetres: 500,
  });

  // zoom panel: exactly 2x the main scale, focused Bundaran HI -> Tanah Abang
  const S2 = 1600;
  const PAD2 = 56;
  const scale2 = scale1 * 2;
  const core = renderPanel(S2, PAD2, -210, -20, scale2, {
    poiNames: true,
    hillN: 240,
    landmarks: 'names',
    titlePlate: true,
    title: 'JAKARTA · PUSAT KOTA',
    subtitle: 'Bundaran HI → Tanah Abang · perbesaran 2× poster utama',
    barMetres: 250,
    credit: '9 distrik · 8 landmark · 14 titik · bukan 1:1',
  });

  return {
    ok: true,
    dataW, dataH,
    bbox: B,
    scale: scale1,
    scale2,
    mainMinH: main.field.min,
    mainMaxH: main.field.max,
    coreMinH: core.field.min,
    main: main.canvas.toDataURL('image/png'),
    core: core.canvas.toDataURL('image/png'),
  };
})();
