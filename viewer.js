// Scene, layout, interaction and UI. Dataset/geometry logic lives in datasets.js.
import * as THREE from 'three';
import { PRIM_MANIFEST, YCB_MANIFEST, loadManifest,
         isGraspable, pushFeas, pushKey, PUSH_COL, PUSH_LABEL, PUSH_BADGE,
         groupOf, GROUP_ORDER, GROUP_COL, CM, M,
         buildPrimGeom, buildProxyGeom, mergeSceneGeoms } from './datasets.js';


// ---------------------------------------------------------------------------
// manifests: prim is required, ycb is optional and shares the same schema.
// Each object is tagged with its dataset and the directory of its manifest so
// relative asset paths (preview meshes) resolve per dataset.
// ---------------------------------------------------------------------------

let PRIM, YCB = null;
try {
  PRIM = await loadManifest(PRIM_MANIFEST, 'prim');
} catch (e) {
  document.getElementById('app').style.display = 'none';
  document.getElementById('loaderr').style.display = 'block';
  throw e;
}
try {
  YCB = await loadManifest(YCB_MANIFEST, 'ycb');
} catch (e) {
  console.warn(`ycb manifest not loaded (${e.message}); showing primitives only`);
  document.querySelector('#f-dataset button[data-d="ycb"]').disabled = true;
}

const OBJS = [...PRIM.objects, ...(YCB ? YCB.objects : [])];
const SIMD = PRIM.sim_defaults || {};
document.getElementById('brand-sub').textContent =
  `PrimContact-v1 · ${PRIM.objects.length} prim` +
  (YCB ? `  +  YCB-USD-v1 · ${YCB.objects.length} scans` : '') + ` · μ=${SIMD.friction}`;


// ---- renderer / scene ----
const canvas = document.getElementById('cv');
const renderer = new THREE.WebGLRenderer({canvas, antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1216);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
camera.position.set(11, 9, 15);

// lights
scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x0a0e12, 0.75));
const key = new THREE.DirectionalLight(0xffffff, 1.15);
key.position.set(8, 16, 9);
key.castShadow = true;
key.shadow.mapSize.set(2048,2048);
const d=22; key.shadow.camera.left=-d;key.shadow.camera.right=d;
key.shadow.camera.top=d;key.shadow.camera.bottom=-d;key.shadow.camera.far=60;
scene.add(key);
const fill = new THREE.DirectionalLight(0x88aaff, 0.3);
fill.position.set(-10,6,-8); scene.add(fill);

// ground
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200,200),
  new THREE.MeshStandardMaterial({color:0x121820, roughness:.98, metalness:0})
);
ground.rotation.x = -Math.PI/2; ground.position.y = 0; ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(200, 200, 0x1c242c, 0x1c242c);
grid.position.y = 0.001; scene.add(grid);


// NOTE: the preview mesh must be in the same frame as the mesh used by
// compute_rest_poses.py, otherwise the rest poses will look wrong here.
async function loadPreviewMesh(it){
  const rel = it.o.sim?.preview_mesh;
  if (!rel) return;
  const url = it.o.base_dir + rel;
  const ext = url.split('.').pop().toLowerCase();
  try {
    let merged;
    if (ext === 'obj'){
      const {OBJLoader} = await import('three/addons/loaders/OBJLoader.js');
      merged = mergeSceneGeoms(await new OBJLoader().loadAsync(url));
    } else if (ext === 'glb' || ext === 'gltf'){
      const {GLTFLoader} = await import('three/addons/loaders/GLTFLoader.js');
      merged = mergeSceneGeoms((await new GLTFLoader().loadAsync(url)).scene);
    } else {
      console.warn(`${it.o.id}: unsupported preview_mesh type .${ext}`);
      return;
    }
    it.mesh.geometry.dispose();
    it.mesh.geometry = merged.geom;
    if (merged.map){
      merged.map.colorSpace = THREE.SRGBColorSpace;
      it.mesh.material.map = merged.map;
      it.mesh.material.needsUpdate = true;
      it.textured = true;
      console.log(`${it.o.id}: textured preview applied`);
    } else {
      console.warn(`${it.o.id}: preview loaded but no texture/uv found in GLB`);
    }
    it.mesh.material.transparent = false;
    it.mesh.material.opacity = 1;
    it.proxy = false;
    computePushFeasibility(it, true); // real mesh may change pose heights
    applyColors(); // textured items render natural (white) in group mode
    updateCount();
    applyPose(it, it.pose); // re-seat on the ground with the real bbox, re-place label
    if (selected === it){ setOutline(it); buildGhosts(it); }
  } catch (e) {
    console.warn(`${it.o.id}: preview mesh load failed (${e.message}); keeping bbox proxy`);
  }
}

