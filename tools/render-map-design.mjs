// Draws the Jakarta design poster from src/jakartamap.ts — the same polygons the world will use,
// so the design and the build cannot disagree.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1700, height: 1700 });
await page.goto(process.env.DTA_URL || 'http://127.0.0.1:8765/', { waitUntil: 'networkidle2' });
await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
await page.click('#start-btn');
await new Promise((r) => setTimeout(r, 1000));

const dataUrl = await page.evaluate(() => {
  const M = window.__game.jakartaMap;
  const S = 1600;
  const PAD = 70;
  // auto-fit: the map is authored in sketch space and scaled into world metres, so read the
  // extent from the geometry instead of hard-coding the old 210 m sketch
  const all = [];
  for (const d of M.DISTRICTS) for (const pt of d.poly) all.push(pt);
  for (const a of M.ARTERIALS) for (const pt of a.path) all.push(pt);
  for (const pt of M.RING_ROAD) all.push(pt);
  const EXT = Math.max(...all.map((p) => Math.max(Math.abs(p[0]), Math.abs(p[1])))) * 1.06;
  const scale = (S - PAD * 2) / (EXT * 2);
  const X = (x) => S / 2 + x * scale;
  const Y = (z) => S / 2 + z * scale;

  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const c = cv.getContext('2d');

  const path = (pts, close = true) => {
    c.beginPath();
    pts.forEach(([x, z], i) => (i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z))));
    if (close) c.closePath();
  };

  // paper
  c.fillStyle = '#0e1114';
  c.fillRect(0, 0, S, S);

  // 1. land mass: everything above the bay line, drawn as a soft warm grey
  c.save();
  path([[-EXT, -EXT], [EXT, -EXT], [EXT, EXT], [-EXT, EXT]]);
  c.clip();
  c.fillStyle = '#1a1e23';
  c.fillRect(0, 0, S, S);

  // 2. the bay, following the coastline
  c.beginPath();
  c.moveTo(X(-EXT), Y(-EXT));
  for (const [x, z] of M.COASTLINE) c.lineTo(X(x), Y(z));
  c.lineTo(X(EXT), Y(-EXT));
  c.closePath();
  const sea = c.createLinearGradient(0, 0, 0, Y(-145));
  sea.addColorStop(0, '#0a141b');
  sea.addColorStop(1, '#16323d');
  c.fillStyle = sea;
  c.fill();
  // surf along the shore
  c.strokeStyle = 'rgba(150,205,220,.35)';
  c.lineWidth = 2;
  c.beginPath();
  M.COASTLINE.forEach(([x, z], i) => (i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z))));
  c.stroke();

  // reclaimed islands
  for (const isl of M.ISLANDS) {
    path(isl);
    c.fillStyle = '#232a31';
    c.fill();
    c.strokeStyle = 'rgba(150,205,220,.3)';
    c.stroke();
  }

  // 3. district fills
  const NAMEPOS = {};
  for (const d of M.DISTRICTS) {
    path(d.poly);
    c.fillStyle = d.color;
    c.globalAlpha = 0.92;
    c.fill();
    c.globalAlpha = 1;
    c.strokeStyle = 'rgba(10,13,16,.55)';
    c.lineWidth = 1.5;
    c.stroke();
    const cx = d.poly.reduce((s, p) => s + p[0], 0) / d.poly.length;
    const cz = d.poly.reduce((s, p) => s + p[1], 0) / d.poly.length;
    NAMEPOS[d.id] = [cx, cz];
  }

  // 4. rivers and canals
  for (const r of M.RIVERS) {
    c.beginPath();
    r.path.forEach(([x, z], i) => (i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z))));
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = '#2c5f70';
    c.lineWidth = Math.max(3, r.width * scale);
    c.stroke();
  }

  // 5. roads: ring first, then arterials, so the spine reads on top
  c.lineJoin = 'round';
  c.beginPath();
  M.RING_ROAD.forEach(([x, z], i) => (i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z))));
  c.strokeStyle = '#313842';
  c.lineWidth = 16 * scale;
  c.stroke();
  c.strokeStyle = '#3d4650';
  c.lineWidth = 2;
  c.stroke();

  for (const a of M.ARTERIALS) {
    c.beginPath();
    a.path.forEach(([x, z], i) => (i ? c.lineTo(X(x), Y(z)) : c.moveTo(X(x), Y(z))));
    c.strokeStyle = a.width > 18 ? '#434d58' : '#3a434c';
    c.lineWidth = a.width * scale;
    c.stroke();
  }

  // 6. district names
  c.textAlign = 'center';
  for (const d of M.DISTRICTS) {
    const [x, z] = NAMEPOS[d.id];
    const label = d.name.toUpperCase();
    c.font = '700 15px -apple-system, system-ui, sans-serif';
    const w = c.measureText(label).width + 16;
    c.fillStyle = 'rgba(10,13,16,.78)';
    c.fillRect(X(x) - w / 2, Y(z) - 12, w, 22);
    c.fillStyle = '#eef3f6';
    c.fillText(label, X(x), Y(z) + 4);
  }

  // 7. landmark pins with numbered badges, legend carries the brief
  M.LANDMARKS.forEach((l, i) => {
    const x = X(l.x), y = Y(l.z);
    c.beginPath();
    c.arc(x, y, 11, 0, Math.PI * 2);
    c.fillStyle = '#f2c43a';
    c.fill();
    c.strokeStyle = '#0e1114';
    c.lineWidth = 2.5;
    c.stroke();
    c.fillStyle = '#0e1114';
    c.font = '800 13px -apple-system, system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText(String(i + 1), x, y + 4.5);
  });

  c.restore();

  // 8. chrome
  c.textAlign = 'left';
  c.font = '800 34px -apple-system, system-ui, sans-serif';
  c.fillStyle = '#eef3f6';
  c.fillText('JAKARTA', PAD, 66);
  c.font = '500 13px -apple-system, system-ui, sans-serif';
  c.fillStyle = '#93a1ad';
  c.fillText('versi disederhanakan · 9 distrik · 8 landmark · bukan 1:1', PAD, 88);
  c.textAlign = 'right';
  c.font = '500 12px -apple-system, system-ui, sans-serif';
  c.fillStyle = '#93a1ad';
  c.fillText(`${(EXT * 2 / 1000).toFixed(1)} km across`, S - PAD, 88);
  c.textAlign = 'left';
  c.textAlign = 'right';
  c.font = '800 15px -apple-system, system-ui, sans-serif';
  c.fillStyle = '#cfd8e0';
  c.fillText('N ↑', S - PAD, 62);

  // landmark key
  const kx = PAD;
  let ky = S - 30 - M.LANDMARKS.length * 19;
  c.textAlign = 'left';
  c.font = '700 12px -apple-system, system-ui, sans-serif';
  c.fillStyle = '#93a1ad';
  c.fillText('LANDMARK', kx, ky - 12);
  M.LANDMARKS.forEach((l, i) => {
    c.fillStyle = '#f2c43a';
    c.beginPath(); c.arc(kx + 6, ky + 4, 7, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#0e1114';
    c.font = '800 10px -apple-system, system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText(String(i + 1), kx + 6, ky + 7.5);
    c.textAlign = 'left';
    c.fillStyle = '#dbe4ea';
    c.font = '600 12px -apple-system, system-ui, sans-serif';
    c.fillText(l.name, kx + 20, ky + 8);
    c.fillStyle = '#7f8c98';
    c.font = '400 11px -apple-system, system-ui, sans-serif';
    c.fillText(l.brief, kx + 140, ky + 8);
    ky += 19;
  });

  // scale bar: 1 km
  const barLen = 1000 * scale * 0.2;     // world metres are ~1/5 real, so 1 km real ≈ 200 m world
  const bx = S - PAD - barLen, by = S - 34;
  c.strokeStyle = '#cfd8e0'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(bx, by); c.lineTo(bx + barLen, by); c.stroke();
  c.beginPath(); c.moveTo(bx, by - 4); c.lineTo(bx, by + 4); c.stroke();
  c.beginPath(); c.moveTo(bx + barLen, by - 4); c.lineTo(bx + barLen, by + 4); c.stroke();
  c.fillStyle = '#93a1ad';
  c.font = '600 12px -apple-system, system-ui, sans-serif';
  c.textAlign = 'center';
  c.fillText('± 1 km', bx + barLen / 2, by - 8);

  return cv.toDataURL('image/png');
});

fs.writeFileSync('docs/map-jakarta-design.png', Buffer.from(dataUrl.split(',')[1], 'base64'));
console.log('design map written', fs.statSync('docs/map-jakarta-design.png').size);
await browser.close();
