import "./town.css";
import * as THREE from "three";
import { findPath, type GridCell, type PathfindingGrid } from "../engine/PathFinder";
import {
  PraglishApiClient,
  ROLEPLAY_TTS_PROFILES,
  type AdventureState,
  type Appointment,
  type CutsceneTarget,
  type TurnResponse,
} from "../services/PraglishApiClient";
import { CutscenePlayer, type CutsceneStage } from "./CutscenePlayer";
import { rememberDialogueMessage } from "../services/RoleplayMemory";
import { allQuests, currentQuest, stageAfterScene } from "./adventureProgress";
import { parseClock } from "./npcSchedule";
import { daylightAt, formatClock, GameClock, minuteOfDay } from "./gameClock";
import { scheduledCell } from "./npcSchedule";
import { BlockCharacter } from "./BlockCharacter";
import { CameraRig, type CameraMode } from "./CameraRig";
import { DubStudio } from "../dub/DubStudio";
import { DialoguePanel } from "./DialoguePanel";
import { buildMeshData, type MeshData, type RegionTest } from "./mesher";
import { ToyWorld } from "./toyWorld";
import { paintBlockAtlas } from "./textures";
import { SpellBookPanel } from "./SpellBookPanel";
import { ProgressPanel } from "./ProgressPanel";
import { AdventureJournal } from "./AdventureJournal";
import { InventoryPanel } from "./InventoryPanel";
import { PhonePanel } from "./PhonePanel";
import { SpellPanel } from "./SpellPanel";
import { MagicBurst } from "./magic";
import { VocabPanel } from "./VocabPanel";
import { WORLD_NAMES, buildWorld, canSail, worldFromUrl, worldUrl } from "./worlds";
import { FREE_PLAY_XP, xpMissing } from "./freePlay";
import { ECHO_TAIL_MS, withEcho } from "./voiceFx";
import { Block } from "./blocks";
import { inThornwood } from "./islesMap";
import {
  blockRange,
  GROUND_Y,
  isInsideBuilding,
  isUpperBlock,
  propAt,
  type Activity,
  type BoatSpec,
  type GateSpec,
  type WorldId,
  type BuildingSpec,
  type Cell,
  type NpcSpec,
  type PropSpec,
  type TownDefinition,
  MEETING_PLACES,
} from "./townMap";

const PLAYER_SPEED = 4.2; // cells per second
const NPC_SPEED = 2.6;
/** Give Sam time to walk to the meeting place before it starts. */
const MEETING_DEPARTURE_MINUTES = 15;
/** How long an NPC stays with the player after a scene (game seconds), unless the player walks away. */
const HANGOUT_SECONDS = 2 * 3600;
const HANGOUT_LEAVE_DISTANCE = 10;
const TALK_RANGE = 2.6;
const STAND_Y = GROUND_Y + 1;
const PROP_RANGE = 1.7;
const HIGHLIGHT = 0xf2b134;
const HIGHLIGHT_DONE = 0x8ee89b;

interface NpcRuntime {
  spec: NpcSpec;
  character: BlockCharacter;
  bubble: HTMLElement;
  bubbleText: HTMLElement;
  panel: DialoguePanel | null;
  /** Latest reply shown over the head until this timestamp (ms). */
  replyUntil: number;
  near: boolean;
  /** Cell the NPC occupies (the next cell while it is stepping into it). */
  cell: Cell;
  path: GridCell[];
  stepFrom: Cell | null;
  stepT: number;
  goal: Cell | null;
  /** Scheduled NPCs jump to their spot once the clock first loads, instead of walking across town. */
  placed: boolean;
  /** Not in the world yet (appearsAfterScene) — invisible, silent, not blocking. */
  hidden: boolean;
  speed: number;
  /** After a scene: stay here (and remember the scene) until this game time or until the player leaves. */
  hold: { cell: Cell; until: number; note: string | null } | null;
}

interface LabelRuntime {
  el: HTMLElement;
  anchor: THREE.Vector3;
}

type Interaction =
  | { kind: "npc"; npc: NpcRuntime }
  | { kind: "activity"; building: BuildingSpec }
  | { kind: "portal"; building: BuildingSpec }
  | { kind: "boat"; boat: BoatSpec }
  | { kind: "gate"; gate: GateSpec };

/**
 * The hub world: renders the block town with three.js, moves the player,
 * opens NPC conversations backed by the Praglish API and links to the
 * existing Phaser modes (dub studio, progress book) through portals.
 */
export class TownGame {
  private readonly host: HTMLElement;
  private readonly town: TownDefinition;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly rig: CameraRig;
  private baseMesh: THREE.Mesh;
  private readonly blockMaterial: THREE.MeshBasicMaterial;
  /** API client for account-wide calls (clock, story, phone, plans), independent of any NPC's location. */
  private readonly coreApi: PraglishApiClient;
  private readonly openedGates = new Set<string>();
  private followCheckAt = 0;
  private nearCompanion: NpcRuntime | null = null;
  /** Everyone in talking range, the companion last: T talks to the first, 1–9 picks one. */
  private talkers: NpcRuntime[] = [];
  /** The companion was told "Wait here" (H) and stays put until called again. */
  private companionWaiting = false;
  private beaconLit = false;
  private curseLifted = false;
  private readonly upperMeshes = new Map<string, THREE.Mesh>();
  private readonly player: BlockCharacter;
  private readonly npcs: NpcRuntime[] = [];
  private readonly labels: LabelRuntime[] = [];
  private readonly npcCells = new Set<string>();
  private readonly grid: PathfindingGrid;
  private readonly marker: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly keys = new Set<string>();
  /** Row of tappable action chips (also shows the keyboard key on desktop). */
  private readonly prompt: HTMLElement;
  private promptActions: Array<() => void> = [];
  private promptKey = "";
  private readonly vocabPrompt: HTMLButtonElement;
  private readonly vocabPanel: VocabPanel;
  private readonly spellBook: SpellBookPanel;
  private readonly progressPanel: ProgressPanel;
  private readonly adventureJournal: AdventureJournal | null;
  private readonly inventoryPanel: InventoryPanel;
  private readonly phone: PhonePanel;
  private readonly spellPanel: SpellPanel;
  private readonly bursts: MagicBurst[] = [];
  private readonly adventureMode = new URLSearchParams(window.location.search).get("mode") === "adventure";
  /** Roleplay mode: worlds and places unlock by XP (freePlay.ts). */
  private readonly freePlay = new URLSearchParams(window.location.search).get("mode") === "roleplay";
  /** The player's XP (free play only); null until loaded. */
  private xp: number | null = null;
  private lockToastAt = 0;
  private readonly dubStudio: DubStudio;
  private readonly apis = new Map<string, PraglishApiClient>();
  private readonly propHighlights = new Map<string, THREE.Box3Helper>();
  private readonly completedProps = new Set<string>();
  private readonly progressLoaded = new Set<string>();
  private readonly stats: HTMLElement;
  private readonly clock: GameClock;
  private readonly clockEl: HTMLElement;
  private readonly hemiLight = new THREE.HemisphereLight(0xeaf4ff, 0x7d8a5a, 1.7);
  private readonly sunLight = new THREE.DirectionalLight(0xfff0d8, 2.0);
  /** Draws the visible "toy town"; the block meshes stay as invisible tap targets. */
  private readonly toy: ToyWorld;
  private readonly toastEl: HTMLElement;
  private toastTimer = 0;
  private plans: Appointment[] = [];
  private readonly cutscene: CutscenePlayer;
  private adventure: AdventureState | null = null;
  private sceneFocus: CutsceneTarget | null = null;
  private savedZoom: number | null = null;
  private readonly scripted = new Set<NpcRuntime>();
  private readonly waiters: Array<{ done: () => boolean; resolve: () => void; deadline: number; onTimeout: () => void }> = [];
  private triggerCheckAt = 0;
  private reachBusyUntil = 0;
  private storyBusy = false;
  private readonly arriving = new Set<number>();
  private arrivalCheckAt = 0;
  private clockLabel = "";
  private skyKey = "";
  private readonly tmp = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private blockCount = 0;
  private faceCount = 0;