// ---- build meshes ----
const items = []; // {o, holder, mesh, group, dataset, label, pose, proxy}
for (const o of OBJS){
  const proxy = o.dataset !== 'prim';
  const geom = proxy ? buildProxyGeom(o) : buildPrimGeom(o);
  const mat = new THREE.MeshStandardMaterial({roughness:.55, metalness:.05,
    transparent:proxy, opacity:proxy ? .55 : 1});
  const mesh = new THREE.Mesh(geom, mat);
  mesh.castShadow = true; mesh.receiveShadow = false;
  const holder = new THREE.Group();
  holder.rotation.x = -Math.PI/2; // sim Z-up -> three Y-up
  holder.add(mesh);
  scene.add(holder);
  const it = {o, holder, mesh, group:groupOf(o), dataset:o.dataset, pose:null, proxy};
  mesh.userData.it = it;
  items.push(it);
}

// ---- push feasibility from geometry ----
// A horizontal push needs the object top at least this high off the table,
// otherwise the gripper collides with it; vertical pushes always fit.
// Computed per rest pose from the actual geometry; a value already present
// in the manifest (offline computation) wins.
const H_PUSH_MIN_M = 0.085;
function computePushFeasibility(it, force=false){
  const pos = it.mesh.geometry.attributes.position;
  if (!pos) return;
  const stride = Math.max(1, Math.floor(pos.count / 4000));
  const q = new THREE.Quaternion(), v = new THREE.Vector3();
  const heightFor = (quat) => {
    let zmin = Infinity, zmax = -Infinity;
    for (let i = 0; i < pos.count; i += stride){
      v.fromBufferAttribute(pos, i).applyQuaternion(quat);
      if (v.z < zmin) zmin = v.z;
      if (v.z > zmax) zmax = v.z;
    }
    return (zmax - zmin) / M; // scene units -> meters
  };
  for (const p of (it.o.rest_poses || [])){
    if (p.push_feasibility && !(force && p.push_feasibility._computed)) continue;
    const [w,x,y,z] = p.quat_wxyz;
    q.set(x, y, z, w);
    const h = heightFor(q);
    p.push_feasibility = { horizontal: h >= H_PUSH_MIN_M, vertical: true,
                           height_m: Math.round(h*1000)/1000, _computed: true };
  }
  if (!(it.o.rest_poses || []).length && !it.o.push_feasibility){
    it.o.push_feasibility = { horizontal: heightFor(q.identity()) >= H_PUSH_MIN_M, vertical: true };
  }
}

// ---- rest poses ----
function applyPose(it, pose){
  it.pose = pose;
  if (pose){
    const [w,x,y,z] = pose.quat_wxyz;
    it.mesh.quaternion.set(x, y, z, w);
    it.mesh.position.set(0, 0, pose.spawn_z*M);
  } else {
    // display pose: identity in the sim frame (cylinders/prisms upright,
    // boxes tallest-dim up since z is the largest dim in the tables),
    // lowest vertex on the ground -- the original standing presentation
    it.mesh.quaternion.identity();
    it.mesh.geometry.computeBoundingBox();
    it.mesh.position.set(0, 0, -it.mesh.geometry.boundingBox.min.z);
  }
  placeLabel(it);
}

