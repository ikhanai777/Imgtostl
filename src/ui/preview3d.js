import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------
export const SCENES = {
  studio: { label: 'Studio', bg: 0xd6d2cb },
  table: { label: 'Wooden table', bg: 0x2a221c },
  bed: { label: 'On the print bed', bg: 0x1c1f24 },
};

// grain: 0 none, 1 wood, 2 marble
export const FINISHES = {
  matte: { label: 'Matte PLA', roughness: 0.62, metalness: 0, clearcoat: 0, sheen: 0.35, grain: 0, layer: 1 },
  silk: { label: 'Silk PLA', roughness: 0.26, metalness: 0.45, clearcoat: 0.35, sheen: 0.6, grain: 0, layer: 1.2 },
  glossy: { label: 'Glossy resin', roughness: 0.08, metalness: 0, clearcoat: 1, sheen: 0, grain: 0, layer: 0 },
  metal: { label: 'Metal (brass-fill)', roughness: 0.32, metalness: 0.95, clearcoat: 0.2, sheen: 0, grain: 0, layer: 0.7 },
  wood: { label: 'Wood PLA', roughness: 0.85, metalness: 0, clearcoat: 0, sheen: 0.2, grain: 1, layer: 1.6, color: '#9a6a3c' },
  marble: { label: 'Marble PLA', roughness: 0.4, metalness: 0, clearcoat: 0.3, sheen: 0, grain: 2, layer: 0.8, color: '#d9d5cc' },
};

const NOISE_GLSL = /* glsl */ `
float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i + vec3(0,0,0)), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
`;

/**
 * Physical material with object-space procedural grain and FDM layer lines.
 * Layer lines fade out automatically when they would be smaller than a pixel.
 */
