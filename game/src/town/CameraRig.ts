import * as THREE from "three";

export type CameraMode = "iso" | "perspective";

/** True isometric elevation: atan(1 / sqrt(2)) ≈ 35.26°. */
const ISO_ELEVATION = Math.atan(1 / Math.SQRT2);
const PERSPECTIVE_ELEVATION = 0.68;
const ZOOM_MIN = 7;
const ZOOM_MAX = 30;

/**
 * Orthographic isometric camera (default) or perspective camera, rotating in
 * 90° steps around the player and following them smoothly.
 */
export class CameraRig {
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  readonly perspective = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
  readonly target = new THREE.Vector3();
  mode: CameraMode = "iso";
  /** Visible world height in blocks (iso) / distance factor (perspective). */
  zoom = 15;
  private azimuth = Math.PI / 4;
  private azimuthTarget = Math.PI / 4;
  private readonly reduceMotion: boolean;
  private readonly dir = new THREE.Vector3();

  constructor(focus: THREE.Vector3) {
    this.target.copy(focus);
    this.reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }

  get camera(): THREE.Camera {
    return this.mode === "iso" ? this.ortho : this.perspective;
  }

  /** Azimuth the camera is turning to; used to map movement keys to grid steps. */
  get heading(): number {
    return this.azimuthTarget;
  }

  rotate(direction: 1 | -1): void {
    this.azimuthTarget += direction * (Math.PI / 2);
    if (this.reduceMotion) this.azimuth = this.azimuthTarget;
  }

  zoomBy(direction: 1 | -1): void {
    const factor = direction > 0 ? 1.15 : 1 / 1.15;
    this.setZoom(this.zoom * factor);
  }

  /** Set the zoom directly (pinch gestures), clamped to the usual range. */
  setZoom(zoom: number): void {
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
  }

  update(dt: number, focus: THREE.Vector3, width: number, height: number): void {
    this.azimuth += (this.azimuthTarget - this.azimuth) * Math.min(1, dt * 7);
    this.target.lerp(focus, Math.min(1, dt * 5));
    const aspect = width / Math.max(1, height);
    const elevation = this.mode === "iso" ? ISO_ELEVATION : PERSPECTIVE_ELEVATION;
    this.dir.set(
      Math.sin(this.azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(this.azimuth) * Math.cos(elevation),
    );

    // On a tall phone screen keep enough of the world in view sideways.
    const zoom = Math.max(this.zoom, (this.zoom * 0.85) / Math.max(aspect, 0.3));
    if (this.mode === "iso") {
      const h = zoom;
      this.ortho.left = (-h * aspect) / 2;
      this.ortho.right = (h * aspect) / 2;
      this.ortho.top = h / 2;
      this.ortho.bottom = -h / 2;
      this.ortho.position.copy(this.target).addScaledVector(this.dir, 120);
      this.ortho.lookAt(this.target);
      this.ortho.updateProjectionMatrix();
    } else {
      this.perspective.aspect = aspect;
      this.perspective.position.copy(this.target).addScaledVector(this.dir, zoom * 1.45);
      this.perspective.lookAt(this.target);
      this.perspective.updateProjectionMatrix();
    }
  }
}
