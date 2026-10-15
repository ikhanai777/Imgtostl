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
    this.standMat = makePrintMaterial();
    this.pieceGroup = new THREE.Group();
    this.standGroup = new THREE.Group();
    this.scene.add(this.pieceGroup, this.standGroup);
    this.ground = new THREE.Group();
    this.scene.add(this.ground);

    this.textures = {};
    this.opts = { scene: 'studio', finish: 'matte', color: '#ff7a45', layerLines: true, turntable: false, orientation: 'flat' };
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
    if (this.meshes && (patch.scene !== undefined || patch.orientation !== undefined)) this.layout();
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

  show(pieceMesh, standMesh) {
    for (const grp of [this.pieceGroup, this.standGroup]) {
      for (const c of [...grp.children]) {
        c.geometry?.dispose();
        grp.remove(c);
      }
    }
    this.meshes = pieceMesh ? { piece: pieceMesh, stand: standMesh } : null;
    if (!pieceMesh) return;
    const piece = new THREE.Mesh(Preview3D.geometry(pieceMesh), this.pieceMat);
    piece.castShadow = piece.receiveShadow = true;
    this.pieceGroup.add(piece);
    if (standMesh) {
      const stand = new THREE.Mesh(Preview3D.geometry(standMesh), this.standMat);
      stand.castShadow = stand.receiveShadow = true;
      this.standGroup.add(stand);
    }
    this.layout();
  }

  // Place piece/stand for the chosen scene and rebuild the ground.
  layout() {
    const onBed = this.opts.scene === 'bed';
    const pg = this.pieceGroup;
    const sg = this.standGroup;
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
    const r = Math.max(size.x, size.y, size.z, 40) * 0.5;
    const dist = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.05;
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
