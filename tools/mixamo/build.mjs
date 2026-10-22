// Chuyển nhân vật & animation Mixamo (FBX) → GLB nén cho văn phòng ảo.
//
//   tools/mixamo/in/characters/<ten>.fbx     nhân vật: Mixamo → Download, Format FBX, Pose T-pose, With Skin
//   tools/mixamo/in/animations/<khoa>.fbx    animation: tải trên CÙNG MỘT nhân vật, Without Skin, 30 fps; khoá xem names.json
//
// Chạy: npm run nhanvat (ở thư mục gốc). Kết quả ghi vào public/models/people/ kèm people.json.
// Không phân phối lại file Mixamo (giấy phép Adobe) — mỗi người tự tải bằng tài khoản của mình.
import { readdirSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, textureCompress, meshopt, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const fbx2gltf = require('fbx2gltf');
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const IN = join(HERE, 'in'), TMP = join(HERE, '.tmp');
const OUT = process.env.OUT_DIR || join(ROOT, 'public/models/people');
const NAMES = JSON.parse(readFileSync(join(HERE, 'names.json'), 'utf8'));
const TARGET_HEIGHT = 1.74;

await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const listFbx = (dir) => existsSync(dir) ? readdirSync(dir).filter(f => /\.fbx$/i.test(f)).map(f => join(dir, f)) : [];
const hipsOf = (doc) => doc.getRoot().listNodes().find(n => /mixamorig:?\d*:?Hips$/.test(n.getName()) || n.getName() === 'mixamorigHips');

/** FBX → GLB thô, rồi chuẩn hoá tên xương mixamorigN: → mixamorig: */
async function fbxToDoc(fbx) {
  mkdirSync(TMP, { recursive: true });
  const raw = join(TMP, basename(fbx, '.fbx') + '.glb');
  await fbx2gltf(fbx, raw, ['--binary']);
  const doc = await io.read(raw);
  let renamed = 0;
  for (const n of doc.getRoot().listNodes()) {
    const nm = n.getName(), fixed = nm.replace(/^mixamorig\d+:/, 'mixamorig:');
    if (fixed !== nm) { n.setName(fixed); renamed++; }
  }
  return { doc, renamed };
}

// ---------------------------------------------------------------- nhân vật
const characters = [];
mkdirSync(join(OUT, 'characters'), { recursive: true });
for (const fbx of listFbx(join(IN, 'characters'))) {
  const id = slug(basename(fbx, '.fbx').replace(/_nonPBR$/i, ''));
  process.stdout.write(`Nhân vật ${id}… `);
  const { doc, renamed } = await fbxToDoc(fbx);
  const hips = hipsOf(doc);
  if (!hips || !doc.getRoot().listMeshes().length) { console.log('bỏ qua (không có xương/mesh Mixamo)'); continue; }
  for (const a of doc.getRoot().listAnimations()) a.dispose();           // T-pose 0s không cần
  await doc.transform(
    weld(), dedup(), prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512] }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  const file = `characters/${id}.glb`;
  await io.write(join(OUT, file), doc);
  characters.push({ id, file, hipsY: hips.getTranslation()[1] });
  console.log(`xong${renamed ? ` (đổi tên ${renamed} xương)` : ''}`);
}

// ---------------------------------------------------------------- animation Mixamo
const animations = {};
mkdirSync(join(OUT, 'animations'), { recursive: true });
for (const fbx of listFbx(join(IN, 'animations'))) {
  const key = slug(basename(fbx, '.fbx'));
  if (!NAMES.animations[key]) { console.log(`Animation ${key}: tên không có trong names.json → bỏ qua`); continue; }
  process.stdout.write(`Animation ${key}… `);
  const { doc } = await fbxToDoc(fbx);
  const hips = hipsOf(doc), anim = doc.getRoot().listAnimations()[0];
  if (!hips || !anim) { console.log('bỏ qua (không thấy animation)'); continue; }
  const refHipsY = hips.getTranslation()[1];
  for (const m of doc.getRoot().listMeshes()) m.dispose();
  for (const s of doc.getRoot().listSkins()) s.dispose();
  for (const n of doc.getRoot().listNodes()) if (n.getMesh()) n.setMesh(null);
  // chỉ giữ xoay xương + dịch chuyển hông
  for (const ch of anim.listChannels()) {
    const keep = ch.getTargetPath() === 'rotation' || (ch.getTargetPath() === 'translation' && ch.getTargetNode() === hips);
    if (!keep) { ch.getSampler()?.dispose(); ch.dispose(); }
  }
  anim.setName(key);
  await doc.transform(resample(), prune({ keepLeaves: true }), dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const file = `animations/${key}.glb`;
  await io.write(join(OUT, file), doc);
  animations[key] = { file, refHipsY };
  console.log('xong');
}

// ---------------------------------------------------------------- walk / run: lấy từ X Bot (bộ ví dụ three.js), chuyển sang rig nhân vật
if (characters.length) {
  try {
    const xbot = join(TMP, 'Xbot.glb');
    if (!existsSync(xbot)) {
      process.stdout.write('Tải X Bot (three.js examples)… ');
      const res = await fetch(NAMES.xbot);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(xbot, Buffer.from(await res.arrayBuffer()));
      console.log('xong');
    }
    const { retarget } = await import('./retarget.mjs');
    const target = join(OUT, characters[0].file);
    for (const clip of ['walk', 'run']) {
      process.stdout.write(`Animation ${clip} (chuyển từ X Bot)… `);
      const { refHipsY } = await retarget(io, xbot, target, clip, join(OUT, `animations/${clip}.glb`));
      animations[clip] = { file: `animations/${clip}.glb`, refHipsY };
      console.log('xong');
    }
  } catch (e) {
    console.log(`\nKhông làm được walk/run (${e.message}) — nhân viên sẽ chuyển chỗ tức thì thay vì đi bộ.`);
  }
}

// ---------------------------------------------------------------- people.json
if (!characters.length) {
  console.log('\nChưa có nhân vật nào trong tools/mixamo/in/characters/. Xem hướng dẫn trong README.');
} else {
  const missing = Object.keys(NAMES.animations).filter(k => !animations[k]);
  const idle = animations.idle ? 'idle' : Object.keys(animations)[0];
  const states = JSON.parse(JSON.stringify(NAMES.states));
  // thiếu animation nào thì thay bằng cái có
  const fix = (v) => Array.isArray(v) ? v.filter(k => animations[k]).concat(v.some(k => animations[k]) ? [] : [idle]) : (animations[v] ? v : idle);
  for (const k of Object.keys(states)) states[k] = fix(states[k]);
  const manifest = {
    _ghichu: 'Sinh bởi tools/mixamo/build.mjs. Nhân vật & animation từ Mixamo (Adobe) — không phân phối lại file này. refHipsY = độ cao hông của rig dùng khi xuất animation.',
    targetHeight: TARGET_HEIGHT,
    characters: characters.map(c => ({ id: c.id, file: c.file })),
    animations, states,
  };
  writeFileSync(join(OUT, 'people.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nĐã ghi ${characters.length} nhân vật, ${Object.keys(animations).length} animation vào public/models/people/people.json`);
  if (missing.length) console.log(`Thiếu animation: ${missing.join(', ')} (tạm dùng "${idle}" thay thế — tải thêm rồi chạy lại)`);
}
rmSync(TMP, { recursive: true, force: true });