  private cell: Cell;
  private path: GridCell[] = [];
  private segmentFrom: Cell | null = null;
  private segmentT = 0;
  private pendingTalk: NpcRuntime | null = null;
  private interaction: Interaction | null = null;
  private activePanel: DialoguePanel | VocabPanel | SpellBookPanel | ProgressPanel | AdventureJournal | InventoryPanel | PhonePanel | SpellPanel | null = null;
  private nearestProp: PropSpec | null = null;
  private pendingProp: PropSpec | null = null;
  private pendingActivity: BuildingSpec | null = null;
  private pointerDown: { x: number; y: number } | null = null;
  /** Active touches on the canvas, for pinch-zoom and two-finger rotate. */
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; zoom: number; angle: number } | null = null;
  private last = performance.now();
  private fpsTime = 0;
  private fpsFrames = 0;
  private statsTime = 0;

  constructor(host: HTMLElement) {
    this.host = host;
    this.town = buildWorld(worldFromUrl(window.location.search));
    this.coreApi = new PraglishApiClient({
      location: "town", npcRole: "friend", npcName: "Sam", mode: this.adventureMode ? "adventure" : "roleplay",
    });
    this.cell = { ...this.town.spawn };

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.prepend(this.renderer.domElement);

    // Blocks
    const atlas = new THREE.CanvasTexture(paintBlockAtlas());
    atlas.magFilter = THREE.NearestFilter;
    atlas.minFilter = THREE.NearestFilter;
    atlas.generateMipmaps = false;
    atlas.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: atlas, vertexColors: true, alphaTest: 0.5 });
    // The block meshes are only tap targets now; ToyWorld draws what you see.
    material.visible = false;
    this.blockMaterial = material;
    this.toy = new ToyWorld(this.town);
    const atmosphere = this.town.atmosphere;
    if (atmosphere) this.scene.fog = new THREE.Fog(atmosphere.fog, atmosphere.fogNear, atmosphere.fogFar);

    const { world, buildings } = this.town;
    this.blockCount = world.countBlocks();
    const baseRegion: RegionTest = (x, y, z) => !buildings.some((b) => isUpperBlock(b, x, y, z));
    this.baseMesh = this.createMesh(buildMeshData(world, baseRegion), material, baseRegion, true);
    for (const b of buildings) {
      const region: RegionTest = (x, y, z) => isUpperBlock(b, x, y, z);
      const mesh = this.createMesh(buildMeshData(world, region), material, region);
      this.upperMeshes.set(b.id, mesh);
    }

    this.scene.add(this.hemiLight);
    // A real sun with soft shadows over the whole map.
    const cx = world.width / 2;
    const cz = world.depth / 2;
    const span = Math.max(world.width, world.depth) * 0.75;
    this.sunLight.position.set(cx + span * 0.6, 48, cz + span * 0.35);
    this.sunLight.target.position.set(cx, 0, cz);
    this.sunLight.castShadow = true;
    const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    this.sunLight.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
    const cam = this.sunLight.shadow.camera;
    cam.left = -span;
    cam.right = span;
    cam.top = span;
    cam.bottom = -span;
    cam.near = 1;
    cam.far = 140;
    this.sunLight.shadow.bias = -0.0006;
    this.sunLight.shadow.normalBias = 0.03;
    this.scene.add(this.sunLight, this.sunLight.target);

    // Characters
    this.player = new BlockCharacter({
      shirt: "#2f8f83", pants: "#2c3a63", skin: "#e9b98f", hair: "#4a2c1a", eye: "#2a3d6b", ribbon: "#e2574c",
    });
    this.player.root.position.set(this.cell.x + 0.5, STAND_Y, this.cell.z + 0.5);
    this.scene.add(this.player.root);
    for (const spec of this.town.npcs) this.npcs.push(this.createNpc(spec));

    this.grid = {
      width: world.width,
      height: world.depth,
      isWalkable: (x, z) => world.isStandable(x, z, GROUND_Y) && !this.npcCells.has(`${x},${z}`),
    };

    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.42, 4, 1),
      new THREE.MeshBasicMaterial({ color: 0xf2b134, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.marker.rotation.set(-Math.PI / 2, 0, Math.PI / 4);
    this.scene.add(this.marker);

    this.focus.set(this.cell.x + 0.5, STAND_Y + 0.6, this.cell.z + 0.5);
    this.rig = new CameraRig(this.focus);

    // HUD
    for (const b of buildings) this.labels.push(this.createLabel(b));
    this.prompt = this.createHud();
    this.vocabPrompt = this.mustQuery<HTMLButtonElement>(".town-prompt--vocab");
    this.vocabPrompt.addEventListener("click", () => {
      if (this.nearestProp) this.openVocab(this.nearestProp);
    });
    this.vocabPanel = new VocabPanel(host, {
      onProgress: (prop, completed) => {
        if (completed) this.completedProps.add(prop.id);
      },
      onClose: () => this.panelClosed(this.vocabPanel),
    });
    this.spellBook = new SpellBookPanel(host, { onClose: () => this.panelClosed(this.spellBook) });
    this.progressPanel = new ProgressPanel(host, () => this.panelClosed(this.progressPanel));
    this.adventureJournal = this.adventureMode ? new AdventureJournal(host, () => this.openAdventure(), () => this.panelClosed(this.adventureJournal), () => this.openInventory()) : null;
    this.inventoryPanel = new InventoryPanel(host, () => this.panelClosed(this.inventoryPanel));
    const phoneApi = this.coreApi;
    if (!phoneApi) throw new Error("Sam (location town) is missing from the town map");
    this.phone = new PhonePanel(host, phoneApi, "sam", {
      onClose: () => this.panelClosed(this.phone),
      onTurn: (result) => this.applyTurnResult(result),
    });
    this.phone.requestOpen = () => this.openPhone();
    this.phone.startPolling();
    this.cutscene = new CutscenePlayer(host);
    this.spellPanel = new SpellPanel(host, this.coreApi, {
      onClose: () => this.panelClosed(this.spellPanel),
      onOpened: (result) => {
        this.openGate(result.spell.gate_id, true);
        if (result.quest_completed) void this.refreshPlayerState();
      },
    }, !this.adventureMode);
    this.updateNpcVisibility();
    void this.refreshPlans();
    window.setInterval(() => {
      if (document.visibilityState === "visible") void this.refreshPlans();
    }, 15_000);
    void this.refreshPlayerState();
    void this.loadXp();
    this.dubStudio = new DubStudio(host, {
      onExit: () => {
        this.host.classList.remove("is-talking");
        this.renderer.domElement.focus?.();
      },
    });
    for (const prop of this.town.props) this.propHighlights.set(prop.id, this.createHighlight(prop));
    this.stats = this.mustQuery<HTMLElement>("[data-town-stats]");
    this.clockEl = this.mustQuery<HTMLElement>("[data-town-clock]");
    this.toastEl = this.mustQuery<HTMLElement>("[data-town-toast]");
    const clockApi = this.coreApi;
    if (!clockApi) throw new Error("The town needs at least one NPC location for API access");
    this.clock = new GameClock(clockApi);
    this.clock.start();

    this.bindInput();
    window.addEventListener("resize", () => this.resize());
    this.resize();
    if (this.adventureJournal) this.openAdventure();
    // Deep link from the mode selector: index.html?open=dub
    if (new URLSearchParams(window.location.search).get("open") === "dub") this.openActivity("dub");
    requestAnimationFrame((t) => this.tick(t));
  }

  // ---------------------------------------------------------------- setup

  /** A block mesh (tap target) with the toy-town version of the same region attached as its visible child. */
  private createMesh(data: MeshData, material: THREE.Material, region?: RegionTest, decor = false): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
    g.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
    g.setIndex(new THREE.BufferAttribute(data.indices, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, material);
    if (region) mesh.add(this.toy.build(region, decor));
    this.scene.add(mesh);
    this.faceCount += data.faceCount;
    return mesh;
  }

  private createNpc(spec: NpcSpec): NpcRuntime {
    const character = new BlockCharacter(spec.look);
    character.root.position.set(spec.cell.x + 0.5, STAND_Y, spec.cell.z + 0.5);
    character.root.userData["npcId"] = spec.id;
    this.scene.add(character.root);
    this.npcCells.add(`${spec.cell.x},${spec.cell.z}`);

    const bubble = document.createElement("div");
    bubble.className = "town-bubble";
    bubble.hidden = true;
    const name = document.createElement("strong");
    name.textContent = `${spec.title} ${spec.name}`;
    const text = document.createElement("span");
    bubble.append(name, text);
    this.host.appendChild(bubble);
    return {
      spec, character, bubble, bubbleText: text, panel: null, replyUntil: 0, near: false,
      cell: { ...spec.cell }, path: [], stepFrom: null, stepT: 0, goal: null, placed: !spec.schedule,
      hidden: false, speed: NPC_SPEED, hold: null,
    };
  }

  private createLabel(b: BuildingSpec): LabelRuntime {
    const el = document.createElement("div");
    el.className = "town-label";
    const name = document.createElement("span");
    name.textContent = b.name;
    const lock = document.createElement("small");
    lock.className = "town-label__lock";
    lock.hidden = true;
    el.dataset["building"] = b.id;
    el.append(name, lock);
    this.host.appendChild(el);
    let dx = 0;
    let dz = 0;
    if (b.door.z === b.z1) dz = 1.6;
    else if (b.door.z === b.z0) dz = -0.6;
    else if (b.door.x === b.x1) dx = 1.6;
    else dx = -0.6;
    return { el, anchor: new THREE.Vector3(b.door.x + 0.5 + dx, 6.2, b.door.z + 0.5 + dz) };
  }

  private createHighlight(prop: PropSpec): THREE.Box3Helper {
    const box = new THREE.Box3();
    for (const b of prop.blocks) {
      box.expandByPoint(new THREE.Vector3(b.x, b.y, b.z));
      box.expandByPoint(new THREE.Vector3(b.x + 1, b.y + 1, b.z + 1));
    }
    box.expandByScalar(0.03);
    const helper = new THREE.Box3Helper(box, new THREE.Color(HIGHLIGHT));
    const material = helper.material as THREE.LineBasicMaterial;
    material.depthTest = false;
    material.transparent = true;
    helper.renderOrder = 10;
    helper.visible = false;
    this.scene.add(helper);
    return helper;
  }

  private createHud(): HTMLElement {
    const hud = document.createElement("div");
    hud.className = "town-hud";
    hud.innerHTML = `
      <div class="town-brand">
        <p class="town-brand__eyebrow">roleApp</p>
        <h1 class="town-brand__title">${WORLD_NAMES[worldFromUrl(window.location.search)]}</h1>
        <p class="town-brand__hint">Click the ground to walk · Approach a character and press <kbd>T</kbd></p>
      </div>
      <button class="town-menu-toggle" type="button" aria-expanded="false" aria-controls="town-links" aria-label="Menu">☰</button>
      <nav class="town-links" id="town-links" aria-label="Game navigation">
        <button class="town-btn town-btn--book" type="button" data-act="book">Spell Book<kbd>B</kbd></button>
        <button class="town-btn" type="button" data-act="progress">Progress Journal</button>
        <button class="town-btn town-btn--inventory" type="button" data-act="inventory">Inventory<kbd>E</kbd></button>
        ${this.adventureMode ? `<button class="town-btn" type="button" data-act="adventure">Quests</button>` : ""}
        <a class="town-btn" href="./">Choose Mode</a>
      </nav>
      <div class="town-stats" data-town-stats aria-hidden="true"></div>
      <div class="town-clock" data-town-clock role="timer" aria-live="off"></div>
      <div class="town-toast" data-town-toast role="status" hidden></div>
      <div class="town-actions">
        <div class="town-controls" role="toolbar" aria-label="Camera">
          <button class="town-btn" data-act="rotL" title="Rotate left (Q)">↺<kbd>Q</kbd></button>
          <button class="town-btn" data-act="rotR" title="Rotate right (R)">↻<kbd>R</kbd></button>
          <button class="town-btn" data-act="zoomOut" title="Zoom out">−</button>
          <button class="town-btn" data-act="zoomIn" title="Zoom in">+</button>
          <button class="town-btn" data-act="mode-iso" aria-pressed="true">Isometric</button>
          <button class="town-btn" data-act="mode-perspective" aria-pressed="false">Perspective</button>
        </div>
        <div class="town-prompts">
          <div class="town-prompt-group" hidden></div>
          <button class="town-prompt town-prompt--vocab" type="button" hidden></button>
        </div>
      </div>`;
    this.host.appendChild(hud);

    hud.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = btn.dataset["act"];
        if (act === "rotL") this.rig.rotate(-1);
        else if (act === "rotR") this.rig.rotate(1);
        else if (act === "zoomIn") this.rig.zoomBy(-1);
        else if (act === "zoomOut") this.rig.zoomBy(1);
        else if (act === "mode-iso") this.setCameraMode("iso");
        else if (act === "mode-perspective") this.setCameraMode("perspective");
        else if (act === "book") this.openSpellBook();
        else if (act === "progress") this.openProgress();
        else if (act === "inventory") this.openInventory();
        else if (act === "adventure") this.openAdventure();
      });
    });
    // Phones: the navigation buttons fold into a ☰ menu.
    const menu = hud.querySelector<HTMLButtonElement>(".town-menu-toggle");
    const setMenu = (open: boolean) => {
      this.host.classList.toggle("menu-open", open);
      menu?.setAttribute("aria-expanded", String(open));
    };
    menu?.addEventListener("click", () => setMenu(!this.host.classList.contains("menu-open")));
    hud.querySelector(".town-links")?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".town-btn")) setMenu(false);
    });
    const prompt = hud.querySelector<HTMLElement>(".town-prompt-group");
    if (!prompt) throw new Error("HUD prompt missing");
    prompt.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-i]");
      if (btn) this.promptActions[Number(btn.dataset["i"])]?.();
    });
    return prompt;
  }

  private setCameraMode(mode: CameraMode): void {
    this.rig.mode = mode;
    this.host.querySelectorAll<HTMLButtonElement>("[data-act^='mode-']").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset["act"] === `mode-${mode}`));
    });
  }

  private mustQuery<T extends Element>(selector: string): T {
    const el = this.host.querySelector<T>(selector);
    if (!el) throw new Error(`Missing ${selector}`);
    return el;
  }

  // ---------------------------------------------------------------- input

  private bindInput(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", (e) => {
      this.host.classList.remove("menu-open");
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        // Second finger: start a pinch (zoom) / twist (rotate) and cancel the tap.
        this.pointerDown = null;
        const [a, b] = [...this.touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
        this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.rig.zoom, angle: Math.atan2(b.y - a.y, b.x - a.x) };
      } else if (this.touches.size === 1) {
        this.pointerDown = { x: e.clientX, y: e.clientY };
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.touches.has(e.pointerId)) return;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!this.pinch || this.touches.size !== 2) return;
      const [a, b] = [...this.touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 10) this.rig.setZoom(this.pinch.zoom * (this.pinch.dist / dist));
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      let turn = angle - this.pinch.angle;
      if (turn > Math.PI) turn -= 2 * Math.PI;
      if (turn < -Math.PI) turn += 2 * Math.PI;
      if (Math.abs(turn) > 0.6) {
        this.rig.rotate(turn > 0 ? 1 : -1);
        this.pinch.angle = angle;
      }
    });
    const release = (e: PointerEvent) => {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
    };
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("pointerup", (e) => {
      release(e);
      const down = this.pointerDown;
      this.pointerDown = null;
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return;
      this.handleTap(e.clientX, e.clientY);
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.rig.zoomBy(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });

    window.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;
      const k = e.key.toLowerCase();
      if (this.cutscene.isPlaying) return;
      // The dub shop handles its own keys (←/→, Space, Esc) while it is open.
      if (this.dubStudio.isOpen) return;
      // A disabled dialogue input loses focus while waiting for the NPC. Keep
      // world shortcuts inactive whenever any panel is open, regardless of focus.
      if (this.activePanel) {
        if (k === "escape") this.activePanel.close();
        else if (k === "e" && this.activePanel === this.inventoryPanel) this.inventoryPanel.close();
        else if (k === "m" && this.activePanel === this.phone) this.phone.close();
        return;
      }
      const picked = /^[1-9]$/.test(k) && this.talkers.length > 1 ? this.talkers[Number(k) - 1] : undefined;
      if (k === "t" && this.talkers[0]) this.openDialogue(this.talkers[0]);
      else if (picked) this.openDialogue(picked);
      else if (k === "h" && this.companion()) this.toggleCompanionWait();
      else if (k === "enter") this.interact();
      else if (k === "f" && this.nearestProp) this.openVocab(this.nearestProp);
      else if (k === "b") this.openSpellBook();
      else if (k === "p") this.openProgress();
      else if (k === "m" && !this.phone.button.hidden) this.openPhone();
      else if (k === "e") this.inventoryPanel.isOpen ? this.inventoryPanel.close() : this.openInventory();
      else if (k === "g" && this.adventureJournal) this.openAdventure();
      else if ((k === "k" || k === "z") && this.interaction?.kind === "activity" && this.interaction.building.activity?.key.toLowerCase() === k) this.interact();
      else if (k === "q") this.rig.rotate(-1);
      else if (k === "r") this.rig.rotate(1);
      else if (k === "+" || k === "=") this.rig.zoomBy(-1);
      else if (k === "-") this.rig.zoomBy(1);
      else if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
        this.keys.add(k);
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.keys.clear());
  }

  private handleTap(clientX: number, clientY: number): void {
    if (this.cutscene.isPlaying) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.rig.camera);

    // Tapping an NPC walks next to them and opens the conversation.
    const npcHit = this.raycaster.intersectObjects(this.npcs.filter((n) => !n.hidden).map((n) => n.character.root), true)[0];
    if (npcHit) {
      let obj: THREE.Object3D | null = npcHit.object;
      while (obj && obj.userData["npcId"] === undefined) obj = obj.parent;
      const npc = this.npcs.find((n) => n.spec.id === obj?.userData["npcId"]);
      if (npc) {
        if (this.distanceTo(npc) <= TALK_RANGE) this.openDialogue(npc);
        else {
          this.pendingTalk = npc;
          const target = this.nearestStandable(npc.cell.x, npc.cell.z);
          if (target) this.walkTo(target);
        }
        return;
      }
    }

    const targets = [this.baseMesh, ...[...this.upperMeshes.values()].filter((m) => m.visible)];
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit || !hit.face) return;
    const n = hit.face.normal;
    const inside = hit.point.clone().addScaledVector(n, -0.5);
    const bx = Math.floor(inside.x);
    const by = Math.floor(inside.y);
    const bz = Math.floor(inside.z);
    if (this.blockedByLock(bx, bz)) return;
    const prop = propAt(this.town.props, bx, by, bz);
    this.pendingTalk = null;
    this.pendingProp = null;
    this.pendingActivity = null;
    const activityHost = this.town.buildings.find((b) =>
      b.activity?.anchors.some((a) => a.x === bx && a.y === by && a.z === bz),
    );
    if (activityHost?.activity) {
      if (this.nearActivity(activityHost)) this.openActivity(activityHost.activity.id);
      else {
        const spot = this.standSpotNear(activityHost.activity.anchors, activityHost);
        if (spot) {
          this.pendingActivity = activityHost;
          this.walkTo(spot);
        }
      }
      return;
    }
    if (prop) {
      if (this.canReachProp(prop)) this.openVocab(prop);
      else {
        const spot = this.standSpotFor(prop);
        if (spot) {
          this.pendingProp = prop;
          this.walkTo(spot);
        }
      }
      return;
    }
    const p = hit.point.clone().addScaledVector(n, n.y > 0.5 ? -0.01 : 0.5);
    const target = this.nearestStandable(Math.floor(p.x), Math.floor(p.z));
    if (target) this.walkTo(target);
  }

  private walkTo(target: Cell): void {
    if (this.blockedByLock(target.x, target.z)) return;
    const moving = this.segmentFrom !== null && this.path.length > 0;
    const startCell = moving ? this.path[0] : undefined;
    const start: GridCell = startCell ?? { x: this.cell.x, y: this.cell.z };
    const route = findPath(this.grid, start, { x: target.x, y: target.z });
    if (!route) return;
    this.path = moving && startCell ? [startCell, ...route] : route;
    this.marker.position.set(target.x + 0.5, STAND_Y + 0.03, target.z + 0.5);
    (this.marker.material as THREE.MeshBasicMaterial).opacity = 0.95;
  }

  private keyboardStep(): void {
    let f = 0;
    let s = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) f += 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) f -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) s += 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) s -= 1;
    if (!f && !s) return;
    const a = this.rig.heading;
    const vx = -Math.sin(a) * f + Math.cos(a) * s;
    const vz = -Math.cos(a) * f - Math.sin(a) * s;
    const len = Math.hypot(vx, vz);
    const dx = Math.round(vx / len);
    const dz = Math.round(vz / len);
    const { x, z } = this.cell;
    if (!this.grid.isWalkable(x + dx, z + dz)) return;
    if (this.blockedByLock(x + dx, z + dz)) return;
    if (dx && dz && (!this.grid.isWalkable(x + dx, z) || !this.grid.isWalkable(x, z + dz))) return;
    this.pendingTalk = null;
    this.pendingProp = null;
    this.pendingActivity = null;
    this.path = [{ x: x + dx, y: z + dz }];
  }

  private nearestStandable(x: number, z: number): Cell | null {
    for (let r = 0; r <= 6; r++) {
      let best: Cell | null = null;
      let bestDist = Infinity;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (!this.grid.isWalkable(x + dx, z + dz)) continue;
          const d = dx * dx + dz * dz;
          if (d < bestDist) {
            bestDist = d;
            best = { x: x + dx, z: z + dz };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  // ---------------------------------------------------------------- interaction

  private distanceTo(npc: NpcRuntime): number {
    const p = this.player.root.position;
    const q = npc.character.root.position;
    return Math.hypot(p.x - q.x, p.z - q.z);
  }

  private currentBuilding(): BuildingSpec | undefined {
    const x = Math.floor(this.player.root.position.x);
    const z = Math.floor(this.player.root.position.z);
    return this.town.buildings.find((b) => isInsideBuilding(b, x, z));
  }

  private propDistance(prop: PropSpec): number {
    const p = this.player.root.position;
    let best = Infinity;
    for (const b of prop.blocks) best = Math.min(best, Math.hypot(b.x + 0.5 - p.x, b.z + 0.5 - p.z));
    return best;
  }

  /** Close enough and in the same building (so props are never reached through walls). */
  private canReachProp(prop: PropSpec): boolean {
    return this.currentBuilding()?.id === prop.buildingId && this.propDistance(prop) <= PROP_RANGE;
  }

  /** Standable cell next to the prop, inside its building, closest to the player. */
  private standSpotFor(prop: PropSpec): Cell | null {
    return this.standSpotNear(prop.blocks, this.town.buildings.find((b) => b.id === prop.buildingId));
  }

  /** Close enough to a building activity's anchor blocks (e.g. the CD shelves). */
  private nearActivity(building: BuildingSpec): boolean {
    const anchors = building.activity?.anchors ?? [];
    if (this.currentBuilding()?.id !== building.id) return false;
    const p = this.player.root.position;
    return anchors.some((a) => Math.hypot(a.x + 0.5 - p.x, a.z + 0.5 - p.z) <= PROP_RANGE);
  }

  private standSpotNear(blocks: readonly { x: number; z: number }[], building: BuildingSpec | undefined): Cell | null {
    const p = this.player.root.position;
    let best: Cell | null = null;
    let bestDist = Infinity;
    for (const b of blocks) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x = b.x + dx;
        const z = b.z + dz;
        if (!this.grid.isWalkable(x, z)) continue;
        if (building && !isInsideBuilding(building, x, z)) continue;
        const d = Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z);
        if (d < bestDist) {
          bestDist = d;
          best = { x, z };
        }
      }
    }
    return best;
  }

  private apiFor(location: string): PraglishApiClient | null {
    const existing = this.apis.get(location);
    if (existing) return existing;
    const npc = this.town.npcs.find((n) => n.location === location);
    if (!npc) return null;
    const api = new PraglishApiClient({ location, npcRole: npc.npcRole, npcName: npc.name, mode: this.adventureMode ? "adventure" : "roleplay" });
    this.apis.set(location, api);
    return api;
  }

  private openActivity(id: Activity["id"]): void {
    if (id === "sleep") {
      void this.sleepUntilMorning();
      return;
    }
    if (id !== "dub") return;
    this.activePanel?.close();
    this.keys.clear();
    this.path = [];
    this.host.classList.add("is-talking");
    this.dubStudio.open();
  }

  private async sleepUntilMorning(): Promise<void> {
    const api = this.coreApi;
    if (!api) return;
    try {
      const state = await api.sleep();
      this.host.classList.add("is-sleeping");
      window.setTimeout(() => this.host.classList.remove("is-sleeping"), 1600);
      this.clock.apply(state);
      this.toast(`Good morning! ${state.label}`);
    } catch (error: unknown) {
      this.toast(error instanceof Error ? error.message : "You can't sleep right now.");
    }
  }

  /** A short message at the top of the screen. */
  private toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.hidden = true;
    }, 3500);
  }

  private openSpellBook(): void {
    const first = this.town.npcs[0];
    const api = first ? this.apiFor(first.location) : null;
    if (!api) return;
    if (this.activePanel && this.activePanel !== this.spellBook) this.activePanel.close();
    this.activePanel = this.spellBook;
    this.host.classList.add("is-talking");
    this.spellBook.open(api);
  }

  private openProgress(): void {
    if (this.activePanel && this.activePanel !== this.progressPanel) this.activePanel.close();
    this.activePanel = this.progressPanel;
    this.keys.clear();
    this.path = [];
    this.host.classList.add("is-talking");
    this.progressPanel.open();
  }

  private openAdventure(): void {
    if (!this.adventureJournal) return;
    if (this.activePanel && this.activePanel !== this.adventureJournal) this.activePanel.close();
    this.activePanel = this.adventureJournal;
    this.keys.clear();
    this.path = [];
    this.host.classList.add("is-talking");
    this.adventureJournal.open();
  }

  private openPhone(): void {
    if (this.activePanel && this.activePanel !== this.phone) this.activePanel.close();
    this.activePanel = this.phone;
    this.keys.clear();
    this.path = [];
    this.host.classList.add("is-talking");
    this.phone.open();
  }

  private async refreshPlans(): Promise<void> {
    const api = this.coreApi;
    if (!api) return;
    try {
      this.plans = await api.getPlans();
      this.phone.setPlans(this.plans);
    } catch {
      // Keep the last known plans; the next poll retries.
    }
  }

  /** Where an NPC should be for a meeting right now, if it has one. */
  private meetingGoal(npc: NpcRuntime, gameSeconds: number): Cell | null {
    for (const plan of this.plans) {
      if (plan.npc_id !== npc.spec.id || plan.status !== "planned") continue;
      const place = MEETING_PLACES[plan.place_id];
      if (!place) continue;
      const leave = plan.game_seconds - MEETING_DEPARTURE_MINUTES * 60;
      const giveUp = plan.game_seconds + plan.wait_minutes * 60;
      if (gameSeconds >= leave && gameSeconds < giveUp) return place.cell;
    }
    return null;
  }

  /** Where an NPC stays after a scene; the hold ends with time or when the player walks away. */
  private holdGoal(npc: NpcRuntime, gameSeconds: number): Cell | null {
    const hold = npc.hold;
    if (!hold) return null;
    const p = this.player.root.position;
    const away = Math.hypot(p.x - (hold.cell.x + 0.5), p.z - (hold.cell.z + 0.5)) > HANGOUT_LEAVE_DISTANCE;
    if (gameSeconds > hold.until || (away && !npc.panel?.isOpen)) {
      npc.hold = null;
      return null;
    }
    return hold.cell;
  }

  private playerAt(placeId: string): boolean {
    const place = MEETING_PLACES[placeId];
    if (!place || (place.world ?? "town") !== this.town.id) return false;
    if (place.buildingId) return this.currentBuilding()?.id === place.buildingId;
    const p = this.player.root.position;
    return Math.hypot(p.x - (place.cell.x + 0.5), p.z - (place.cell.z + 0.5)) <= (place.radius ?? 3);
  }

  /** Report the player's arrival once they reach a meeting place during its window. */
  private checkArrivals(gameSeconds: number, now: number): void {
    if (now < this.arrivalCheckAt) return;
    this.arrivalCheckAt = now + 1000;
    for (const plan of this.plans) {
      if (plan.status !== "planned" || this.arriving.has(plan.id)) continue;
      const open = gameSeconds >= plan.game_seconds && gameSeconds <= plan.game_seconds + plan.wait_minutes * 60;
      if (!open || !this.playerAt(plan.place_id)) continue;
      this.arriving.add(plan.id);
      void this.reportArrival(plan);
    }
  }

  private async reportArrival(plan: Appointment): Promise<void> {
    const api = this.coreApi;
    if (!api) return;
    try {
      const { appointment, memory } = await api.arriveForPlan(plan.id);
      this.plans = this.plans.filter((p) => p.id !== plan.id);
      this.phone.setPlans(this.plans);
      this.onMeetingKept(appointment, memory);
    } catch (error: unknown) {
      this.arriving.delete(plan.id);
      await this.refreshPlans();
      if (error instanceof Error && !/not time/i.test(error.message)) this.toast(error.message);
    }
  }

  /** Hook for the meeting scene (Kademe 2, scene 2A). */
  private onMeetingKept(appointment: Appointment, memory: string | null): void {
    void (async () => {
      this.storyBusy = true;
      try {
        const played = await this.playScene(appointment.scene_id ?? "meeting");
        if (!played) this.toast(`${appointment.npc_name}: "Hey, you made it!"`);
        if (memory) this.toast(memory);
        await this.refreshPlayerState();
      } finally {
        this.storyBusy = false;
      }
    })();
  }

  /** Quest, inventory and journal updates after any accepted turn (face to face or by phone). */
  private applyTurnResult(result: TurnResponse): void {
    if (result.plan_update) {
      if (result.plan_update.status !== "rejected") this.toast(result.plan_update.message);
      void this.refreshPlans();
    }
    if (result.rewards && this.freePlay) this.setXp(result.rewards.total_xp);
    if (!result.accepted) return;
    if (result.adventure_stage !== null && result.adventure_stage !== undefined) {
      this.adventureJournal?.setStage(result.adventure_stage);
      if (this.adventure) this.adventure.stage = result.adventure_stage;
      this.updateNpcVisibility();
    }
    if (result.inventory_changes?.length) {
      this.adventureJournal?.addItems(result.inventory_changes);
      this.inventoryPanel.addItems(result.inventory_changes);
    }
  }

  private openInventory(): void {
    if (this.activePanel && this.activePanel !== this.inventoryPanel) this.activePanel.close();
    this.activePanel = this.inventoryPanel;
    this.keys.clear();
    this.path = [];
    this.host.classList.add("is-talking");
    this.inventoryPanel.open();
  }

  private async refreshPlayerState(): Promise<void> {
    const api = this.coreApi;
    if (!api) return;
    try {
      this.applyAdventureState(await api.getAdventureState());
    } catch {
      this.adventureJournal?.setError("Could not load quests. Refresh the page and try again.");
      this.inventoryPanel.setError("Could not load inventory. Refresh the page and try again.");
    }
  }

  private panelClosed(panel: DialoguePanel | VocabPanel | SpellBookPanel | ProgressPanel | AdventureJournal | InventoryPanel | PhonePanel | SpellPanel | null): void {
    if (panel && this.activePanel === panel) {
      this.activePanel = null;
      this.host.classList.remove("is-talking");
    }
  }

  private openVocab(prop: PropSpec): void {
    this.pendingProp = null;
    const api = this.apiFor(prop.location);
    if (!api) return;
    if (this.activePanel && this.activePanel !== this.vocabPanel) this.activePanel.close();
    this.activePanel = this.vocabPanel;
    this.host.classList.add("is-talking");
    this.vocabPanel.open(prop, api);
  }

  private loadProgressFor(location: string): void {
    if (this.progressLoaded.has(location)) return;
    const api = this.apiFor(location);
    if (!api) return;
    this.progressLoaded.add(location);
    void api.getVocabularyProgress()
      .then((entries) => {
        const done = new Set(entries.filter((e) => e.completed).map((e) => e.concept));
        for (const prop of this.town.props) {
          if (prop.location === location && done.has(prop.concept)) this.completedProps.add(prop.id);
        }
      })
      .catch(() => this.progressLoaded.delete(location));
  }

  private interact(): void {
    const it = this.interaction;
    if (!it) return;
    if (it.kind === "npc") this.openDialogue(it.npc);
    else if (it.kind === "activity" && it.building.activity) this.openActivity(it.building.activity.id);
    else if (it.kind === "boat") void this.travel(it.boat.to);
    else if (it.kind === "gate") this.onGate(it.gate);
    else if (it.building.portal) window.location.href = it.building.portal.href;
  }

  private openDialogue(npc: NpcRuntime): void {
    this.pendingTalk = null;
    this.pendingProp = null;
    const api = this.apiFor(npc.spec.location);
    if (!api) return;
    if (this.activePanel && this.activePanel !== npc.panel) this.activePanel.close();
    if (!npc.panel) {
      npc.panel = new DialoguePanel(npc.spec, api, this.host, {
        onReply: (text, speaker, seconds) => {
          if (speaker !== "npc") return;
          npc.bubbleText.textContent = text;
          npc.replyUntil = performance.now() + seconds * 1000;
          npc.character.talk(seconds, performance.now());
        },
        onAcceptedTurn: (result) => this.applyTurnResult(result),
        sceneNote: () => (npc.hold && this.clock.now() <= npc.hold.until ? npc.hold.note : null),
        onClose: () => this.panelClosed(npc.panel),
      });
    }
    this.activePanel = npc.panel;
    this.host.classList.add("is-talking");
    npc.panel.open();
  }

  // ---------------------------------------------------------------- loop

  private resize(): void {
    this.renderer.setSize(this.host.clientWidth, this.host.clientHeight);
  }

  private tick(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.dubStudio.isOpen) {
      // The studio covers the whole screen; skip the 3D work until it closes.
      requestAnimationFrame((t) => this.tick(t));
      return;
    }

    const gameSeconds = this.clock.now(now);
    this.updateClock(gameSeconds);
    this.toy.update(now / 1000);
    if (!this.cutscene.isPlaying) {
      if (this.town.id === "town") this.checkArrivals(gameSeconds, now);
      this.checkStoryTriggers(gameSeconds, now);
    }
    this.updatePlayer(dt, now);
    this.updateWorld();

    for (const npc of this.npcs) {
      if (npc.hidden) continue;
      const moving = this.updateNpcMovement(npc, dt, gameSeconds);
      const dx = this.player.root.position.x - npc.character.root.position.x;
      const dz = this.player.root.position.z - npc.character.root.position.z;
      npc.near = Math.hypot(dx, dz) < TALK_RANGE + 0.4;
      if (!moving) {
        if (npc.near || npc.panel?.isOpen) npc.character.yaw = Math.atan2(dx, dz);
        else if (!npc.spec.schedule) npc.character.yaw = 0;
      }
      npc.character.update(dt, moving, now);
      if (npc.near && this.pendingTalk === npc) this.openDialogue(npc);
    }
    if (this.pendingProp && this.path.length === 0 && this.canReachProp(this.pendingProp)) {
      this.openVocab(this.pendingProp);
    }
    if (this.pendingActivity?.activity && this.path.length === 0 && this.nearActivity(this.pendingActivity)) {
      const id = this.pendingActivity.activity.id;
      this.pendingActivity = null;
      this.openActivity(id);
    }

    this.resolveWaiters(now);
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];
      if (burst && !burst.update(dt)) {
        this.scene.remove(burst.points);
        burst.dispose();
        this.bursts.splice(i, 1);
      }
    }
    const sceneFocus = this.sceneFocus ? this.targetPosition(this.sceneFocus) : null;
    if (sceneFocus) this.focus.set(sceneFocus.x, STAND_Y + 0.6, sceneFocus.z);
    else this.focus.set(this.player.root.position.x, STAND_Y + 0.6, this.player.root.position.z);
    this.rig.update(dt, this.focus, this.host.clientWidth, this.host.clientHeight);
    this.renderer.render(this.scene, this.rig.camera);
    this.updateOverlays(now);
    this.updateStats(dt);
    requestAnimationFrame((t) => this.tick(t));
  }

  private updatePlayer(dt: number, now: number): void {
    if (this.path.length === 0 && !this.activePanel && !this.cutscene.isPlaying) this.keyboardStep();
    let moving = false;
    const next = this.path[0];
    // A walking NPC stepped onto the route: wait for it to pass.
    const blocked = next && !this.segmentFrom && this.npcCells.has(`${next.x},${next.y}`);
    if (next && !blocked) {
      if (!this.segmentFrom) {
        this.segmentFrom = { ...this.cell };
        this.segmentT = 0;
      }
      const from = this.segmentFrom;
      const dist = Math.hypot(next.x - from.x, next.y - from.z) || 1;
      this.segmentT += (dt * PLAYER_SPEED) / dist;
      const t = Math.min(1, this.segmentT);
      this.player.root.position.x = from.x + 0.5 + (next.x - from.x) * t;
      this.player.root.position.z = from.z + 0.5 + (next.y - from.z) * t;
      this.player.yaw = Math.atan2(next.x - from.x, next.y - from.z);
      moving = true;
      if (t >= 1) {
        this.cell = { x: next.x, z: next.y };
        this.path.shift();
        this.segmentFrom = null;
      }
    }
    this.player.update(dt, moving, now);
    const mat = this.marker.material as THREE.MeshBasicMaterial;
    mat.opacity = Math.max(0, mat.opacity - dt * (moving ? 0.4 : 1.6));
  }

  /** HUD clock text and sky/light colour for the time of day. */
  private updateClock(gameSeconds: number): void {
    const label = this.clock.ready ? formatClock(gameSeconds) : "";
    if (label !== this.clockLabel) {
      this.clockLabel = label;
      this.clockEl.textContent = label;
      this.clockEl.hidden = !label;
    }
    const light = daylightAt(gameSeconds);
    const key = `${light.skyTop}|${light.skyLow}`;
    if (key === this.skyKey) return;
    this.skyKey = key;
    const root = document.documentElement.style;
    root.setProperty("--sky-top", light.skyTop);
    root.setProperty("--sky-low", light.skyLow);
    this.hemiLight.intensity = 0.55 + 1.15 * light.level;
    this.sunLight.intensity = 0.1 + 1.9 * light.level;
    const fog = this.scene.fog;
    if (fog instanceof THREE.Fog && this.town.atmosphere) {
      fog.color.set(this.town.atmosphere.fog).multiplyScalar(0.3 + 0.7 * light.level);
      root.setProperty("--sky-top", `#${fog.color.getHexString()}`);
      root.setProperty("--sky-low", `#${fog.color.getHexString()}`);
    }
  }

  /** Walk scheduled NPCs toward their spot for the current time; returns whether the NPC moved. */
  private updateNpcMovement(npc: NpcRuntime, dt: number, gameSeconds: number): boolean {
    if (this.scripted.has(npc)) return this.stepAlongPath(npc, dt);
    if (npc.spec.follows) return this.followPlayer(npc, dt);
    const schedule = npc.spec.schedule;
    if (!schedule || !this.clock.ready) return false;
    const goal = this.holdGoal(npc, gameSeconds) ?? this.meetingGoal(npc, gameSeconds) ?? scheduledCell(schedule, minuteOfDay(gameSeconds));
    if (!npc.placed) {
      npc.placed = true;
      if (goal) this.moveNpcTo(npc, goal, true);
      npc.goal = goal;
      return false;
    }
    const talking = npc.panel?.isOpen ?? false;
    if (goal && !talking && (!npc.goal || goal.x !== npc.goal.x || goal.z !== npc.goal.z)) {
      npc.goal = goal;
      npc.path = this.npcRoute(npc, goal) ?? [];
    }
    if (talking) return false;
    return this.stepAlongPath(npc, dt);
  }

  /** Move one NPC along its current path; returns whether it moved this frame. */
  private stepAlongPath(npc: NpcRuntime, dt: number): boolean {
    const next = npc.path[0];
    if (!next) return false;
    if (!npc.stepFrom) {
      const occupied = (this.cell.x === next.x && this.cell.z === next.y) || this.npcCells.has(`${next.x},${next.y}`);
      if (occupied) return false; // wait for the player or another NPC to step aside
      npc.stepFrom = { ...npc.cell };
      npc.stepT = 0;
      this.npcCells.delete(`${npc.cell.x},${npc.cell.z}`);
      npc.cell = { x: next.x, z: next.y };
      this.npcCells.add(`${npc.cell.x},${npc.cell.z}`);
    }
    const from = npc.stepFrom;
    const dist = Math.hypot(npc.cell.x - from.x, npc.cell.z - from.z) || 1;
    npc.stepT = Math.min(1, npc.stepT + (dt * npc.speed) / dist);
    npc.character.root.position.x = from.x + 0.5 + (npc.cell.x - from.x) * npc.stepT;
    npc.character.root.position.z = from.z + 0.5 + (npc.cell.z - from.z) * npc.stepT;
    npc.character.yaw = Math.atan2(npc.cell.x - from.x, npc.cell.z - from.z);
    if (npc.stepT >= 1) {
      npc.stepFrom = null;
      npc.path.shift();
    }
    return true;
  }

  private npcRoute(npc: NpcRuntime, goal: Cell): GridCell[] | null {
    const own = `${npc.cell.x},${npc.cell.z}`;
    const world = this.town.world;
    return findPath(
      {
        width: world.width,
        height: world.depth,
        isWalkable: (x, z) => world.isStandable(x, z, GROUND_Y) && (`${x},${z}` === own || !this.npcCells.has(`${x},${z}`)),
      },
      { x: npc.cell.x, y: npc.cell.z },
      { x: goal.x, y: goal.z },
    );
  }

  /** Place an NPC on a cell immediately (first load, cutscenes). */
  private moveNpcTo(npc: NpcRuntime, cell: Cell, snap: boolean): void {
    if (!snap) {
      npc.goal = cell;
      npc.path = this.npcRoute(npc, cell) ?? [];
      return;
    }
    this.npcCells.delete(`${npc.cell.x},${npc.cell.z}`);
    npc.cell = { ...cell };
    this.npcCells.add(`${cell.x},${cell.z}`);
    npc.path = [];
    npc.stepFrom = null;
    npc.character.root.position.set(cell.x + 0.5, STAND_Y, cell.z + 0.5);
  }

  // ---------------------------------------------------------------- worlds (Kademe 3)

  private nearbyBoat(): BoatSpec | null {
    const p = this.player.root.position;
    const unlocked = this.adventure?.unlocked_worlds ?? ["town"];
    for (const boat of this.town.boats) {
      if (!canSail(boat.to, new URLSearchParams(window.location.search).get("mode"), unlocked)) continue;
      if (boat.anchors.some((a) => Math.hypot(a.x + 0.5 - p.x, a.z + 0.5 - p.z) <= 2.2)) return boat;
    }
    return null;
  }

  private nearbyGate(): GateSpec | null {
    const p = this.player.root.position;
    for (const gate of this.town.gates) {
      if (gate.blocks.some((b) => Math.hypot(b.x + 0.5 - p.x, b.z + 0.5 - p.z) <= 2.4)) return gate;
    }
    return null;
  }

  /** Sail to another world: the server records it, then the page reloads into that world. */
  private async travel(to: WorldId): Promise<void> {
    if (this.storyBusy) return;
    const missing = this.freePlay ? xpMissing(FREE_PLAY_XP.worlds[to], this.xp) : 0;
    if (missing) {
      this.toast(`🔒 The mist is still too thick. Sailing to ${WORLD_NAMES[to]} needs ${FREE_PLAY_XP.worlds[to]} XP: earn ${missing} more by talking in English!`);
      return;
    }
    this.storyBusy = true;
    try {
      // The story remembers where the player is; free play just sails.
      if (this.adventureMode) await this.coreApi.travel(to);
      this.host.classList.add("is-sleeping"); // fade to black
      window.setTimeout(() => window.location.assign(worldUrl(to, window.location.search)), 700);
    } catch (error: unknown) {
      this.storyBusy = false;
      this.toast(error instanceof Error ? error.message : "The boat can't leave right now.");
    }
  }

  /** A rune gate: open the spell panel (Kademe 3). */
  private onGate(gate: GateSpec): void {
    if (this.openedGates.has(gate.id)) {
      this.toast("The rune gate is already open.");
      return;
    }
    if (this.activePanel && this.activePanel !== this.spellPanel) this.activePanel.close();
    this.activePanel = this.spellPanel;
    this.keys.clear();
    this.path = [];
    this.host.classList.add("is-talking");
    void this.spellPanel.open(gate.id);
  }

  /** Remove a rune gate's blocks and rebuild the world mesh. */
  private openGate(gateId: string, animate: boolean): void {
    if (this.openedGates.has(gateId)) return;
    const gate = this.town.gates.find((g) => g.id === gateId);
    if (!gate) return;
    this.openedGates.add(gateId);
    for (const b of gate.blocks) this.town.world.set(b.x, b.y, b.z, Block.AIR);
    this.rebuildBaseMesh();
    if (animate) {
      const burst = new MagicBurst(gate.blocks);
      this.bursts.push(burst);
      this.scene.add(burst.points);
      this.toast("✨ The rune gate opens!");
    }
  }

  /** The lighthouse lamp turns to crystal and the mist thins (Kademe 3 finale). */
  private lightBeacon(animate: boolean): void {
    if (this.town.id !== "isles" || this.beaconLit) return;
    this.beaconLit = true;
    const lamp = [{ x: 44, y: 14, z: 16 }, { x: 44, y: 15, z: 16 }];
    for (const b of lamp) this.town.world.set(b.x, b.y, b.z, Block.CRYSTAL);
    const lighthouse = this.town.buildings.find((b) => b.id === "lighthouse");
    const upper = lighthouse ? this.upperMeshes.get(lighthouse.id) : undefined;
    if (lighthouse && upper) {
      this.scene.remove(upper);
      upper.geometry.dispose();
      const region: RegionTest = (x, y, z) => isUpperBlock(lighthouse, x, y, z);
      this.upperMeshes.set(lighthouse.id, this.createMesh(buildMeshData(this.town.world, region), this.blockMaterial, region));
    }
    if (this.scene.fog instanceof THREE.Fog) this.scene.fog.far *= 1.8;
    if (animate) {
      const burst = new MagicBurst(lamp, 0xfff3b0, 60);
      this.bursts.push(burst);
      this.scene.add(burst.points);
    }
  }

  /** Kademe 4 finale: the Thornwood's dark earth turns green again. */
  private liftCurse(animate: boolean): void {
    if (this.town.id !== "isles" || this.curseLifted) return;
    this.curseLifted = true;
    const { world } = this.town;
    for (let z = 0; z < world.depth; z++) {
      for (let x = 0; x < world.width; x++) {
        if (!inThornwood(x, z)) continue;
        const ground = world.get(x, GROUND_Y, z);
        const above = world.get(x, GROUND_Y + 1, z);
        if ((ground === Block.DARK || ground === Block.MOSS) && above === Block.AIR) world.set(x, GROUND_Y, z, Block.GRASS);
      }
    }
    this.rebuildBaseMesh();
    if (animate) {
      const burst = new MagicBurst(blockRange(77, 3, 15, 83, 6, 20), 0xb7ff9e, 4);
      this.bursts.push(burst);
      this.scene.add(burst.points);
    }
  }

  private rebuildBaseMesh(): void {
    const { world, buildings } = this.town;
    this.scene.remove(this.baseMesh);
    this.baseMesh.geometry.dispose();
    this.faceCount = 0;
    const baseRegion: RegionTest = (x, y, z) => !buildings.some((b) => isUpperBlock(b, x, y, z));
    this.baseMesh = this.createMesh(buildMeshData(world, baseRegion), this.blockMaterial, baseRegion, true);
    for (const mesh of this.upperMeshes.values()) this.faceCount += (mesh.geometry.index?.count ?? 0) / 6;
  }

  /** A companion keeps a couple of steps behind the player. */
  private followPlayer(npc: NpcRuntime, dt: number): boolean {
    if (!npc.placed) {
      npc.placed = true;
      const start = this.nearestStandable(this.cell.x + 1, this.cell.z);
      if (start) this.moveNpcTo(npc, start, true);
    }
    if (this.companionWaiting) {
      npc.path = [];
      return this.stepAlongPath(npc, dt);
    }
    const now = performance.now();
    const dist = Math.hypot(npc.cell.x - this.cell.x, npc.cell.z - this.cell.z);
    if (now >= this.followCheckAt && !npc.panel?.isOpen && !npc.stepFrom) {
      this.followCheckAt = now + 400;
      const crowding = this.npcs.some((o) => o !== npc && !o.hidden
        && Math.hypot(o.cell.x - npc.cell.x, o.cell.z - npc.cell.z) < 1.6);
      if (dist > 2.5 || crowding) {
        const near = this.cellBesidePlayer(npc);
        npc.path = near ? this.npcRoute(npc, near) ?? [] : [];
      } else {
        npc.path = [];
      }
    }
    npc.speed = dist > 6 ? 4.6 : 3.6;
    return this.stepAlongPath(npc, dt);
  }

  private cellBesidePlayer(npc: NpcRuntime): Cell | null {
    // Prefer a cell behind the player and away from anyone the player might talk to,
    // so the companion never steps in between the player and another NPC.
    const fx = Math.sin(this.player.yaw);
    const fz = Math.cos(this.player.yaw);
    const others = this.npcs.filter((o) => o !== npc && !o.hidden);
    let best: Cell | null = null;
    let bestScore = Infinity;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dz === 0) continue;
        const ring = Math.hypot(dx, dz);
        if (ring > 2.3) continue;
        const x = this.cell.x + dx;
        const z = this.cell.z + dz;
        if (!this.grid.isWalkable(x, z) && !(npc.cell.x === x && npc.cell.z === z)) continue;
        if (others.some((o) => o.cell.x === x && o.cell.z === z)) continue;
        let score = Math.hypot(x - npc.cell.x, z - npc.cell.z) * 0.6 + ring * 0.5;
        score += ((dx * fx + dz * fz) / ring + 1) * 2; // in front of the player costs more
        for (const o of others) {
          const d = Math.hypot(o.cell.x - x, o.cell.z - z);
          if (d < 2.5) score += (2.5 - d) * 3;
        }
        if (score < bestScore) {
          bestScore = score;
          best = { x, z };
        }
      }
    }
    return best;
  }

  /** The NPC walking with the player in this world, if any. */
  private companion(): NpcRuntime | null {
    return this.npcs.find((npc) => npc.spec.follows && !npc.hidden) ?? null;
  }

  /** H: tell the companion to wait here, or call them back. */
  private toggleCompanionWait(): void {
    const npc = this.companion();
    if (!npc) return;
    this.companionWaiting = !this.companionWaiting;
    const line = this.companionWaiting ? "Okay, I'll wait here!" : "Coming!";
    npc.bubbleText.textContent = line;
    npc.replyUntil = performance.now() + 2500;
    this.followCheckAt = 0;
    this.toast(this.companionWaiting
      ? `${npc.spec.name} is waiting here. Press H when you want them back.`
      : `${npc.spec.name} is coming with you.`);
  }

  // ---------------------------------------------------------------- free play XP locks

  /** XP the player still needs to enter this building in free play (0 = open). */
  private placeLock(b: BuildingSpec): number {
    return this.freePlay ? xpMissing(FREE_PLAY_XP.places[b.id], this.xp) : 0;
  }

  /** True (and a hint is shown) when free play keeps the player out of the building at (x, z). */
  private blockedByLock(x: number, z: number): boolean {
    if (!this.freePlay) return false;
    const target = this.town.buildings.find((b) => isInsideBuilding(b, x, z));
    if (!target || target === this.currentBuilding()) return false;
    const missing = this.placeLock(target);
    if (!missing) return false;
    const now = performance.now();
    if (now > this.lockToastAt) {
      this.lockToastAt = now + 2500;
      this.toast(`🔒 ${target.name} opens at ${FREE_PLAY_XP.places[target.id]} XP. Earn ${missing} more XP by talking in English!`);
    }
    return true;
  }

  private async loadXp(): Promise<void> {
    if (!this.freePlay) return;
    try {
      this.setXp((await this.coreApi.getDashboard()).profile.xp);
    } catch {
      this.setXp(this.xp ?? 0);
    }
    // Opening a locked world by its URL leads back to town.
    if (xpMissing(FREE_PLAY_XP.worlds[this.town.id], this.xp)) {
      window.location.replace(worldUrl("town", window.location.search));
    }
  }

  private setXp(xp: number): void {
    const before = this.xp;
    this.xp = xp;
    for (const label of this.labels) {
      const b = this.town.buildings.find((s) => s.id === label.el.dataset["building"]);
      const lock = label.el.querySelector<HTMLElement>(".town-label__lock");
      if (!b || !lock) continue;
      const required = FREE_PLAY_XP.places[b.id];
      lock.hidden = !this.placeLock(b);
      lock.textContent = required ? `🔒 ${required} XP` : "";
      if (before !== null && required && before < required && xp >= required) this.toast(`🔓 ${b.name} is open now!`);
    }
    const isles = FREE_PLAY_XP.worlds.isles;
    if (this.freePlay && this.town.id === "town" && before !== null && before < isles && xp >= isles) {
      this.toast("🔓 The mist has cleared: a boat at the pier can take you to the Misty Isles!");
    }
  }

  // ---------------------------------------------------------------- story (Kademe 2)

  private applyAdventureState(state: AdventureState): void {
    // Adventure remembers which world the player is in; reload into it if this page shows another.
    if (this.adventureMode && state.world && state.world !== this.town.id) {
      window.location.replace(worldUrl(state.world as WorldId, window.location.search));
      return;
    }
    this.adventure = state;
    for (const gateId of state.story_flags?.opened_gates ?? []) this.openGate(gateId, false);
    const lit = allQuests(state.adventure).findIndex((q) => q.id === "light_lighthouse");
    if (lit >= 0 && state.stage > lit) this.lightBeacon(false);
    const lifted = allQuests(state.adventure).findIndex((q) => q.id === "break_curse");
    if (lifted >= 0 && state.stage > lifted) this.liftCurse(false);
    this.adventureJournal?.setState(state);
    this.inventoryPanel.setItems(state.inventory);
    this.updateNpcVisibility();
  }

  /** NPCs with appearsAfterScene stay out of the world until that scene's quest is done. */
  private updateNpcVisibility(): void {
    for (const npc of this.npcs) {
      const sceneId = npc.spec.appearsAfterScene;
      if (!sceneId) continue;
      // Free play on the isles meets everyone there; the story reveals them scene by scene.
      const unlocked = (this.freePlay && this.town.id === "isles") ||
        (this.adventure !== null && this.adventure.stage >= stageAfterScene(this.adventure.adventure, sceneId));
      const hidden = !unlocked && !this.scripted.has(npc);
      if (hidden === npc.hidden) continue;
      npc.hidden = hidden;
      npc.character.root.visible = !hidden;
      const key = `${npc.cell.x},${npc.cell.z}`;
      if (hidden) this.npcCells.delete(key);
      else this.npcCells.add(key);
      if (hidden && npc.panel?.isOpen) npc.panel.close();
    }
    const sam = this.npcs.find((n) => n.spec.id === "sam");
    this.phone.button.hidden = !sam || sam.hidden;
    if (this.phone.button.hidden && this.phone.isOpen) this.phone.close();
  }

  /** Start scene quests and place quests when the player is where the story needs them. */
  private checkStoryTriggers(gameSeconds: number, now: number): void {
    if (now < this.triggerCheckAt) return;
    this.triggerCheckAt = now + 1000;
    if (!this.adventureMode || !this.adventure || this.activePanel || this.storyBusy) return;
    const rule = currentQuest(this.adventure.adventure, this.adventure.stage)?.complete_when;
    if (!rule) return;
    if (rule.type === "scene" && rule.scene_id && rule.trigger) {
      if ((rule.trigger.world ?? "town") !== this.town.id) return;
      if (rule.trigger.near_building) {
        const building = this.town.buildings.find((b) => b.id === rule.trigger?.near_building);
        if (!building || this.currentBuilding()?.id === building.id) return;
        const p = this.player.root.position;
        if (Math.hypot(p.x - (building.door.x + 0.5), p.z - (building.door.z + 0.5)) > 5) return;
      }
      const minute = minuteOfDay(gameSeconds);
      const from = parseClock(rule.trigger.from);
      const to = parseClock(rule.trigger.to);
      if (minute < from || minute >= to) return;
      void this.runSceneQuest(rule.scene_id);
    } else if (rule.type === "reach_place" && rule.place_id && now >= this.reachBusyUntil && this.playerAt(rule.place_id)) {
      this.reachBusyUntil = now + 8000;
      void this.tryReach(rule.place_id);
    }
  }

  private async runSceneQuest(sceneId: string): Promise<void> {
    const api = this.coreApi;
    if (!api) return;
    this.storyBusy = true;
    try {
      await this.playScene(sceneId);
      this.applyAdventureState(await api.sceneSeen(sceneId));
      void this.phone.refresh();
    } catch {
      this.toast("The story could not continue right now. Try again in a moment.");
    } finally {
      this.storyBusy = false;
    }
  }

  private async tryReach(placeId: string): Promise<void> {
    const api = this.coreApi;
    if (!api) return;
    this.storyBusy = true;
    try {
      const result = await api.reachPlace(placeId);
      if (result.completed) {
        if (result.scene_id) {
          this.adventure = { ...result, flags: result.flags ?? { kept_meeting: false, missed_meeting: false } };
          await this.playScene(result.scene_id);
        }
        this.applyAdventureState(result);
      } else if (result.missing.length) {
        const names = result.missing.map((id) => id.replace(/_/g, " ")).join(", ");
        this.toast(`Bring this with you: ${names}`);
      }
    } catch {
      // Try again on the next visit.
    } finally {
      this.storyBusy = false;
    }
  }

  /** Load and play a cutscene; returns false if it could not be loaded. */
  private async playScene(sceneId: string): Promise<boolean> {
    if (this.cutscene.isPlaying) return false;
    const api = this.coreApi;
    if (!api) return false;
    let scene;
    try {
      scene = await api.getCutscene(sceneId);
    } catch {
      return false;
    }
    this.activePanel?.close();
    this.keys.clear();
    this.path = [];
    this.companionWaiting = false;
    this.pendingTalk = null;
    this.pendingProp = null;
    this.pendingActivity = null;
    this.host.classList.add("in-cutscene");
    const after = scene.after;
    const stays = new Set(after?.stay ?? []);
    const note = scene.summary ? `${scene.summary} You are still together with the player right after this.` : null;
    try {
      await this.cutscene.play(scene, this.cutsceneStage());
    } finally {
      this.host.classList.remove("in-cutscene");
      this.sceneFocus = null;
      if (this.savedZoom !== null) this.rig.zoom = this.savedZoom;
      this.savedZoom = null;
      const now = this.clock.now();
      for (const npc of this.scripted) {
        npc.path = [];
        npc.speed = NPC_SPEED;
        npc.goal = null; // scheduled NPCs pick their routine up again…
        if (stays.has(npc.spec.id)) {
          // …unless the scene says they stay with the player for a while.
          npc.hold = { cell: { ...npc.cell }, until: now + HANGOUT_SECONDS, note };
        } else if (!npc.spec.schedule) {
          this.moveNpcTo(npc, npc.spec.cell, true);
        }
      }
      this.scripted.clear();
      for (const waiter of this.waiters.splice(0)) waiter.resolve();
      this.updateNpcVisibility();
    }
    const talkTo = after?.talk ? this.actor(after.talk) : null;
    if (talkTo && !talkTo.hidden) this.openDialogue(talkTo);
    return true;
  }

  private actor(who: string): NpcRuntime | null {
    return this.npcs.find((n) => n.spec.id === who) ?? null;
  }

  private cutsceneStage(): CutsceneStage {
    return {
      flags: this.adventure?.flags ?? { kept_meeting: false, missed_meeting: false },
      actorName: (who) => (who === "player" ? "You" : this.actor(who)?.spec.name ?? who),
      placeActor: (who, cell) => {
        if (who === "player") {
          this.snapPlayer(cell);
          return;
        }
        const npc = this.actor(who);
        if (!npc) return;
        this.claim(npc);
        this.moveNpcTo(npc, cell, true);
      },
      walkActor: (who, to, run) => {
        if (who === "player") {
          this.walkTo(to);
          return this.waitUntil(() => this.path.length === 0 && this.segmentFrom === null, 10_000, () => this.snapPlayer(to));
        }
        const npc = this.actor(who);
        if (!npc) return Promise.resolve();
        this.claim(npc);
        npc.speed = run ? 4.4 : NPC_SPEED;
        npc.path = this.npcRoute(npc, to) ?? [];
        if (!npc.path.length && (npc.cell.x !== to.x || npc.cell.z !== to.z)) this.moveNpcTo(npc, to, true);
        return this.waitUntil(() => npc.path.length === 0 && npc.stepFrom === null, 10_000, () => this.moveNpcTo(npc, to, true));
      },
      cellNear: (who) => {
        const npc = this.actor(who);
        const base = npc ? npc.cell : this.cell;
        for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1]] as const) {
          if (this.grid.isWalkable(base.x + dx, base.z + dz)) return { x: base.x + dx, z: base.z + dz };
        }
        return null;
      },
      focus: (target, zoom) => {
        this.sceneFocus = target;
        if (zoom !== undefined) {
          if (this.savedZoom === null) this.savedZoom = this.rig.zoom;
          this.rig.zoom = Math.max(7, Math.min(30, zoom));
        }
      },
      speak: (who, text) => this.speakLine(who, text),
      toast: (text) => this.toast(text),
      trigger: (name) => {
        if (name === "light_beacon") this.lightBeacon(true);
        if (name === "lift_curse") this.liftCurse(true);
      },
      converse: async (who, text, sceneNote) => {
        const npc = this.actor(who);
        const api = npc ? this.apiFor(npc.spec.location) : null;
        if (!npc || !api) throw new Error(`${who} cannot talk right now.`);
        const result = await api.sendTurn(text, sceneNote);
        this.applyTurnResult(result);
        if (result.accepted) {
          if (npc.panel) npc.panel.recordExchange(text, result.npc_response);
          else {
            rememberDialogueMessage(npc.spec.location, { author: "YOU", text, kind: "user" });
            rememberDialogueMessage(npc.spec.location, { author: npc.spec.name.toUpperCase(), text: result.npc_response, kind: "npc" });
          }
        }
        return result;
      },
    };
  }

  /** A cutscene takes over an NPC: visible, out of its routine until the scene ends. */
  private claim(npc: NpcRuntime): void {
    this.scripted.add(npc);
    npc.placed = true;
    if (npc.hidden) {
      npc.hidden = false;
      npc.character.root.visible = true;
      this.npcCells.add(`${npc.cell.x},${npc.cell.z}`);
    }
    if (npc.panel?.isOpen) npc.panel.close();
  }

  private snapPlayer(cell: Cell): void {
    this.path = [];
    this.segmentFrom = null;
    this.cell = { ...cell };
    this.player.root.position.set(cell.x + 0.5, STAND_Y, cell.z + 0.5);
  }

  private async speakLine(who: string, text: string): Promise<void> {
    const seconds = Math.min(8, 1.5 + text.split(/\s+/).length * 0.35);
    const npc = who === "player" ? null : this.actor(who);
    if (who !== "player" && !npc) throw new Error(`Unknown speaker ${who}`);
    (npc ? npc.character : this.player).talk(seconds, performance.now());
    const api = this.apiFor(npc ? npc.spec.location : "bakery");
    if (!api) throw new Error("No voice");
    const profile = npc ? ROLEPLAY_TTS_PROFILES[npc.spec.voice] : ROLEPLAY_TTS_PROFILES.player;
    const blob = await api.synthesizeSpeech(text, profile);
    const url = URL.createObjectURL(blob);
    try {
      const audio = new Audio(url);
      const echo = "echo" in profile && profile.echo === true;
      if (echo) withEcho(audio);
      await new Promise<void>((resolve, reject) => {
        audio.addEventListener("ended", () => (echo ? window.setTimeout(resolve, ECHO_TAIL_MS) : resolve()));
        audio.addEventListener("error", () => reject(new Error("Audio failed")));
        audio.play().catch(reject);
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private targetPosition(target: CutsceneTarget): { x: number; z: number } | null {
    if (typeof target !== "string") return { x: target.x + 0.5, z: target.z + 0.5 };
    if (target === "player") return this.player.root.position;
    const npc = this.actor(target);
    return npc ? npc.character.root.position : null;
  }

  private waitUntil(done: () => boolean, timeoutMs: number, onTimeout: () => void): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push({ done, resolve, deadline: performance.now() + timeoutMs, onTimeout });
    });
  }

  private resolveWaiters(now: number): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i];
      if (!waiter) continue;
      if (waiter.done()) {
        this.waiters.splice(i, 1);
        waiter.resolve();
      } else if (now > waiter.deadline) {
        this.waiters.splice(i, 1);
        waiter.onTimeout();
        waiter.resolve();
      }
    }
  }

  private updateWorld(): void {
    const inside = this.currentBuilding();
    for (const [id, mesh] of this.upperMeshes) mesh.visible = id !== inside?.id;

    // What can the player do right now?
    // The companion walks with the player, so it must never hide a door, boat or gate:
    // other NPCs first, then the place itself, and the companion only when nothing else is here.
    let nearest: NpcRuntime | null = null;
    this.nearCompanion = null;
    for (const npc of this.npcs) {
      if (npc.hidden) continue;
      const d = this.distanceTo(npc);
      if (d > TALK_RANGE) continue;
      if (npc.spec.follows) {
        this.nearCompanion = npc;
        continue;
      }
      if (!nearest || d < this.distanceTo(nearest)) nearest = npc;
    }
    if (nearest) this.interaction = { kind: "npc", npc: nearest };
    else if (inside?.activity && this.nearActivity(inside)) this.interaction = { kind: "activity", building: inside };
    else if (inside?.portal) this.interaction = { kind: "portal", building: inside };
    else {
      const boat = !inside ? this.nearbyBoat() : null;
      const gate = !inside && !boat ? this.nearbyGate() : null;
      this.interaction = boat ? { kind: "boat", boat } : gate ? { kind: "gate", gate } : null;
    }
    if (!this.interaction && this.nearCompanion) this.interaction = { kind: "npc", npc: this.nearCompanion };
    this.talkers = this.npcs
      .filter((npc) => !npc.hidden && this.distanceTo(npc) <= TALK_RANGE)
      .sort((a, b) => Number(!!a.spec.follows) - Number(!!b.spec.follows) || this.distanceTo(a) - this.distanceTo(b));

    // Nearest vocabulary prop in the same building.
    this.nearestProp = null;
    if (inside) {
      let bestDist = Infinity;
      for (const prop of this.town.props) {
        if (prop.buildingId !== inside.id) continue;
        this.loadProgressFor(prop.location);
        const d = this.propDistance(prop);
        if (d <= PROP_RANGE && d < bestDist) {
          bestDist = d;
          this.nearestProp = prop;
        }
      }
    }
    for (const [id, helper] of this.propHighlights) {
      const otherPanelOpen = this.activePanel !== null && this.activePanel !== this.vocabPanel;
      const focused = !otherPanelOpen && (id === this.nearestProp?.id || id === this.pendingProp?.id);
      helper.visible = focused;
      if (focused) {
        (helper.material as THREE.LineBasicMaterial).color.setHex(this.completedProps.has(id) ? HIGHLIGHT_DONE : HIGHLIGHT);
      }
    }
    const vocabTarget = this.nearestProp;
    this.vocabPrompt.hidden = !vocabTarget || this.vocabPanel.isOpen;
    if (vocabTarget) {
      this.vocabPrompt.textContent = this.completedProps.has(vocabTarget.id)
        ? "F · What's this? (complete)"
        : "F · What's this in English?";
    }

    const it = this.interaction;
    const actions: Array<{ key: string; label: string; run: () => void }> = [];
    if (it && it.kind !== "npc") {
      const sailLock = it.kind === "boat" && this.freePlay ? xpMissing(FREE_PLAY_XP.worlds[it.boat.to], this.xp) : 0;
      const label = it.kind === "boat"
        ? sailLock ? `🔒 ${it.boat.label} (${FREE_PLAY_XP.worlds[it.boat.to]} XP)` : it.boat.label
        : it.kind === "gate"
          ? this.openedGates.has(it.gate.id) ? "The gate is open" : "Cast a spell"
        : it.building.activity
          ? it.building.activity.label
          : it.building.portal?.label ?? "Enter";
      const key = it.kind === "activity" && it.building.activity ? it.building.activity.key : "Enter";
      actions.push({ key, label, run: () => this.interact() });
    }
    const many = this.talkers.length > 1;
    this.talkers.slice(0, 9).forEach((npc, i) => {
      actions.push({ key: many ? String(i + 1) : "T", label: `Talk to ${npc.spec.name}`, run: () => this.openDialogue(npc) });
    });
    const companion = this.companion();
    if (companion && (this.companionWaiting || this.nearCompanion)) {
      actions.push({
        key: "H",
        label: this.companionWaiting ? `Call ${companion.spec.name}` : `${companion.spec.name}, wait here`,
        run: () => this.toggleCompanionWait(),
      });
    }
    const talking = this.talkers.some((n) => n.panel?.isOpen);
    const show = actions.length > 0 && !talking;
    this.prompt.hidden = !show;
    const key = show ? actions.map((a) => `${a.key}|${a.label}`).join("/") : "";
    if (key !== this.promptKey) {
      this.promptKey = key;
      this.promptActions = actions.map((a) => a.run);
      this.prompt.replaceChildren(...actions.map((a, i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = i === 0 ? "town-prompt" : "town-prompt town-prompt--more";
        btn.dataset["i"] = String(i);
        const kbd = document.createElement("kbd");
        kbd.textContent = a.key;
        btn.append(kbd, a.label);
        return btn;
      }));
    }
  }

  private updateOverlays(now: number): void {
    for (const label of this.labels) this.place(label.el, label.anchor);
    for (const npc of this.npcs) {
      const hasReply = now < npc.replyUntil;
      // Sam's old fixed greeting is not part of the shared conversation.
      const idleOk = npc.spec.id !== "sam"
        && (!npc.spec.follows || (this.interaction?.kind === "npc" && this.interaction.npc === npc));
      const show = !npc.hidden && (hasReply || (npc.near && idleOk && !npc.panel?.isOpen && !this.cutscene.isPlaying));
      npc.bubble.hidden = !show;
      if (!show) continue;
      if (!hasReply) npc.bubbleText.textContent = npc.spec.greeting;
      this.tmp.set(npc.character.root.position.x, STAND_Y + 2.35, npc.character.root.position.z);
      this.place(npc.bubble, this.tmp);
    }
  }

  private place(el: HTMLElement, world: THREE.Vector3): void {
    const v = this.tmp.copy(world).project(this.rig.camera);
    if (v.z > 1 || v.z < -1) {
      el.style.visibility = "hidden";
      return;
    }
    el.style.visibility = "visible";
    const x = ((v.x + 1) / 2) * this.host.clientWidth;
    const y = ((1 - v.y) / 2) * this.host.clientHeight;
    // Keep bubbles and labels on screen (narrow phone screens).
    const maxX = this.host.clientWidth - el.offsetWidth - 4;
    const left = Math.min(Math.max(4, x - el.offsetWidth / 2), Math.max(4, maxX));
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(y - el.offsetHeight - 8)}px)`;
  }

  private updateStats(dt: number): void {
    this.fpsTime += dt;
    this.fpsFrames++;
    this.statsTime += dt;
    if (this.statsTime < 0.5) return;
    const fps = Math.round(this.fpsFrames / this.fpsTime);
    this.fpsTime = 0;
    this.fpsFrames = 0;
    this.statsTime = 0;
    const nf = new Intl.NumberFormat("en-US");
    this.stats.textContent =
      `${nf.format(this.blockCount)} blocks · ${nf.format(this.faceCount)} faces · ` +
      `${this.renderer.info.render.calls} draw calls · ${fps} fps`;
  }
}
