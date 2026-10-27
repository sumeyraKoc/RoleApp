import * as THREE from "three";
import type { CharacterLook } from "./townMap";

/**
 * A soft, rounded toy figure (capsule body and limbs, round head, dot eyes).
 * One model turns to any direction; walking and talking are animated in code.
 * The class keeps its old name so the rest of the game is unchanged.
 */
export class BlockCharacter {
  readonly root = new THREE.Group();
  /** Target facing angle (radians around +y; 0 faces +z). */
  yaw = 0;
  private readonly body = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly legL: THREE.Object3D;
  private readonly legR: THREE.Object3D;
  private readonly armL: THREE.Object3D;
  private readonly armR: THREE.Object3D;
  private phase = Math.random() * Math.PI * 2;
  private talkUntil = 0;

  constructor(look: CharacterLook) {
    this.root.add(this.body);
    const mat = (color: string) => new THREE.MeshLambertMaterial({ color });
    const pants = mat(look.pants);
    const shirt = mat(look.shirt);
    const skin = mat(look.skin);
    const hair = mat(look.hair);
    const shoe = mat("#3a2f2a");

    // Legs and shoes
    this.legL = this.limb(0.105, 0.4, pants, -0.12, 0.66);
    this.legR = this.limb(0.105, 0.4, pants, 0.12, 0.66);
    for (const leg of [this.legL, this.legR]) {
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), shoe);
      foot.scale.set(1, 0.6, 1.35);
      foot.position.set(0, -0.6, 0.04);
      foot.castShadow = true;
      leg.add(foot);
    }

    // Body
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.3, 6, 14), shirt);
    torso.scale.set(1, 1, 0.78);
    torso.position.y = 1.0;
    torso.castShadow = true;
    this.body.add(torso);
    if (look.apron) {
      const apron = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.22, 4, 10), mat("#f7f4ec"));
      apron.scale.set(1, 1, 0.35);
      apron.position.set(0, 0.95, 0.12);
      this.body.add(apron);
    }

    // Arms with round hands
    this.armL = this.limb(0.085, 0.36, shirt, -0.32, 1.3);
    this.armR = this.limb(0.085, 0.36, shirt, 0.32, 1.3);
    for (const arm of [this.armL, this.armR]) {
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), skin);
      hand.position.y = -0.55;
      arm.add(hand);
    }

    // Head: a big round head (chibi proportions), hair cap, dot eyes and blush.
    this.head.position.set(0, 1.42, 0);
    this.body.add(this.head);
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.31, 20, 16), skin);
    face.position.y = 0.3;
    face.castShadow = true;
    this.head.add(face);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.325, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), hair);
    cap.position.y = 0.31;
    cap.rotation.x = -0.32;
    cap.castShadow = true;
    this.head.add(cap);
    const eyeMat = new THREE.MeshBasicMaterial({ color: look.eye });
    const blushMat = new THREE.MeshBasicMaterial({ color: "#f29a9a", transparent: true, opacity: 0.55 });
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.042, 10, 8), eyeMat);
      eye.scale.set(1, 1.35, 0.6);
      eye.position.set(side * 0.105, 0.3, 0.285);
      this.head.add(eye);
      const blush = new THREE.Mesh(new THREE.CircleGeometry(0.045, 12), blushMat);
      blush.position.set(side * 0.17, 0.22, 0.262);
      blush.rotation.y = side * 0.55;
      this.head.add(blush);
    }

    if (look.hat) {
      const hatMat = mat(look.hat);
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.04, 20), hatMat);
      brim.position.y = 0.52;
      const pointy = look.hatShape === "pointy";
      const crown = pointy
        ? new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.7, 20), hatMat)
        : new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.22, 20), hatMat);
      crown.position.y = pointy ? 0.88 : 0.64;
      if (pointy) crown.rotation.z = -0.18;
      this.head.add(brim, crown);
    }
    if (look.ribbon) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.035, 8, 24), mat(look.ribbon));
      band.rotation.x = Math.PI / 2 - 0.32;
      band.position.y = 0.42;
      this.head.add(band);
    }

    // Soft contact shadow (the sun also casts a real one).
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.34, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    this.root.add(shadow);
    this.body.scale.setScalar(0.95);
  }

  /** Nod and gesture for `seconds` (used while the NPC's reply is on screen or being spoken). */
  talk(seconds: number, now: number): void {
    this.talkUntil = Math.max(this.talkUntil, now + seconds * 1000);
  }

  update(dt: number, moving: boolean, now: number): void {
    const talking = now < this.talkUntil;
    this.phase += dt * (moving ? 10 : talking ? 7 : 2);
    const swing = moving ? Math.sin(this.phase) * 0.7 : 0;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.armL.rotation.x = -swing * 0.8;
    this.armR.rotation.x = talking && !moving ? -0.5 + Math.sin(this.phase) * 0.35 : swing * 0.8;
    this.armL.rotation.z = -0.12;
    this.armR.rotation.z = 0.12;
    this.head.rotation.x = talking ? Math.sin(this.phase * 1.3) * 0.08 : 0;
    this.head.rotation.z = moving ? 0 : Math.sin(this.phase * 0.5) * 0.03;
    this.body.position.y = moving ? Math.abs(Math.cos(this.phase)) * 0.06 : Math.sin(this.phase) * 0.01;

    let delta = this.yaw - this.root.rotation.y;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this.root.rotation.y += delta * Math.min(1, dt * 12);
  }

  /** A capsule limb that swings from its top (shoulder or hip) at (x, y). */
  private limb(radius: number, length: number, material: THREE.Material, x: number, y: number): THREE.Object3D {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const geometry = new THREE.CapsuleGeometry(radius, length, 4, 10);
    geometry.translate(0, -(length / 2 + radius), 0);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    pivot.add(mesh);
    this.body.add(pivot);
    return pivot;
  }
}