// ---- label sprites ----
function makeLabel(text){
  const c = document.createElement('canvas'); const s=256; c.width=s; c.height=64;
  const ctx = c.getContext('2d');
  ctx.fillStyle='rgba(0,0,0,0)'; ctx.fillRect(0,0,s,64);
  ctx.font='600 26px ui-monospace,Menlo,monospace';
  ctx.fillStyle='#8fa0ad'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(text, s/2, 34);
  const tex = new THREE.CanvasTexture(c); tex.anisotropy=4;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({map:tex, transparent:true, depthTest:false}));
  spr.scale.set(2.0,0.5,1);
  return spr;
}
// label sits just above the posed object's world bbox, on its own footprint
// (declared before the init loop below: applyPose -> placeLabel runs there)
const _box = new THREE.Box3();
function placeLabel(it){
  it.holder.updateMatrixWorld(true);
  _box.setFromObject(it.holder, true);
  it.label.position.set(it.holder.position.x, _box.max.y + 0.22, it.holder.position.z);
}

for (const it of items){
  it.label = makeLabel(it.o.id);
  scene.add(it.label);
  applyPose(it, null); // display pose; rest poses appear beside on selection
  computePushFeasibility(it);
  if (it.proxy) loadPreviewMesh(it);
}

// group divider labels (floating headers)
const headerSprites = {};
function makeHeader(text){
  const c=document.createElement('canvas'); c.width=512;c.height=96;
  const ctx=c.getContext('2d');
  ctx.font='700 46px ui-monospace,Menlo,monospace';
  ctx.fillStyle='#4fd6b8'; ctx.textAlign='left'; ctx.textBaseline='middle';
  ctx.fillText(text.toUpperCase(), 8, 52);
  const tex=new THREE.CanvasTexture(c); tex.anisotropy=4;
  const spr=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,transparent:true,depthTest:false}));
  spr.scale.set(6,1.1,1);
  scene.add(spr); return spr;
}
for(const g of GROUP_ORDER) headerSprites[g]=makeHeader(g);

// ---------------------------------------------------------------------------
// LAYOUT: grid, grouped in row-bands, aligned columns
// ---------------------------------------------------------------------------
const state = {dataset:'all', group:'all', sort:'default', graspOnly:false, hpushOnly:false,
               advOnly:false, labels:true, spin:true, color:'group'};
const SPACING = 3.4;      // cell size in scene units
const COLS = 8;           // columns per band

function visibleItems(){
  return items.filter(it=>{
    if(state.dataset!=='all' && it.dataset!==state.dataset) return false;
    if(state.group!=='all' && it.group!==state.group) return false;
    if(state.graspOnly && !isGraspable(it.o)) return false;
    if(state.hpushOnly && !pushFeas(it.o).h) return false;
    if(state.advOnly && !(it.o.tags||[]).includes('adversarial')) return false;
    return true;
  });
}

function sortKey(it){
  const o=it.o;
  if(state.sort==='longest') return o.longest_cm ?? 0;
  if(state.sort==='aspect')  return o.aspect_ratio ?? 1;
  if(state.sort==='poses')   return o.stable_poses ?? (o.rest_poses||[]).length;
  return 0;
}

