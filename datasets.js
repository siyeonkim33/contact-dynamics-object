// Dataset side of the viewer: manifest loading, per-object field helpers,
// and geometry construction (sim-frame primitive builders, bbox proxies,
// preview-mesh merging). No scene / UI state lives here.
import * as THREE from 'three';

const PRIM_MANIFEST = './prim/primcontact_v1.json';
const YCB_MANIFEST  = './ycb/ycb_v1.json';

async function loadManifest(path, dataset){
  // cache-bust: manifests are regenerated often and a stale cached copy
  // silently shows an outdated object set
  const res = await fetch(path + '?t=' + Date.now());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const m = await res.json();
  const baseDir = path.slice(0, path.lastIndexOf('/') + 1);
  for (const o of m.objects){ o.dataset = dataset; o.base_dir = baseDir; }
  return m;
}

// ---- per-object field helpers ----
// `graspable` is the canonical field; `pickable` is accepted for older manifests.
const isGraspable = o => o.graspable ?? o.pickable ?? false;

// Push feasibility is computed offline (gripper offset vs. table collision) and
// stored as {horizontal, vertical}. It is pose-dependent -- a flat disk may be
// too low for a horizontal push when lying, fine when on its rim -- so a
// per-rest-pose entry is also accepted; the object-level flag wins when
// present, otherwise poses are OR-ed. Missing everywhere -> "not evaluated".
function pushFeas(src){
  let f = src.push_feasibility;
  if (!f && src.rest_poses){
    const pf = src.rest_poses.map(p => p.push_feasibility).filter(Boolean);
    if (pf.length) f = { horizontal: pf.some(p => p.horizontal), vertical: pf.some(p => p.vertical) };
  }
  if (!f) return { known:false, h:false, v:false };
  return { known:true, h:!!f.horizontal, v:!!f.vertical };
}
const pushKey = f => !f.known ? 'unk' : (f.h && f.v) ? 'hv' : f.h ? 'h' : f.v ? 'v' : 'none';
const PUSH_COL   = { hv:0x4fd6b8, h:0x6aa9ff, v:0xffb454, none:0xff6b6b, unk:0x5a6a75 };
const PUSH_LABEL = { hv:'PUSH · H + V', h:'PUSH · H only', v:'PUSH · V only', none:'PUSH · none', unk:'PUSH · not evaluated' };
const PUSH_BADGE = { hv:'yes', h:'h', v:'v', none:'no', unk:'unk' };

// group key helper
const groupOf = o =>
  o.dataset === 'ycb' ? 'ycb'
  : (o.type === 'cube' || o.type === 'cylinder' || o.type === 'cuboid') ? o.type : 'poly';

const GROUP_ORDER = ['cube','cylinder','cuboid','poly','ycb'];
const GROUP_COL = { cube:0x6aa9ff, cylinder:0xffb454, cuboid:0x4fd6b8, poly:0xc792ea, ycb:0xff8fb1 };
const CM = 0.1; // scene units: 1 unit = 10 cm, so cm * 0.1 -> keeps grid readable
const M  = 10;  // meters -> scene units (spawn_z, preview meshes are in meters)

// ---------------------------------------------------------------------------
// geometry factory -- built in the SIM frame (Z-up), matching
// build_prim_objects.py::build_primitive_mesh exactly, so that the rest-pose
// quaternions / spawn_z from the manifest can be applied verbatim. Each mesh
// lives under a holder group with rotation.x = -pi/2 (sim Z-up -> three Y-up).
// ---------------------------------------------------------------------------
function extrudeZ(pts, depth){
  // polygon in sim xy, extruded along +z, then centred (== trimesh extrude_polygon + translate)
  const sh = new THREE.Shape();
  sh.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, {depth, bevelEnabled:false});
  g.translate(0, 0, -depth/2);
  return g;
}

