// Chuyển một clip từ rig X Bot (xương không có xoay nghỉ) sang rig Mixamo FBX (có xoay nghỉ)
// bằng cách giữ "độ lệch xoay so với tư thế nghỉ" trong hệ toạ độ thế giới của từng xương.
import { prune, dedup, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

// Quaternion tối giản (x,y,z,w) — tránh kéo cả three.js vào công cụ dòng lệnh
const Q = {
  mul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
  },
  inv: (a) => [-a[0], -a[1], -a[2], a[3]],
  norm(a) { const l = Math.hypot(...a) || 1; return a.map(v => v / l); },
  slerp(a, b, t) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (d < 0) { b = b.map(v => -v); d = -d; }
    if (d > 0.9995) return Q.norm(a.map((v, i) => v + (b[i] - v) * t));
    const th = Math.acos(d), s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
    return a.map((v, i) => v * wa + b[i] * wb);
  },
};

function hier(doc) {
  const nodes = doc.getRoot().listNodes(), parent = new Map(), byName = new Map();
  for (const n of nodes) { byName.set(n.getName(), n); for (const c of n.listChildren()) parent.set(c, n); }
  return { nodes, parent, byName };
}
const restWorld = (H) => {
  const memo = new Map();
  const f = (n) => { if (memo.has(n)) return memo.get(n); const p = H.parent.get(n); const w = p ? Q.mul(f(p), n.getRotation()) : [...n.getRotation()]; memo.set(n, w); return w; };
  return f;
};
const sampleIdx = (times, t) => { let i = 0; while (i < times.length - 2 && times[i + 1] < t) i++; const j = Math.min(i + 1, times.length - 1); const k = times[j] > times[i] ? Math.min(1, Math.max(0, (t - times[i]) / (times[j] - times[i]))) : 0; return [i, j, k]; };

/** @returns {{ refHipsY: number }} */
export async function retarget(io, srcFile, tgtFile, clipName, outFile) {
  const src = await io.read(srcFile), tgt = await io.read(tgtFile);
  const S = hier(src), T = hier(tgt);
  const SrestW = restWorld(S), TrestW = restWorld(T);
  const anim = src.getRoot().listAnimations().find(a => a.getName() === clipName);
  if (!anim) throw new Error(`X Bot không có clip ${clipName}`);
  const rotCh = new Map(); let hipsT = null, dur = 0;
  for (const ch of anim.listChannels()) {
    const n = ch.getTargetNode(), s = ch.getSampler(), times = s.getInput().getArray(), vals = s.getOutput().getArray();
    dur = Math.max(dur, times[times.length - 1]);
    if (ch.getTargetPath() === 'rotation') rotCh.set(n, { times, vals });
    if (ch.getTargetPath() === 'translation' && n.getName().endsWith('Hips')) hipsT = { times, vals };
  }
  const sampleQ = ({ times, vals }, t) => { const [i, j, k] = sampleIdx(times, t); return Q.slerp([...vals.slice(i * 4, i * 4 + 4)], [...vals.slice(j * 4, j * 4 + 4)], k); };
  const sampleV = ({ times, vals }, t) => { const [i, j, k] = sampleIdx(times, t); return [0, 1, 2].map(c => vals[i * 3 + c] * (1 - k) + vals[j * 3 + c] * k); };

  const FPS = 30, N = Math.round(dur * FPS) + 1;
  const times = Float32Array.from({ length: N }, (_, i) => Math.min(dur, i / FPS));
  const tgtBones = T.nodes.filter(n => /^mixamorig:/.test(n.getName()));
  const out = new Map(tgtBones.map(n => [n, new Float32Array(N * 4)]));
  for (let f = 0; f < N; f++) {
    const t = times[f];
    const Sw = new Map();
    const sw = (n) => { if (Sw.has(n)) return Sw.get(n); const p = S.parent.get(n); const l = rotCh.has(n) ? sampleQ(rotCh.get(n), t) : [...n.getRotation()]; const w = p ? Q.mul(sw(p), l) : l; Sw.set(n, w); return w; };
    const Tw = new Map();
    const tw = (n) => {
      if (Tw.has(n)) return Tw.get(n);
      const p = T.parent.get(n), sn = S.byName.get(n.getName());
      const w = sn && /^mixamorig:/.test(n.getName())
        ? Q.mul(Q.mul(sw(sn), Q.inv(SrestW(sn))), TrestW(n))
        : Q.mul(p ? tw(p) : [0, 0, 0, 1], n.getRotation());
      Tw.set(n, w); return w;
    };
    for (const n of tgtBones) {
      const p = T.parent.get(n);
      const local = Q.norm(Q.mul(p ? Q.inv(tw(p)) : [0, 0, 0, 1], tw(n)));
      out.get(n).set(local, f * 4);
    }
  }
  const root = tgt.getRoot();
  for (const a of root.listAnimations()) a.dispose();
  for (const n of root.listNodes()) if (n.getMesh()) n.setMesh(null);
  for (const m of root.listMeshes()) m.dispose();
  for (const s of root.listSkins()) s.dispose();
  const buf = root.listBuffers()[0] ?? tgt.createBuffer();
  const input = tgt.createAccessor().setType('SCALAR').setArray(times).setBuffer(buf);
  const newAnim = tgt.createAnimation(clipName);
  for (const [n, arr] of out) {
    const s = tgt.createAnimationSampler().setInput(input).setOutput(tgt.createAccessor().setType('VEC4').setArray(arr).setBuffer(buf));
    newAnim.addSampler(s).addChannel(tgt.createAnimationChannel().setTargetNode(n).setTargetPath('rotation').setSampler(s));
  }
  const srcHips = S.byName.get('mixamorig:Hips');
  if (hipsT) {
    const arr = new Float32Array(N * 3);
    for (let f = 0; f < N; f++) arr.set(sampleV(hipsT, times[f]), f * 3);
    const s = tgt.createAnimationSampler().setInput(input).setOutput(tgt.createAccessor().setType('VEC3').setArray(arr).setBuffer(buf));
    newAnim.addSampler(s).addChannel(tgt.createAnimationChannel().setTargetNode(T.byName.get('mixamorig:Hips')).setTargetPath('translation').setSampler(s));
  }
  await tgt.transform(prune({ keepLeaves: true }), dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  await io.write(outFile, tgt);
  return { refHipsY: srcHips.getTranslation()[1] };
}