function layout(){
  const list = visibleItems();
  // hide everything first
  for(const it of items){ it.holder.visible=false; it.label.visible=false; }
  for(const g of GROUP_ORDER) headerSprites[g].visible=false;

  // organise into bands by group (respect GROUP_ORDER), unless a single group selected
  const bands = (state.group==='all') ? GROUP_ORDER : [state.group];
  let row = 0;
  const placed = [];
  for(const g of bands){
    let band = list.filter(it=>it.group===g);
    if(!band.length) continue;
    band.sort((a,b)=> sortKey(a)-sortKey(b) || a.o.id.localeCompare(b.o.id));
    // header at left of the band's first row
    const hx = -( COLS*SPACING )/2 - 1.2;
    const hz = row*SPACING;
    if(state.group==='all'){
      const h=headerSprites[g]; h.visible=true;
      h.position.set(hx+2.4, 3.2, hz-1.9);
    }
    for(let i=0;i<band.length;i++){
      const col = i % COLS;
      const r   = row + Math.floor(i/COLS);
      const x = (col - (COLS-1)/2) * SPACING;
      const z = r * SPACING;
      const it = band[i];
      it.holder.visible=true;
      it.holder.position.set(x, 0, z);
      it.label.visible = state.labels;
      placeLabel(it);
      placed.push({it,x,z});
    }
    row += Math.ceil(band.length/COLS) + 1; // +1 blank row between bands
  }

  applyColors();
  // selection follows the layout: drop it if filtered out, else re-anchor ghosts
  if(selected){
    if(!selected.holder.visible) select(null);
    else placeGhosts(selected);
  }
  // recentre camera target on the placed cloud
  frameLayout(placed);
}

let camTarget = new THREE.Vector3(0,1,6);
let firstFit = true;
function frameLayout(placed){
  if(!placed.length) return;
  let minX=1e9,maxX=-1e9,minZ=1e9,maxZ=-1e9;
  for(const p of placed){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);
    minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z);}
  camTarget.set((minX+maxX)/2, 1, (minZ+maxZ)/2);
  if(firstFit){
    // open with a bird's-eye view fitted to the whole grid
    const span = Math.max(maxX-minX, maxZ-minZ) + 8;
    rad = Math.min(110, Math.max(16, span * 0.95));
    pol = 0.65;
    firstFit = false;
  }
}

function applyColors(){
  for(const it of items){
    if(!it.holder.visible) continue;
    const o=it.o; let col;
    // a texture map multiplies material.color, so white = natural appearance;
    // grasp/push/aspect modes tint the texture instead of hiding it
    if(state.color==='group') col = new THREE.Color(it.textured ? 0xffffff : GROUP_COL[it.group]);
    else if(state.color==='grasp') col = new THREE.Color(isGraspable(o)?0x4fd6b8:0xff6b6b);
    else if(state.color==='push') col = new THREE.Color(PUSH_COL[pushKey(pushFeas(o))]);
    else col = aspectColor(o.aspect_ratio ?? 1);
    it.mesh.material.color.copy(col);
    if((o.tags||[]).includes('adversarial')){
      it.mesh.material.emissive = new THREE.Color(0x552200);
      it.mesh.material.emissiveIntensity = 0.4;
    } else {
      it.mesh.material.emissiveIntensity = 0;
    }
  }
}

// aspect -> colour ramp (teal low -> red high)
function aspectColor(ar){
  const t = Math.min(1, Math.max(0, (ar-0.25)/(3-0.25)));
  const c1 = new THREE.Color(0x4fd6b8), c2 = new THREE.Color(0xff6b6b);
  return c1.clone().lerp(c2, t);
}

// ---------------------------------------------------------------------------
// simple orbit controls (no external dep)
// ---------------------------------------------------------------------------
let az=Math.atan2(camera.position.x,camera.position.z), pol=0.75, rad=20;
{
  const v=camera.position.clone().sub(camTarget); rad=v.length();
  pol=Math.acos(v.y/rad); az=Math.atan2(v.x,v.z);
}
let dragging=false, panning=false, px=0, py=0, dragDist=0;
canvas.addEventListener('contextmenu', e=>e.preventDefault());
canvas.addEventListener('pointerdown',e=>{
  dragging=true; panning=(e.button===2 || e.shiftKey);
  px=e.clientX; py=e.clientY; dragDist=0;
});
addEventListener('pointerup',e=>{
  if(!dragging) return;
  const wasPan=panning; dragging=false; panning=false;
  // a press that barely moved is a click: pin the hovered object
  if(dragDist<4 && e.target===canvas && e.button===0 && !wasPan) select(hovered);
});
addEventListener('pointermove',e=>{
  if(!dragging) return;
  const dx=e.clientX-px, dy=e.clientY-py;
  dragDist += Math.abs(dx)+Math.abs(dy);
  if(panning){
    // grab-the-ground pan: screen right/up mapped onto the ground plane
    const k = rad*0.0016;
    camTarget.addScaledVector(new THREE.Vector3(Math.cos(az),0,-Math.sin(az)), -dx*k);
    camTarget.addScaledVector(new THREE.Vector3(-Math.sin(az),0,-Math.cos(az)), -dy*k);
  } else {
    az -= dx*0.005; pol -= dy*0.005;
    pol=Math.max(0.15,Math.min(1.45,pol));
  }
  px=e.clientX; py=e.clientY;
});
canvas.addEventListener('wheel',e=>{e.preventDefault();
  rad*=(1+Math.sign(e.deltaY)*0.08); rad=Math.max(6,Math.min(120,rad));},{passive:false});

