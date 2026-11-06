// A person must not change species when he is shot: the corpse has to be built from the character
// asset's own part meshes, not from its own boxes, and it must not take the city's shared materials
// hostage while it fades.
//
// Asserts
//   (a) a pedestrian's corpse carries the same geometry *objects* the pedestrian was drawn with
//       (head, torso, arm, leg, shoe) and the same skin/shirt/pants colour
//   (b) the body ends up lying on the road, not floating and not sunk
//   (c) the fade at the end of its life touches only the corpse's own material copies: every other
//       pedestrian and the player keep opacity 1 on the same materials
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const URL = process.env.DTA_URL || 'http://127.0.0.1:8765/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info) => {
  checks.push({ name, ok: !!ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(info)}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__game !== undefined', { timeout: 60000 });
  await page.click('#start-btn');
  await sleep(1500);

  // ---- punch one pedestrian and keep every reference alive
  const staged = await page.evaluate(() => {
    const g = window.__game;
    // a pavement spot away from traffic: stand on the strip a pedestrian is walking on
    const live = g.peds.peds.filter((p) => !p.dead && !p.vendor && !p.leader && !p.partner);
    if (!live.length) return { ok: false, why: 'no pedestrians' };
    const ped = live[0];
    const near = g.peds.nearestLeg(ped.pos.x, ped.pos.z);
    const L = g.peds.legs[near.leg];
    const ground = g.city.groundHeightAt(ped.pos.x, ped.pos.z);
    // the player stands one metre behind the victim and faces it: punch() only reaches 2.3 m in
    // front of the camera, so the victim has to be inside that cone
    const px = ped.pos.x - L.ux * 1.2;
    const pz = ped.pos.z - L.uz * 1.2;
    g._test.teleport(px, pz);
    g.player.y = g.city.groundHeightAt(px, pz);
    ped.pos.set(ped.pos.x, ground, ped.pos.z);
    ped.target = ped.pos.clone();
    ped.speed = 0;
    // face the victim: punch() only reaches 2.3 m inside the camera's forward cone
    g._test.face(ped.pos.x, ped.pos.z);
    const body = ped.char;
    const refs = {
      head: body.head.children[0].geometry,
      hair: body.head.children[1].geometry,
      torso: body.torso.children[0].geometry,
      hips: body.torso.children[1].geometry,
      arm: body.armL.children[0].geometry,
      hand: body.armL.children[body.armL.children.length - 1].geometry,
      leg: body.legL.children[0].geometry,
      shoe: body.legL.children[1].geometry,
    };
    // every material this pedestrian is drawn with: the corpse must own copies of all of them,
    // because these are shared city-wide (one MATS cache for 46 pedestrians and the player)
    const matUuids = [];
    body.group.traverse((o) => {
      if (o.isMesh && !matUuids.includes(o.material.uuid)) matUuids.push(o.material.uuid);
    });
    window.__ref = {
      ped,
      refs,
      matUuids,
      colour: {
        shirt: '#' + body.torso.children[0].material.color.getHexString(),
        pants: '#' + body.legL.children[0].material.color.getHexString(),
        skinHex: '#' + body.head.children[0].material.color.getHexString(),
      },
      shirtMat: body.torso.children[0].material.uuid,
      before: g.ragdolls.length,
      ground,
      at: [ped.pos.x, ped.pos.z],
    };
    return { ok: true, ped: ped.pos.toArray().map((v) => +v.toFixed(2)), ground: +ground.toFixed(2), ragdolls: g.ragdolls.length };
  });
  if (!staged.ok) throw new Error(staged.why);
  console.log('STAGE', JSON.stringify(staged));

  // the punch happens through the game's own path, so the corpse is spawned exactly as a kill does
  const killed = await page.evaluate(() => {
    const g = window.__game;
    const ref = window.__ref;
    g._test.punch();
    // a pavement is crowded: pick the corpse that is wearing the victim's shirt, not just the last
    // one spawned, and remember it for the rest of the run
    const fresh = g.ragdolls.slice(ref.before);
    const trunkOf = (corpse) => {
      let hit = null;
      corpse.group.traverse((o) => {
        if (!hit && o.isMesh && o.geometry === ref.refs.torso) hit = o;
      });
      return hit;
    };
    const mine = fresh.find((r) => {
      const m = trunkOf(r);
      return m && '#' + m.material.color.getHexString() === ref.colour.shirt;
    });
    window.__corpse = mine || null;
    return {
      fresh: fresh.length,
      before: ref.before,
      matched: !!mine,
      dead: !!ref.ped.dead,
      shirts: fresh.map((r) => {
        const m = trunkOf(r);
        return m ? '#' + m.material.color.getHexString() : null;
      }),
      wantShirt: ref.colour.shirt,
    };
  });
  check('a punch turns the pedestrian into a corpse', killed.fresh >= 1 && killed.dead && killed.matched, killed);

  // ---- (a) identity: the corpse is the pedestrian's own body
  const identity = await page.evaluate(() => {
    if (!window.__corpse) return { missing: true };
    const g = window.__game;
    const ref = window.__ref;
    const corpse = window.__corpse;
    // locate a part of the corpse by the geometry object the pedestrian was drawn with
    const of = (geo) => {
      let hit = null;
      corpse.group.traverse((o) => {
        if (!hit && o.isMesh && o.geometry === geo) hit = o;
      });
      return hit;
    };
    const parts = {};
    for (const [name, geo] of Object.entries(ref.refs)) {
      const mesh = of(geo);
      parts[name] = mesh ? { sameObject: true, colour: '#' + mesh.material.color.getHexString(), sharedMaterial: mesh.material.uuid === ref.shirtMat } : { sameObject: false };
    }
    // every mesh of the corpse must own its material: writing to a shared one would fade the crowd
    let meshes = 0;
    let ownMaterials = 0;
    const borrowed = [];
    corpse.group.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      if (ref.matUuids.includes(o.material.uuid)) borrowed.push(o.material.uuid);
      else ownMaterials++;
    });
    return {
      parts,
      meshes,
      ownMaterials,
      borrowed: borrowed.slice(0, 3),
      colour: {
        shirt: parts.torso.colour,
        pants: parts.leg.colour,
        skin: parts.head.colour,
      },
      expect: { shirt: ref.colour.shirt, pants: ref.colour.pants, skin: ref.colour.skinHex },
    };
  });
  if (identity.missing) throw new Error('no corpse carried the victim\'s shirt: cannot judge its body');
  const sameObjects = Object.values(identity.parts).every((p) => p.sameObject);
  const sameColours =
    identity.colour.shirt === identity.expect.shirt &&
    identity.colour.pants === identity.expect.pants &&
    identity.colour.skin === identity.expect.skin;
  check('the corpse is the pedestrian\'s own body (same geometry objects)', sameObjects, {
    parts: Object.entries(identity.parts).map(([k, v]) => [k, v.sameObject]),
  });
  check('the corpse wears the dead pedestrian\'s colours', sameColours, { got: identity.colour, expect: identity.expect });
  check('the corpse owns its materials instead of writing to the city\'s', identity.ownMaterials === identity.meshes && identity.meshes > 6, {
    meshes: identity.meshes,
    ownMaterials: identity.ownMaterials,
    borrowed: identity.borrowed,
  });

  // ---- (b) the body settles on the road: run its own update at a fixed step until it stops
  const settled = await page.evaluate(() => {
    const g = window.__game;
    const corpse = window.__corpse;
    const dt = 1 / 60;
    let last = null;
    let still = 0;
    for (let i = 0; i < 420; i++) {
      corpse.update(dt, g.city.colliders);
      const hips = corpse.points.hips.p;
      if (last && Math.hypot(hips.x - last[0], hips.y - last[1], hips.z - last[2]) < 0.004) still++;
      else still = 0;
      last = [hips.x, hips.y, hips.z];
      if (still > 30) break;
    }
    const box = new g.THREE.Box3().setFromObject(corpse.group);
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const ground = g.city.groundHeightAt(cx, cz);
    return {
      stillFrames: still,
      lowest: +box.min.y.toFixed(3),
      highest: +box.max.y.toFixed(3),
      ground: +ground.toFixed(3),
      gapToGround: +(box.min.y - ground).toFixed(3),
      length: +Math.max(box.max.x - box.min.x, box.max.z - box.min.z).toFixed(2),
      height: +(box.max.y - box.min.y).toFixed(2),
      width: +Math.min(box.max.x - box.min.x, box.max.z - box.min.z).toFixed(2),
    };
  });
  check('the corpse comes to rest on the road (not floating, not sunk)', Math.abs(settled.gapToGround) < 0.03 && settled.stillFrames > 10, settled);
  check('the corpse reads as a lying human body', settled.length > 1.2 && settled.length < 2.6 && settled.height < 1.2 && settled.height > 0.15, {
    length: settled.length,
    height: settled.height,
    width: settled.width,
  });

  // ---- (c) the fade is the corpse's own: the crowd and the player keep their materials
  const fade = await page.evaluate(() => {
    const g = window.__game;
    const corpse = window.__corpse;
    const dt = 1 / 60;
    // walk the body into the last second of its life, where it fades out
    corpse.life = corpse.maxLife - 0.6;
    for (let i = 0; i < 4; i++) corpse.update(dt, g.city.colliders);
    // every opaque body material in the city, read through the pedestrians
    let checked = 0;
    let hurt = [];
    for (const p of g.peds.peds) {
      if (p.dead) continue;
      for (const mesh of [p.char.torso.children[0], p.char.torso.children[1], p.char.legL.children[0]]) {
        const m = mesh.material;
        checked++;
        if (m.opacity !== 1 || m.transparent === true) hurt.push({ opacity: m.opacity, transparent: m.transparent });
      }
    }
    const corpseMats = [];
    corpse.group.traverse((o) => {
      if (o.isMesh && !corpseMats.includes(o.material)) corpseMats.push(o.material);
    });
    const faded = corpseMats.filter((m) => m.transparent === true && m.opacity < 0.5).length;
    return { checked, hurt: hurt.slice(0, 3), hurtCount: hurt.length, faded, corpseMaterials: corpseMats.length };
  });
  check('the corpse fades', fade.faded > 0 && fade.faded >= fade.corpseMaterials - 1, fade);
  check('the fade leaves every pedestrian\'s colour untouched', fade.hurtCount === 0 && fade.checked > 20, fade);

  check('no page errors', errors.length === 0, errors.slice(0, 3));

  const pass = checks.filter((c) => c.ok).length;
  console.log('SUMMARY ' + JSON.stringify({ pass, total: checks.length }));
  if (pass !== checks.length) process.exitCode = 1;
} finally {
  await browser.close();
}
