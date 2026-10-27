import Phaser from "phaser";
import { RoomScene } from "./scenes/RoomScene";
import { LibraryScene } from "./scenes/LibraryScene";
import { DashboardScene } from "./scenes/DashboardScene";
import { MenuScene } from "./scenes/MenuScene";

// studio.html hosts the Phaser modes. The town (index.html) deep-links into a mode
// with ?scene=<SceneKey>; the requested scene is listed first so Phaser boots it.
// The dub studio moved to the block town (src/dub/DubStudio.ts, index.html?open=dub).
const SCENES = { MenuScene, LibraryScene, RoomScene, DashboardScene } as const;
type SceneKey = keyof typeof SCENES;
const requested = new URLSearchParams(window.location.search).get("scene");
const startKey: SceneKey = requested && requested in SCENES ? (requested as SceneKey) : "MenuScene";
const sceneList = [SCENES[startKey], ...Object.values(SCENES).filter((scene) => scene !== SCENES[startKey])];

new Phaser.Game({
  type: Phaser.AUTO,
  width: 1280,
  height: 720,
  parent: "game",
  backgroundColor: "#181525",
  transparent: true,
  pixelArt: true,
  antialias: false,
  dom: {
    createContainer: true,
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: sceneList,
});