// ---------------------------------------------------------------------------
// hover picking + click selection
// ---------------------------------------------------------------------------
const ray=new THREE.Raycaster(), mouse=new THREE.Vector2();
const card=document.getElementById('card');
let hovered=null, selected=null;
canvas.addEventListener('pointermove',e=>{
  const r=canvas.getBoundingClientRect();
  mouse.x=((e.clientX-r.left)/r.width)*2-1;
  mouse.y=-((e.clientY-r.top)/r.height)*2+1;
  ray.setFromCamera(mouse,camera);
  const hits=ray.intersectObjects(items.filter(i=>i.holder.visible).map(i=>i.mesh));
  const it = hits.length ? hits[0].object.userData.it : null;
  if(it!==hovered){
    hovered=it;
    if(!selected){ it ? showCard(it,false) : card.style.display='none'; }
  }
});
addEventListener('keydown',e=>{ if(e.key==='Escape') select(null); });

// white edge outline on the pinned object; rebuilt on select since the
// geometry may be swapped later (proxy -> preview mesh)
let outline=null;
function setOutline(it){
  if(outline){ outline.parent.remove(outline); outline.geometry.dispose(); outline=null; }
  if(!it) return;
  outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(it.mesh.geometry, 25),
    new THREE.LineBasicMaterial({color:0xffffff, transparent:true, opacity:.8}));
  it.mesh.add(outline);
}

// ---------------------------------------------------------------------------
// rest-pose ghosts: on selection the full stable-pose set is laid out on a
// floating shelf centred above the object (one settled copy per pose,
// labelled idx · prob), with a dashed guide line down to the object. The
// elevation keeps the set clear of the grid; everything else is dimmed.
// ---------------------------------------------------------------------------
const GHOST_SPACING = 2.6;
const SHELF_Y = 4.2, SHELF_T = 0.08, SHELF_D = 3.0;
let ghosts = []; // {holder, mesh, label, idx}
let shelf = null; // {mesh, edges, guide}
function clearGhosts(){
  for(const g of ghosts){
    scene.remove(g.holder); scene.remove(g.label);
    g.mesh.material.dispose(); g.label.material.map.dispose(); g.label.material.dispose();
  }
  ghosts = [];
  if(shelf){
    for(const k of ['mesh','edges','guide']){ scene.remove(shelf[k]); shelf[k].geometry.dispose(); }
    shelf = null;
  }
}

