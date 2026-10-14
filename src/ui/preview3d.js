import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class Preview3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    this.camera.position.set(80, 90, 260);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(120, 200, 260);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xbcd4ff, 0.8);
    rim.position.set(-200, 80, -220);
    this.scene.add(rim);

    this.pieceMat = new THREE.MeshStandardMaterial({ color: 0xff7a45, roughness: 0.55, metalness: 0.05 });
    this.standMat = new THREE.MeshStandardMaterial({ color: 0x8aa4c8, roughness: 0.6, metalness: 0.05 });
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.grid = null;
    this.fitted = false;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  setColor(hex) {
    this.pieceMat.color.set(hex);
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  static geometry({ positions, indices }) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    const flat = g.toNonIndexed();
    flat.computeVertexNormals();
    g.dispose();
    return flat;
  }

  show(pieceMesh, standMesh, thickness) {
    for (const c of [...this.group.children]) {
      c.geometry?.dispose();
      this.group.remove(c);
    }
    if (!pieceMesh) return;
    const piece = new THREE.Mesh(Preview3D.geometry(pieceMesh), this.pieceMat);
    // Centre the slab on z so it sits nicely on the stand / grid.
    this.group.add(piece);
    let floorY = 0;
    if (standMesh) {
      const stand = new THREE.Mesh(Preview3D.geometry(standMesh), this.standMat);
      this.group.add(stand);
      stand.geometry.computeBoundingBox();
      floorY = stand.geometry.boundingBox.min.y;
    }
    const box = new THREE.Box3().setFromObject(this.group);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    this.group.position.set(-center.x, -floorY, -(thickness || 0) / 2);

    if (this.grid) this.scene.remove(this.grid);
    const span = Math.ceil(Math.max(size.x, size.z, 100) / 10) * 10 * 2;
    this.grid = new THREE.GridHelper(span, span / 10, 0x888888, 0x555555);
    this.grid.material.opacity = 0.35;
    this.grid.material.transparent = true;
    this.scene.add(this.grid);

    if (!this.fitted) this.fit(size);
  }

  fit(size) {
    const s = size || new THREE.Box3().setFromObject(this.group).getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.y, 40);
    const dist = r / Math.tan((this.camera.fov * Math.PI) / 360) * 0.75;
    this.controls.target.set(0, s.y / 2, 0);
    this.camera.position.set(dist * 0.35, s.y / 2 + dist * 0.2, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.fitted = true;
  }
}