function makePrintMaterial() {
  const uniforms = {
    uLayerH: { value: 0.2 },
    uLayerAxis: { value: new THREE.Vector3(0, 0, 1) },
    uLayerAmp: { value: 1 },
    uGrain: { value: 0 },
    uGrainColor: { value: new THREE.Color(0x8c8a88) },
  };
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xff7a45 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjNormal;\nvarying vec3 vAxisView;\nuniform vec3 uLayerAxis;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvObjPos = position;\nvObjNormal = normal;\nvAxisView = normalize(normalMatrix * uLayerAxis);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vObjPos; varying vec3 vObjNormal; varying vec3 vAxisView;
uniform float uLayerH; uniform vec3 uLayerAxis; uniform float uLayerAmp; uniform float uGrain; uniform vec3 uGrainColor;
${NOISE_GLSL}
float layerCoord() { return dot(vObjPos, uLayerAxis) / uLayerH; }
float layerFade() { float c = layerCoord(); return clamp(1.2 - fwidth(c) * 1.6, 0.0, 1.0); }
float wallFactor() { return 1.0 - abs(dot(normalize(vObjNormal), uLayerAxis)); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
if (uGrain > 0.5 && uGrain < 1.5) {
  // Long, gently wavy grain running along X, plus a little fibre speckle.
  float coord = vObjPos.y * 0.55 + fbm(vObjPos * vec3(0.015, 0.08, 0.08)) * 6.0;
  float rings = pow(abs(sin(coord)), 3.0);
  diffuseColor.rgb *= mix(1.03, 0.84, rings) * mix(0.95, 1.03, vnoise(vObjPos * vec3(0.4, 4.0, 4.0)));
} else if (uGrain > 1.5) {
  float v = abs(sin(vObjPos.x * 0.11 + vObjPos.y * 0.07 + fbm(vObjPos * 0.12) * 7.0));
  float fine = abs(sin(vObjPos.x * 0.31 - vObjPos.y * 0.19 + fbm(vObjPos * 0.3 + 7.0) * 5.0));
  diffuseColor.rgb = mix(uGrainColor, diffuseColor.rgb, smoothstep(0.0, 0.18, v) * 0.6 + 0.4);
  diffuseColor.rgb = mix(uGrainColor, diffuseColor.rgb, smoothstep(0.0, 0.06, fine) * 0.35 + 0.65);
  diffuseColor.rgb *= mix(0.94, 1.03, vnoise(vObjPos * 2.0));
}
{
  float ridge = cos(layerCoord() * 6.2831853) * 0.5 + 0.5;
  diffuseColor.rgb *= 1.0 - uLayerAmp * 0.07 * layerFade() * wallFactor() * ridge;
}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
normal = normalize(normal + vAxisView * (-sin(layerCoord() * 6.2831853)) * uLayerAmp * 0.45 * layerFade() * wallFactor());`,
      );
  };
  mat.userData.uniforms = uniforms;
  return mat;
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

function woodTexture() {
  return canvasTexture(1024, 1024, (ctx, w, h) => {
    const r = rng(11);
    ctx.fillStyle = '#7b5232';
    ctx.fillRect(0, 0, w, h);
    // planks
    const planks = 4;
    for (let p = 0; p < planks; p++) {
      const y0 = (p * h) / planks;
      const tone = 0.85 + r() * 0.3;
      ctx.fillStyle = `rgba(${Math.round(125 * tone)},${Math.round(84 * tone)},${Math.round(50 * tone)},1)`;
      ctx.fillRect(0, y0, w, h / planks);
      for (let i = 0; i < 70; i++) {
        const y = y0 + r() * (h / planks);
        const amp = 2 + r() * 8;
        const freq = 0.004 + r() * 0.01;
        const phase = r() * 6.28;
        ctx.strokeStyle = r() > 0.5 ? `rgba(60,36,20,${0.08 + r() * 0.2})` : `rgba(170,120,80,${0.05 + r() * 0.12})`;
        ctx.lineWidth = 0.6 + r() * 2.2;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 8) {
          const yy = y + Math.sin(x * freq + phase) * amp;
          if (x) ctx.lineTo(x, yy);
          else ctx.moveTo(x, yy);
        }
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(30,18,10,0.55)';
      ctx.fillRect(0, y0, w, 2);
    }
  });
}

function peiTexture() {
  return canvasTexture(512, 512, (ctx, w, h) => {
    const r = rng(5);
    ctx.fillStyle = '#a8792b';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) {
      const v = r();
      ctx.fillStyle = v > 0.5 ? `rgba(255,220,150,${0.15 + r() * 0.2})` : `rgba(60,35,10,${0.12 + r() * 0.2})`;
      ctx.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2);
    }
  });
}

// ---------------------------------------------------------------------------
export class Preview3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.camera = new THREE.PerspectiveCamera(30, 1, 1, 5000);
    this.camera.position.set(80, 90, 260);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotateSpeed = 1.6;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a7f72, 0.5);
    this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xfff4e6, 2.4);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.6;
    this.key.shadow.radius = 4;
    this.scene.add(this.key, this.key.target);
    this.rim = new THREE.DirectionalLight(0xcfe0ff, 0.9);
    this.scene.add(this.rim);

    this.pieceMat = makePrintMaterial();
    // Extra filaments for multi-colour parts (frame, text).
    this.partMats = { 1: this.pieceMat, 2: makePrintMaterial(), 3: makePrintMaterial() };
    this.standMat = makePrintMaterial();
    this.pieceGroup = new THREE.Group();
    this.standGroup = new THREE.Group();
    this.scene.add(this.pieceGroup, this.standGroup);
    this.ground = new THREE.Group();
    this.scene.add(this.ground);

    this.textures = {};
    this.opts = {
      scene: 'studio',
      finish: 'matte',
      color: '#ff7a45',
      color2: '#2f3a4a',
      color3: '#f3efe6',
      layerLines: true,
      turntable: false,
      orientation: 'flat',
    };
    this.fitted = false;
    this.meshes = null;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setOptions(patch) {
    const prev = this.opts;
    this.opts = { ...this.opts, ...patch };
    this.controls.autoRotate = !!this.opts.turntable;
    this.applyMaterials();
    if (patch.scene && patch.scene !== prev.scene) this.fitted = false;
    if (this.meshes && (patch.scene !== undefined || patch.orientation !== undefined || patch.props !== undefined)) this.layout();
  }

  applyMaterials() {
    const f = FINISHES[this.opts.finish] || FINISHES.matte;
    // Wood and marble filaments have their own colour.
    const color = f.color || this.opts.color;
    const setup = (mat, c, finish) => {
      mat.color.set(c);
      mat.roughness = finish.roughness;
      mat.metalness = finish.metalness;
      mat.clearcoat = finish.clearcoat;
      mat.clearcoatRoughness = 0.2;
      mat.sheen = finish.sheen;
      mat.sheenColor = new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.5);
      const u = mat.userData.uniforms;
      u.uGrain.value = finish.grain;
      u.uLayerAmp.value = this.opts.layerLines ? finish.layer : 0;
      // Layers stack along the print's up axis: Z when printed flat, Y upright.
      u.uLayerAxis.value.set(0, this.opts.orientation === 'upright' ? 1 : 0, this.opts.orientation === 'upright' ? 0 : 1);
      mat.needsUpdate = true;
    };
    setup(this.pieceMat, color, f);
    setup(this.partMats[2], this.opts.color2, { ...f, color: undefined });
    setup(this.partMats[3], this.opts.color3, { ...f, color: undefined });
    // Stands print upright on their base: layers along Y.
    setup(this.standMat, '#3a3d42', { ...FINISHES.matte, layer: f.layer ? 1 : 0 });
    this.standMat.userData.uniforms.uLayerAxis.value.set(0, 1, 0);
  }

  static geometry({ positions, indices }) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    // Smooth curved walls, keep crisp edges between walls and faces.
    const creased = toCreasedNormals(g, (35 * Math.PI) / 180);
    g.dispose();
    return creased;
  }

  show(pieceMesh, standMesh, partMeshes = null, standProps = null) {
    if (this.propGroup) {
      this.propGroup.parent?.remove(this.propGroup);
      this.propGroup.traverse((o) => o.geometry?.dispose());
      this.propGroup = null;
    }
    for (const grp of [this.pieceGroup, this.standGroup]) {
      for (const c of [...grp.children]) {
        c.geometry?.dispose();
        grp.remove(c);
      }
    }
    this.meshes = pieceMesh ? { piece: pieceMesh, stand: standMesh } : null;
    if (!pieceMesh) return;
    const sources = partMeshes?.length ? partMeshes : [{ ...pieceMesh, color: 1 }];
    for (const src of sources) {
      const mesh = new THREE.Mesh(Preview3D.geometry(src), this.partMats[src.color] || this.pieceMat);
      mesh.castShadow = mesh.receiveShadow = true;
      this.pieceGroup.add(mesh);
    }
    if (standMesh) {
      const stand = new THREE.Mesh(Preview3D.geometry(standMesh), this.standMat);
      stand.castShadow = stand.receiveShadow = true;
      this.standGroup.add(stand);
      if (standProps) this.propGroup = buildProps(standProps);
    }
    this.layout();
  }

  // Place piece/stand for the chosen scene and rebuild the ground.
  layout() {
    const onBed = this.opts.scene === 'bed';
    const pg = this.pieceGroup;
    const sg = this.standGroup;
    // Props are placed after the layout so they never affect it.
    if (this.propGroup) sg.remove(this.propGroup);
    pg.position.set(0, 0, 0);
    sg.position.set(0, 0, 0);
    pg.rotation.set(0, 0, 0);
    sg.rotation.set(0, 0, 0);
    const box = (o) => new THREE.Box3().setFromObject(o);

    if (onBed) {
      // Show how it prints: lying flat (or upright) with the stand beside it.
      if (this.opts.orientation !== 'upright') pg.rotation.x = -Math.PI / 2;
      pg.updateMatrixWorld(true);
      const pb = box(pg);
      pg.position.set(-(pb.min.x + pb.max.x) / 2, -pb.min.y, -(pb.min.z + pb.max.z) / 2);
      if (sg.children.length) {
        pg.updateMatrixWorld(true);
        const p2 = box(pg);
        const sb = box(sg);
        sg.position.set(-(sb.min.x + sb.max.x) / 2, -sb.min.y, p2.max.z + 12 - sb.min.z);
        // Re-centre both on the plate.
        sg.updateMatrixWorld(true);
        const all = box(pg).union(box(sg));
        const dz = -(all.min.z + all.max.z) / 2;
        pg.position.z += dz;
        sg.position.z += dz;
      }
    } else {
      // On display: standing upright in its stand (if any), centred.
      let floor = 0;
      if (sg.children.length) floor = box(sg).min.y;
      const all = box(pg);
      if (sg.children.length) all.union(box(sg));
      const dx = -(all.min.x + all.max.x) / 2;
      const dz = -(all.min.z + all.max.z) / 2;
      pg.position.set(dx, -floor, dz);
      sg.position.set(dx, -floor, dz);
    }
    pg.updateMatrixWorld(true);
    sg.updateMatrixWorld(true);
    const bounds = box(pg);
    if (sg.children.length) bounds.union(box(sg));
    this.buildGround(bounds);
    if (this.propGroup && this.opts.props !== false && !onBed) sg.add(this.propGroup);
    if (!this.fitted) this.fit();
  }

  buildGround(bounds) {
    for (const c of [...this.ground.children]) {
      c.geometry?.dispose();
      this.ground.remove(c);
    }
    const size = bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, size.y, 60);
    const sceneDef = SCENES[this.opts.scene] || SCENES.studio;
    const bg = new THREE.Color(sceneDef.bg);
    this.scene.background = bg;
    this.scene.fog = new THREE.Fog(bg, span * 3, span * 9);

    if (this.opts.scene === 'table') {
      this.textures.wood ||= woodTexture();
      const tex = this.textures.wood;
      const W = span * 6;
      tex.repeat.set(W / 400, W / 400);
      const top = new THREE.Mesh(
        new THREE.BoxGeometry(W, 20, W * 0.6),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0 }),
      );
      top.position.y = -10.01;
      top.receiveShadow = true;
      this.ground.add(top);
      this.hemi.intensity = 0.35;
      this.key.color.set(0xffe2bf);
      this.key.intensity = 2.6;
      this.scene.environmentIntensity = 0.45;
    } else if (this.opts.scene === 'bed') {
      this.textures.pei ||= peiTexture();
      const tex = this.textures.pei;
      const P = Math.max(256, Math.ceil(Math.max(size.x, size.z) / 10) * 10 + 40);
      tex.repeat.set(P / 120, P / 120);
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(P, 1.2, P),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0.25 }),
      );
      plate.position.y = -0.61;
      plate.receiveShadow = true;
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(P + 30, 18, P + 30),
        new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.6 }),
      );
      body.position.y = -10.2;
      body.receiveShadow = true;
      this.ground.add(plate, body);
      this.hemi.intensity = 0.45;
      this.key.color.set(0xffffff);
      this.key.intensity = 2.2;
      this.scene.environmentIntensity = 0.6;
    } else {
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(span * 30, span * 30),
        new THREE.MeshStandardMaterial({ color: sceneDef.bg, roughness: 0.95 }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      this.ground.add(floor);
      this.hemi.intensity = 0.45;
      this.key.color.set(0xfff4e6);
      this.key.intensity = 2.0;
      this.scene.environmentIntensity = 0.45;
    }

    // Light rig scaled to the object.
    const c = bounds.getCenter(new THREE.Vector3());
    this.key.position.set(c.x + span * 0.9, span * 1.6, c.z + span * 1.1);
    this.key.target.position.copy(c);
    const sc = this.key.shadow.camera;
    sc.left = sc.bottom = -span;
    sc.right = sc.top = span;
    sc.near = span * 0.2;
    sc.far = span * 5;
    sc.updateProjectionMatrix();
    this.rim.position.set(c.x - span, span * 0.8, c.z - span * 1.4);
  }

  fit() {
    const bounds = new THREE.Box3().setFromObject(this.pieceGroup);
    if (this.standGroup.children.length) bounds.union(new THREE.Box3().setFromObject(this.standGroup));
    if (bounds.isEmpty()) return;
    const size = bounds.getSize(new THREE.Vector3());
    const c = bounds.getCenter(new THREE.Vector3());
    // Fit the bounding sphere, so deep bases (cups, bookends) don't push the
    // art towards the camera and out of frame. Narrow views fit horizontally.
    const r = Math.max(size.length() * 0.5, 30);
    const vHalf = (this.camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const dist = (r / Math.sin(Math.min(vHalf, hHalf))) * 0.92;
    const dir = this.opts.scene === 'bed' ? new THREE.Vector3(0.45, 0.85, 0.75) : new THREE.Vector3(0.5, 0.28, 1);
    dir.normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.camera.near = dist / 50;
    this.camera.far = dist * 30;
    this.camera.updateProjectionMatrix();
    this.fitted = true;
  }

  /** Render a high-resolution PNG of the current view. */
  async snapshot(scale = 2) {
    const r = this.renderer;
    const prev = r.getPixelRatio();
    r.setPixelRatio(Math.min(4, prev * scale));
    r.setSize(this.container.clientWidth, this.container.clientHeight, false);
    r.render(this.scene, this.camera);
    const blob = await new Promise((res) => r.domElement.toBlob(res, 'image/png'));
    r.setPixelRatio(prev);
    this.resize();
    return blob;
  }
}

// ---------------------------------------------------------------------------
// Display-only props that show what each holder is for.
// ---------------------------------------------------------------------------
const PENCIL_COLORS = [0xf2c230, 0x2f6fdf, 0xe2483d, 0x2fa36b, 0x1d1d1f, 0xf08a24, 0x8e5bd6];

function std(color, roughness = 0.6, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, ...extra });
}

function pencil(color, length) {
  const g = new THREE.Group();
  const r = 3.6;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, length, 6), std(color, 0.45));
  body.position.y = length / 2;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(r, 12, 6), std(0xe8c99a, 0.8));
  cone.position.y = length + 6;
  const lead = new THREE.Mesh(new THREE.ConeGeometry(1.1, 3.6, 12), std(0x2a2a2a, 0.4));
  lead.position.y = length + 10.3;
  g.add(body, cone, lead);
  return g;
}

function buildProps(props) {
  const g = new THREE.Group();
  const rand = rng(42);
  const shadow = (o) => o.traverse((m) => m.isMesh && ((m.castShadow = true), (m.receiveShadow = true)));
  const cav = props.cavities || [];

  if (props.type === 'pencil' || props.type === 'organizer') {
    // Pens in the back compartments; the organizer's last cavity is its front tray.
    const back = props.type === 'organizer' ? cav.slice(0, -1) : cav;
    back.forEach((c, k) => {
      const n = Math.max(2, Math.min(9, Math.floor(((c.x1 - c.x0) * (c.z1 - c.z0)) / 260)));
      for (let i = 0; i < n; i++) {
        const p = pencil(PENCIL_COLORS[(i + k * 3) % PENCIL_COLORS.length], 150 + rand() * 30);
        p.position.set(c.x0 + 5 + rand() * (c.x1 - c.x0 - 10), c.yFloor, c.z0 + 5 + rand() * (c.z1 - c.z0 - 10));
        p.rotation.set((rand() - 0.5) * 0.25, rand() * Math.PI, (rand() - 0.5) * 0.25);
        g.add(p);
      }
    });
    if (props.type === 'organizer') {
      const t = cav[cav.length - 1];
      const cx = (t.x0 + t.x1) / 2;
      const cz = (t.z0 + t.z1) / 2;
      for (let i = 0; i < 3; i++) {
        const eraser = new THREE.Mesh(new THREE.BoxGeometry(18, 7, 10), std([0xff8fa3, 0x7ec8e3, 0xffffff][i], 0.7));
        eraser.position.set(cx - 30 + i * 22, t.yFloor + 3.5, cz + (rand() - 0.5) * 6);
        eraser.rotation.y = (rand() - 0.5) * 0.5;
        g.add(eraser);
      }
      const clip = new THREE.Mesh(new THREE.TorusGeometry(4, 0.6, 6, 24), std(0xc0c4c8, 0.3, { metalness: 0.9 }));
      clip.scale.set(1, 2.4, 1);
      clip.rotation.x = Math.PI / 2;
      clip.position.set(cx + 38, t.yFloor + 0.7, cz);
      g.add(clip);
    }
  } else if (props.type === 'tray') {
    const t = cav[0];
    const cx = (t.x0 + t.x1) / 2;
    const cz = (t.z0 + t.z1) / 2;
    const gold = std(0xd4a640, 0.35, { metalness: 1 });
    for (let i = 0; i < 4; i++) {
      const coin = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 1.8, 40), gold);
      coin.position.set(cx - 20 + i * 4, t.yFloor + 0.9 + i * 1.8, cz - 2);
      g.add(coin);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(9, 1.6, 16, 48), std(0xe6e8ea, 0.2, { metalness: 1 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(cx + 18, t.yFloor + 1.6, cz + 2);
    g.add(ring);
  } else if (props.type === 'planter') {
    const c = cav[0];
    const cx = (c.x0 + c.x1) / 2;
    const cz = (c.z0 + c.z1) / 2;
    const soilY = c.yFloor + (c.yTop - c.yFloor) * 0.82;
    const soil = new THREE.Mesh(new THREE.BoxGeometry(c.x1 - c.x0 - 1, 2, c.z1 - c.z0 - 1), std(0x4a3426, 1));
    soil.position.set(cx, soilY - 1, cz);
    g.add(soil);
    // A succulent rosette: leaves spiralling out by the golden angle.
    const leafMat = std(0x7fae7a, 0.55);
    const size = Math.min(c.x1 - c.x0, c.z1 - c.z0) * 0.42;
    for (let i = 0; i < 26; i++) {
      const t = i / 26;
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), leafMat);
      const len = size * (0.35 + 0.65 * t);
      leaf.scale.set(len * 0.32, len * 0.14, len * 0.55);
      const a = i * 2.39996;
      const rr = len * 0.45;
      leaf.position.set(cx + Math.cos(a) * rr, soilY + size * 0.35 * (1 - t) + 2, cz + Math.sin(a) * rr);
      leaf.rotation.set(0, -a + Math.PI / 2, 0);
      leaf.rotateX(-(0.2 + 0.9 * t));
      g.add(leaf);
    }
  } else if (props.type === 'candle' && props.candle) {
    const { x, y, z, r } = props.candle;
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(r - 0.5, r - 0.5, 16, 48, 1, true), std(0xd9dde2, 0.25, { metalness: 1, side: THREE.DoubleSide }));
    cup.position.set(x, y + 8, z);
    const wax = new THREE.Mesh(new THREE.CylinderGeometry(r - 0.8, r - 0.8, 13, 48), std(0xf7f3ea, 0.5));
    wax.position.set(x, y + 6.5, z);
    const flame = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffc46b }),
    );
    flame.scale.set(1, 2.4, 1);
    flame.position.set(x, y + 21, z);
    const light = new THREE.PointLight(0xffa14a, 9000, 0, 2);
    light.position.set(x, y + 21, z);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.bias = -0.002;
    g.add(cup, wax, flame, light);
  } else if (props.type === 'bookend' && props.books) {
    const b = props.books;
    const colors = [0x8c2f39, 0x2b4c7e, 0xd9b44a, 0x3c6e47, 0x5a4a78];
    let z = b.z1;
    for (let i = 0; i < 5 && z - 18 > b.z0; i++) {
      const th = 18 + rand() * 18;
      const h = Math.max(b.h + 20, 150) + rand() * 50;
      const w = Math.min(150, b.x1 - b.x0 + 40) - rand() * 20;
      const book = new THREE.Mesh(new THREE.BoxGeometry(w, h, th), std(colors[i % colors.length], 0.7));
      book.position.set((b.x0 + b.x1) / 2 + (rand() - 0.5) * 8, b.y + h / 2, z - th / 2 - 0.5);
      g.add(book);
      z -= th + 0.5;
    }
  }
  shadow(g);
  return g;
}