function buildGhosts(it){
  clearGhosts();
  const rp = it.o.rest_poses||[];
  if(!rp.length) return;
  rp.forEach((p,i)=>{
    // clone from a NORMALIZED material: the source may still carry the
    // dimmed opacity of a previous selection
    const mat = it.mesh.material.clone();
    mat.opacity = it.proxy ? .55 : 1;
    mat.transparent = it.proxy;
    const mesh = new THREE.Mesh(it.mesh.geometry, mat);
    const [w,x,y,z] = p.quat_wxyz;
    mesh.quaternion.set(x, y, z, w);
    mesh.position.set(0, 0, p.spawn_z*M);
    const holder = new THREE.Group();
    holder.rotation.x = -Math.PI/2;
    holder.add(mesh);
    scene.add(holder);
    const label = makeLabel(`${i} · ${(p.prob*100).toFixed(0)}%`);
    label.scale.set(1.7,0.42,1);
    scene.add(label);
    ghosts.push({holder, mesh, label, idx:i});
  });
  // shelf panel sized to the row, plus a dashed guide down to the object
  const width = rp.length*GHOST_SPACING + 1.0;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, SHELF_T, SHELF_D),
    new THREE.MeshStandardMaterial({color:0x1a222b, roughness:.9, metalness:0,
      transparent:true, opacity:.9}));
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({color:0x4fd6b8, transparent:true, opacity:.35}));
  const guide = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineDashedMaterial({color:0x4fd6b8, dashSize:.18, gapSize:.12,
      transparent:true, opacity:.6}));
  scene.add(mesh); scene.add(edges); scene.add(guide);
  shelf = {mesh, edges, guide};
  placeGhosts(it);
}

function placeGhosts(it){
  if(!shelf) return;
  const bx = it.holder.position.x, bz = it.holder.position.z;
  const n = ghosts.length, topY = SHELF_Y + SHELF_T/2;
  for(const g of ghosts){
    g.holder.position.set(bx + (g.idx-(n-1)/2)*GHOST_SPACING, topY, bz);
    g.holder.updateMatrixWorld(true);
    _box.setFromObject(g.holder, true);
    g.label.position.set(g.holder.position.x, _box.max.y + 0.2, g.holder.position.z);
    // ghosts follow the object's current display colour (colour only, not opacity)
    g.mesh.material.color.copy(it.mesh.material.color);
  }
  shelf.mesh.position.set(bx, SHELF_Y, bz);
  shelf.edges.position.copy(shelf.mesh.position);
  it.holder.updateMatrixWorld(true);
  _box.setFromObject(it.holder, true);
  shelf.guide.geometry.setFromPoints([
    new THREE.Vector3(bx, _box.max.y + 0.05, bz),
    new THREE.Vector3(bx, SHELF_Y - SHELF_T/2, bz)]);
  shelf.guide.computeLineDistances();
}

function highlightGhost(i, on){
  const g = ghosts[i]; if(!g) return;
  g.mesh.material.emissive = new THREE.Color(0x4fd6b8);
  g.mesh.material.emissiveIntensity = on ? 0.5 : 0;
}

// fade everything except the selected object and its ghost row
function setDim(on){
  for(const it2 of items){
    const base = it2.proxy ? .55 : 1;
    const target = (on && it2!==selected) ? 0.12 : base;
    it2.mesh.castShadow = !(on && it2!==selected);
    it2.mesh.material.transparent = target < 1;
    it2.mesh.material.opacity = target;
    it2.mesh.material.needsUpdate = true;
    it2.label.material.opacity = (on && it2!==selected) ? 0.12 : 1;
  }
}

function select(it){
  document.getElementById('tip').classList.toggle('gone', !!it);
  selected = it;
  setOutline(it);
  clearGhosts();
  if(it) buildGhosts(it);
  setDim(!!it);
  if(it){
    // frame the object together with its pose shelf
    camTarget.set(it.holder.position.x, 2.2, it.holder.position.z);
    showCard(it,true);
  } else {
    layout(); // recentre the camera target on the grid
    if(hovered) showCard(hovered,false);
    else card.style.display='none';
  }
}

function fmtDims(o){
  const D=o.dims_cm;
  if(!D) return o.bbox_cm ? `bbox ${o.bbox_cm.join(' × ')} cm` : '—';
  return Array.isArray(D) ? `${D.join(' × ')} cm` : `⌀${D.diameter} × h${D.height} cm`;
}