function tetraGeom(s){
  // trimesh definition: vertices (+-1,+-1,+-1) subset, scaled so the longest
  // bbox extent equals s -> vertices at +-s/2; bbox centroid is already 0
  const h = s/2;
  const V = [[h,h,h],[h,-h,-h],[-h,h,-h],[-h,-h,h]];
  const F = [[0,1,2],[0,3,1],[0,2,3],[1,3,2]];
  const pos = [];
  for (const f of F) for (const i of f) pos.push(...V[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

function buildPrimGeom(o){
  const t = o.type, D = o.dims_cm;
  let g;
  if (t === 'cube' || t === 'cuboid'){
    g = new THREE.BoxGeometry(D[0]*CM, D[1]*CM, D[2]*CM);
  } else if (t === 'cylinder'){
    const r = D.diameter/2*CM;
    g = new THREE.CylinderGeometry(r, r, D.height*CM, 48);
    g.rotateX(Math.PI/2); // axis Y -> Z
  } else if (t === 'hex_prism'){
    // dims = [across_flats, across_flats, height]; trimesh takes the circumradius
    const r = (D[0]/2)/Math.cos(Math.PI/6)*CM;
    // thetaStart = pi/2 puts a vertex on sim +x like trimesh, so facet-down
    // rest poses land on a facet rather than an edge
    g = new THREE.CylinderGeometry(r, r, D[2]*CM, 6, 1, false, Math.PI/2);
    g.rotateX(Math.PI/2);
  } else if (t === 'pyramid'){
    // square base of side `base` -> circumradius base/sqrt(2), apex on +z
    g = new THREE.ConeGeometry(D[0]/Math.SQRT2*CM, D[2]*CM, 4, 1, false, Math.PI/2);
    g.rotateX(Math.PI/2);
  } else if (t === 'cone'){
    g = new THREE.ConeGeometry(D[0]/2*CM, D[2]*CM, 48);
    g.rotateX(Math.PI/2);
  } else if (t === 'tri_prism'){
    // dims = [triangle_size, triangle_size, prism_length]
    const a = D[0]*CM, L = D[2]*CM;
    g = extrudeZ([[-a/2,-a/2],[a/2,-a/2],[0,a/2]], L);
  } else if (t === 'l_block'){
    // L footprint, NOT recentred in xy: the CoM offset is what makes it adversarial
    const [x,y,z] = D.map(v => v*CM);
    g = extrudeZ([
      [-x/2,-y/2], [x/2,-y/2], [x/2,-y/2+0.4*y],
      [-x/2+0.4*x,-y/2+0.4*y], [-x/2+0.4*x,y/2], [-x/2,y/2],
    ], z);
  } else if (t === 'tetra'){
    g = tetraGeom(D[0]*CM);
  } else {
    g = new THREE.BoxGeometry(1,1,1);
  }
  g.computeVertexNormals();
  return g;
}

function buildProxyGeom(o){
  // bounding-box stand-in for assets we cannot render (USD); replaced by the
  // preview mesh if the manifest provides one
  const D = o.bbox_cm || (Array.isArray(o.dims_cm) ? o.dims_cm
          : [o.longest_cm || 8, o.longest_cm || 8, o.shortest_cm || 8]);
  return new THREE.BoxGeometry(D[0]*CM, D[1]*CM, D[2]*CM);
}

// flatten a loaded obj/gltf scene into one non-indexed geometry (sim frame,
// meters -> scene units), keeping UVs and the first texture map so YCB scans
// can render with their real appearance
function _concat(arrays, itemSize){
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Float32Array(total);   // spreading 100k+ floats into push() overflows the stack
  let off = 0;
  for (const a of arrays){ out.set(a, off); off += a.length; }
  return new THREE.BufferAttribute(out, itemSize);
}

function mergeSceneGeoms(root){
  root.updateMatrixWorld(true);
  const positions = [], uvs = [];
  let map = null, allHaveUv = true;
  root.traverse(ch => {
    if (!ch.isMesh) return;
    const g = ch.geometry.index ? ch.geometry.toNonIndexed() : ch.geometry.clone();
    g.applyMatrix4(ch.matrixWorld);
    positions.push(g.attributes.position.array);
    if (g.attributes.uv) uvs.push(g.attributes.uv.array); else allHaveUv = false;
    // material can be an array (multi-primitive glTF meshes)
    for (const mm of (Array.isArray(ch.material) ? ch.material : [ch.material])){
      if (!map && mm && mm.map) map = mm.map;
    }
  });
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', _concat(positions, 3));
  if (map && allHaveUv && uvs.length) bg.setAttribute('uv', _concat(uvs, 2));
  bg.scale(M, M, M);
  bg.computeVertexNormals();
  return {geom: bg, map: (allHaveUv && uvs.length) ? map : null};
}

export { PRIM_MANIFEST, YCB_MANIFEST, loadManifest,
         isGraspable, pushFeas, pushKey, PUSH_COL, PUSH_LABEL, PUSH_BADGE,
         groupOf, GROUP_ORDER, GROUP_COL, CM, M,
         buildPrimGeom, buildProxyGeom, mergeSceneGeoms };