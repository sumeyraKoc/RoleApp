import Phaser from "phaser";

/** Legacy Phaser exit target. The mode selector now lives at the site root. */
export class MenuScene extends Phaser.Scene {
  constructor() { super("MenuScene"); }
  create(): void { window.location.replace("./"); }
}