function poseRow(it, p, i){
  const f = p.push_feasibility ? pushFeas({push_feasibility:p.push_feasibility}) : null;
  const k = f ? pushKey(f) : null;
  const glyph = !f ? '' : k==='hv' ? 'H·V' : k==='h' ? 'H' : k==='v' ? 'V' : '—';
  const contact = p.rolling ? 'rolling' : `margin ${(p.support_margin*1000).toFixed(0)} mm`;
  return `<div class="pose" data-i="${i}" style="--p:${(p.prob*100).toFixed(1)}%">
    <span class="pi">${i}</span><span class="pp">${(p.prob*100).toFixed(1)}%</span>
    <span>${contact}</span><span class="ph ${k??''}">${glyph}</span></div>`;
}

function showCard(it, pinned){
  const o = it.o;
  const modes = (o.modes_expected||[]).map(m=>`<span class="chip mode">${m}</span>`).join('');
  const tags = (o.tags||[]).map(t=>`<span class="chip tag">${t}</span>`).join('');
  const sim = o.sim || {};
  const pf = pushFeas(o), pk = pushKey(pf);
  const rp = o.rest_poses || [];
  const nposes = o.stable_poses ?? rp.length;
  card.classList.toggle('pinned', pinned);
  card.innerHTML = `
    <h3><span>${o.id}</span><small>${pinned ? 'pinned · esc' : o.dataset}</small></h3>
    <div class="type">${o.type} · ${nposes} stable pose${nposes!==1?'s':''}${it.proxy?' · bbox proxy':''}</div>
    <table>
      <tr><td class="k">dims</td><td class="v">${fmtDims(o)}</td></tr>
      <tr><td class="k">longest</td><td class="v">${o.longest_cm ?? '—'} cm</td></tr>
      <tr><td class="k">aspect</td><td class="v">${o.aspect_ratio ?? '—'}</td></tr>
      <tr><td class="k">mass</td><td class="v">${sim.mass ?? '—'} kg</td></tr>
      <tr><td class="k">μ ground</td><td class="v">${SIMD.friction ?? '—'}</td></tr>
      <tr><td class="k">asset</td><td class="v">${sim.asset_filename ?? sim.object_type ?? '—'}</td></tr>
      ${o.push_offset_cm!=null ? `<tr><td class="k">push offset</td><td class="v">${o.push_offset_cm} cm</td></tr>` : ''}
      <tr><td class="k">skills</td><td class="v">${(o.skills||[]).join(', ') || '—'}</td></tr>
    </table>
    <div class="badge ${isGraspable(o)?'yes':'no'}">
      ${isGraspable(o)?'GRASPABLE · 2F-140':'NOT GRASPABLE · push only'}
    </div>
    <div class="badge ${PUSH_BADGE[pk]}">${PUSH_LABEL[pk]}</div>
    <div class="chips">${modes}</div>
    ${tags?`<div class="chips">${tags}</div>`:''}
    ${pinned && rp.length ? `<div class="poses"><h5>rest poses · shown beside object</h5>
      ${rp.map((p,i)=>poseRow(it,p,i)).join('')}</div>` : ''}
  `;
  card.style.display='block';
  if(pinned){
    card.querySelectorAll('.pose').forEach(el=>{
      el.addEventListener('mouseenter',()=>highlightGhost(+el.dataset.i, true));
      el.addEventListener('mouseleave',()=>highlightGhost(+el.dataset.i, false));
    });
  }
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function seg(id, key, cast=(v)=>v){
  document.querySelectorAll(`#${id} button`).forEach(b=>{
    b.addEventListener('click',()=>{
      document.querySelectorAll(`#${id} button`).forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      state[key]=cast(b.dataset[Object.keys(b.dataset)[0]]);
      layout(); updateCount();
    });
  });
}
seg('f-dataset','dataset'); seg('f-group','group'); seg('f-sort','sort'); seg('f-color','color');
function updateGroupPanel(){
  const off = state.dataset === 'ycb';
  document.querySelectorAll('#f-group button').forEach(b=>{
    if(b.dataset.g !== 'all') b.disabled = off;
  });
  if(off && state.group !== 'all'){
    state.group = 'all';
    document.querySelectorAll('#f-group button').forEach(x=>x.classList.toggle('on', x.dataset.g === 'all'));
  }
}
document.querySelectorAll('#f-dataset button').forEach(b=>
  b.addEventListener('click', ()=>{ updateGroupPanel(); layout(); updateCount(); }));
document.getElementById('f-grasp').onchange=e=>{state.graspOnly=e.target.checked;layout();updateCount();};
document.getElementById('f-hpush').onchange=e=>{state.hpushOnly=e.target.checked;layout();updateCount();};
document.getElementById('f-adv').onchange=e=>{state.advOnly=e.target.checked;layout();updateCount();};
document.getElementById('f-labels').onchange=e=>{state.labels=e.target.checked;layout();};
document.getElementById('f-spin').onchange=e=>{state.spin=e.target.checked;};

function updateCount(){
  const vis=visibleItems();
  const n=vis.length;
  const grasp=vis.filter(it=>isGraspable(it.o)).length;
  const hpush=vis.filter(it=>pushFeas(it.o).h).length;
  const unk=vis.filter(it=>!pushFeas(it.o).known).length;
  document.getElementById('count').innerHTML=
    `showing <b>${n}</b> / ${OBJS.length} objects<br>graspable: <b>${grasp}</b>` +
    `<br>horizontal push: <b>${hpush}</b>${unk?` <span style="opacity:.6">(${unk} not evaluated)</span>`:''}`;
}
function buildLegend(){
  const L=document.getElementById('legend');
  const sw=hex=>`<i style="background:#${hex.toString(16).padStart(6,'0')}"></i>`;
  if(state.color==='group'){
    L.innerHTML = GROUP_ORDER.filter(g=>g!=='ycb'||YCB).map(g=>`<div>${sw(GROUP_COL[g])}${g}</div>`).join('');
  } else if(state.color==='grasp'){
    L.innerHTML = `<div>${sw(0x4fd6b8)}graspable</div>
                   <div>${sw(0xff6b6b)}push/place only</div>`;
  } else if(state.color==='push'){
    L.innerHTML = `<div>${sw(PUSH_COL.hv)}horizontal + vertical</div>
                   <div>${sw(PUSH_COL.h)}horizontal only</div>
                   <div>${sw(PUSH_COL.v)}vertical only</div>
                   <div>${sw(PUSH_COL.none)}neither</div>
                   <div>${sw(PUSH_COL.unk)}not evaluated</div>`;
  } else {
    L.innerHTML = `<div>${sw(0x4fd6b8)}low aspect (flat)</div>
                   <div>${sw(0xff6b6b)}high aspect (tall)</div>`;
  }
}
document.querySelectorAll('#f-color button').forEach(b=>b.addEventListener('click',buildLegend));

// ---------------------------------------------------------------------------
// resize + render loop
// ---------------------------------------------------------------------------
function resize(){
  const r=document.getElementById('stage').getBoundingClientRect();
  renderer.setSize(r.width,r.height,false);
  camera.aspect=r.width/r.height; camera.updateProjectionMatrix();
}
addEventListener('resize',resize);

const SIM_Z = new THREE.Vector3(0,0,1); // holder-local z == world up
let ct=new THREE.Vector3().copy(camTarget);
function tick(){
  requestAnimationFrame(tick);
  ct.lerp(camTarget,0.08);
  camera.position.set(
    ct.x + rad*Math.sin(pol)*Math.sin(az),
    ct.y + rad*Math.cos(pol),
    ct.z + rad*Math.sin(pol)*Math.cos(az)
  );
  camera.lookAt(ct);
  if(state.spin){
    // yaw about the sim z axis so the rest pose is preserved
    for(const it of items) if(it.holder.visible) it.holder.rotateOnAxis(SIM_Z, 0.006);
    for(const g of ghosts) g.holder.rotateOnAxis(SIM_Z, 0.006);
  }
  renderer.render(scene,camera);
}

resize(); buildLegend(); layout(); updateCount(); tick();