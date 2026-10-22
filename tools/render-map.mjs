// Renders the city map poster straight from the data the game uses: every block asks the same
// districtAt() the world generator calls, so the poster cannot drift from the map.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1600 });
await page.goto(process.env.DTA_URL || 'http://127.0.0.1:8765/', { waitUntil: 'networkidle2' });
await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
await page.click('#start-btn');
await new Promise((r) => setTimeout(r, 1200));

const dataUrl = await page.evaluate(() => {
  const g = window.__game;
  const S = 1500;
  const PAD = 60;
  const PITCH = 52, BLOCK = 38, GRID = 3;
  const worldHalf = GRID * PITCH + BLOCK * 0.5;
  const mapTop = 190;              // the bay gets a real band, not the margin
  const mapBottom = S - 150;
  const scale = (mapBottom - mapTop) / (worldHalf * 2);
  const mapLeft = (S - (mapBottom - mapTop)) / 2;
  const projX = (w) => mapLeft + (w + worldHalf) * scale;
  const projY = (w) => mapTop + (w + worldHalf) * scale;

  const COLORS = {
    monas: '#c9c3b2', thamrin: '#5b7f9e', kotatua: '#c9714f', glodok: '#b08a3e',
    tanahabang: '#9c8f74', kampung: '#a9855f', blokm: '#8f8a74', kemang: '#7d8a6a', ancol: '#4f7e74',
  };

  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const c = cv.getContext('2d');

  // 1. paper, then the bay along the north edge
  c.fillStyle = '#101318'; c.fillRect(0, 0, S, S);
  const shoreY = mapTop - 4;
  const sea = c.createLinearGradient(0, 0, 0, shoreY);
  sea.addColorStop(0, '#0d1a22');
  sea.addColorStop(1, '#183541');
  c.fillStyle = sea;
  c.fillRect(mapLeft, PAD * 0.4, mapBottom - mapTop, shoreY - PAD * 0.4);
  c.strokeStyle = 'rgba(120,180,200,.22)';
  c.lineWidth = 1.5;
  for (let y = PAD * 0.4 + 16; y < shoreY - 8; y += 20) {
    c.beginPath();
    for (let x = PAD * 0.4; x < S - PAD * 0.4; x += 26) {
      c.moveTo(x, y);
      c.quadraticCurveTo(x + 6.5, y - 3, x + 13, y);
      c.quadraticCurveTo(x + 19.5, y + 3, x + 26, y);
    }
    c.stroke();
  }
  c.strokeStyle = '#d8c49a';
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(PAD * 0.4, shoreY);
  c.lineTo(S - PAD * 0.4, shoreY);
  c.stroke();

  // 2. land
  c.fillStyle = '#1b1f25';
  c.fillRect(mapLeft, shoreY, mapBottom - mapTop, mapBottom - shoreY);

  // 3. road network: cross streets, then the main Thamrin-Sudirman spine wider and lighter
  const roadW = 14 * scale;
  c.strokeStyle = '#2b3138';
  c.lineWidth = roadW;
  c.lineCap = 'butt';
  for (let gx = -GRID; gx <= GRID; gx++) {
    const x = projX(gx * PITCH + PITCH / 2);
    c.beginPath(); c.moveTo(x, shoreY); c.lineTo(x, mapBottom); c.stroke();
  }
  for (let gz = -GRID; gz <= GRID; gz++) {
    const y = projY(gz * PITCH + PITCH / 2);
    c.beginPath(); c.moveTo(mapLeft, y); c.lineTo(mapLeft + (mapBottom - mapTop), y); c.stroke();
  }
  c.strokeStyle = '#3a434c';
  c.lineWidth = roadW * 1.9;
  c.beginPath(); c.moveTo(projX(0), shoreY); c.lineTo(projX(0), mapBottom); c.stroke();

  // 4. blocks, coloured by district
  for (let gx = -GRID; gx <= GRID; gx++) {
    for (let gz = -GRID; gz <= GRID; gz++) {
      const cx = gx * PITCH, cz = gz * PITCH;
      const half = (BLOCK / 2) * scale;
      const id = g.districtAt(cx, cz);
      c.fillStyle = COLORS[id] || '#6a6a6a';
      c.fillRect(projX(cx) - half, projY(cz) - half, half * 2, half * 2);
      c.strokeStyle = 'rgba(0,0,0,.4)';
      c.lineWidth = 1;
      c.strokeRect(projX(cx) - half + 0.5, projY(cz) - half + 0.5, half * 2 - 1, half * 2 - 1);
    }
  }

  // 5. the Ciliwung, roughly: a canal cutting the west side down to the bay
  c.strokeStyle = '#2f5f6e';
  c.lineWidth = 7;
  c.beginPath();
  c.moveTo(projX(-150), shoreY);
  c.bezierCurveTo(projX(-120), projY(-90), projX(-140), projY(20), projX(-96), projY(80));
  c.bezierCurveTo(projX(-60), projY(130), projX(-88), projY(160), projX(-40), projY(175));
  c.stroke();

  // 6. landmark pins, labels offset so neighbours never overlap
  const pins = [
    { label: 'MONAS', x: 0, z: 0, dx: -30, dy: -18, size: 18 },
    { label: 'BUNDARAN HI', x: 0, z: 52, dx: 100, dy: 4, size: 15 },
    { label: 'KOTA TUA', x: 0, z: -104, dx: -84, dy: -14, size: 15 },
    { label: 'GAPURA GLODOK', x: -52, z: -130, dx: 0, dy: -22, size: 13 },
    { label: 'PANTAI ANCOL', x: 104, z: -178, dx: 0, dy: -18, size: 15 },
  ];
  for (const p of pins) {
    const x = projX(p.x), y = projY(p.z);
    c.beginPath(); c.arc(x, y, 8, 0, Math.PI * 2);
    c.fillStyle = '#f2c43a'; c.fill();
    c.strokeStyle = '#101318'; c.lineWidth = 2.5; c.stroke();
    const tx = x + p.dx, ty = y + p.dy;
    c.font = '800 ' + p.size + 'px -apple-system, system-ui, sans-serif';
    c.textAlign = 'center';
    const w = c.measureText(p.label).width + 12;
    c.fillStyle = 'rgba(10,12,15,.9)';
    c.fillRect(tx - w / 2, ty - 13, w, 21);
    c.fillStyle = '#ffe9a8';
    c.fillText(p.label, tx, ty + 3);
  }

  // 7. district names in their own blocks
  const labels = [
    ['ANCÓL', 104, -156], ['GLODOK', -156, -104],
    ['GAMBIR', 0, 0], ['TANAH ABANG', -104, 52], ['THAMRIN', 0, 104],
    ['KEMANG', 104, 52], ['KAMPUNG', 156, 156], ['BLOK M', 52, 156],
  ];
  c.font = '600 14px -apple-system, system-ui, sans-serif';
  c.textAlign = 'center';
  for (const [label, wx, wz] of labels) {
    const x = projX(wx), y = projY(wz) + 42;
    const w = c.measureText(label).width + 12;
    c.fillStyle = 'rgba(10,12,15,.75)';
    c.fillRect(x - w / 2, y - 12, w, 19);
    c.fillStyle = '#dbe4ea';
    c.fillText(label, x, y + 2);
  }

  // 8. chrome: title, north, legend, scale bar
  c.textAlign = 'left';
  c.font = '800 30px -apple-system, system-ui, sans-serif';
  c.fillStyle = '#eef3f6';
  c.fillText('JAKARTA', PAD, 62);
  c.font = '500 13px -apple-system, system-ui, sans-serif';
  c.fillStyle = '#93a1ad';
  c.fillText('miniatur kota · 9 distrik · 5 landmark', PAD, 84);
  c.textAlign = 'right';
  c.font = '800 16px -apple-system, system-ui, sans-serif';
  c.fillStyle = '#cfd8e0';
  c.fillText('N ↑', S - PAD, 62);

  const lx = PAD, ly = S - 140;
  c.textAlign = 'left';
  c.font = '600 12px -apple-system, system-ui, sans-serif';
  c.fillStyle = '#93a1ad';
  c.fillText('DISTRIK', lx, ly - 8);
  const NAMES = {
    monas: 'GAMBIR', thamrin: 'THAMRIN', kotatua: 'KOTA TUA', glodok: 'GLODOK',
    tanahabang: 'TANAH ABANG', kampung: 'KAMPUNG', blokm: 'BLOK M', kemang: 'KEMANG', ancol: 'ANCÓL',
  };
  Object.keys(COLORS).forEach((id, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = lx + col * 190, y = ly + 10 + row * 20;
    c.fillStyle = COLORS[id];
    c.fillRect(x, y, 14, 12);
    c.fillStyle = '#c2ccd4';
    c.font = '500 12px -apple-system, system-ui, sans-serif';
    c.fillText(NAMES[id] || id.toUpperCase(), x + 20, y + 10);
  });

  const barLen = 104 * scale;
  const barX = S - PAD - barLen, barY = S - 46;
  c.strokeStyle = '#cfd8e0'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(barX, barY); c.lineTo(barX + barLen, barY); c.stroke();
  c.beginPath(); c.moveTo(barX, barY - 4); c.lineTo(barX, barY + 4); c.stroke();
  c.beginPath(); c.moveTo(barX + barLen, barY - 4); c.lineTo(barX + barLen, barY + 4); c.stroke();
  c.fillStyle = '#93a1ad';
  c.font = '600 13px -apple-system, system-ui, sans-serif';
  c.textAlign = 'center';
  c.fillText('104 m', barX + barLen / 2, barY - 8);

  return cv.toDataURL('image/png');
});

fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/map-jakarta.png', Buffer.from(dataUrl.split(',')[1], 'base64'));
console.log('map written', fs.statSync('docs/map-jakarta.png').size);
await browser.close();
