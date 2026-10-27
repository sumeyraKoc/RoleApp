import type { InventoryEntry } from "../services/PraglishApiClient";
import "./inventory.css";

const DEFAULT_ICON = "/assets/inventory/item.svg";

/** Icons follow the item id: drop public/assets/inventory/<item_id>.svg to give a new item its icon. */
function iconFor(itemId: string): string {
  return /^[a-z][a-z0-9_]*$/.test(itemId) ? `/assets/inventory/${itemId}.svg` : DEFAULT_ICON;
}

export class InventoryPanel {
  private readonly root: HTMLElement;
  private readonly bag: HTMLElement;
  private readonly hotbar: HTMLElement;
  private readonly status: HTMLElement;
  private items: InventoryEntry[] = [];
  private loaded = false;
  private error: string | null = null;

  constructor(container: HTMLElement, private readonly onClose: () => void) {
    this.root = document.createElement("section");
    this.root.className = "inventory-overlay";
    this.root.hidden = true;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "Inventory");
    this.root.innerHTML = `
      <div class="inventory-window">
        <header class="inventory-window__header">
          <div><small>ADVENTURE GEAR</small><h2>INVENTORY</h2></div>
          <button type="button" class="inventory-window__close" aria-label="Close inventory">✕</button>
        </header>
        <p class="inventory-window__status" role="status"></p>
        <div class="inventory-window__section"><span>BAG</span><small>AT LEAST 27 SLOTS</small></div>
        <div class="inventory-grid" data-bag aria-label="Bag slots"></div>
        <div class="inventory-window__section"><span>HOTBAR</span><small>9 SLOTS</small></div>
        <div class="inventory-grid inventory-grid--hotbar" data-hotbar aria-label="Hotbar slots"></div>
        <p class="inventory-window__hint">Items appear here when they are actually handed over in a conversation.<span class="kbd-only"> Press <kbd>E</kbd> or <kbd>Esc</kbd> to close.</span></p>
      </div>`;
    container.appendChild(this.root);
    const bag = this.root.querySelector<HTMLElement>("[data-bag]");
    const hotbar = this.root.querySelector<HTMLElement>("[data-hotbar]");
    const status = this.root.querySelector<HTMLElement>(".inventory-window__status");
    if (!bag || !hotbar || !status) throw new Error("Inventory panel is incomplete");
    this.bag = bag;
    this.hotbar = hotbar;
    this.status = status;
    this.root.querySelector<HTMLButtonElement>(".inventory-window__close")?.addEventListener("click", () => this.close());
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" || event.key.toLowerCase() === "e") this.close();
      event.stopPropagation();
    });
    this.render();
  }

  get isOpen(): boolean { return !this.root.hidden; }

  open(): void {
    this.root.hidden = false;
    this.root.querySelector<HTMLButtonElement>(".inventory-window__close")?.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.onClose();
  }

  setItems(items: InventoryEntry[]): void {
    this.items = items.map((item) => ({ ...item }));
    this.loaded = true;
    this.error = null;
    this.render();
  }

  addItems(changes: InventoryEntry[]): void {
    for (const change of changes) {
      const current = this.items.find((item) => item.item_id === change.item_id);
      if (current) current.quantity += change.quantity;
      else this.items.push({ ...change });
    }
    this.items = this.items.filter((item) => item.quantity > 0);
    this.loaded = true;
    this.error = null;
    this.render();
  }

  setError(message: string): void {
    this.error = message;
    this.loaded = true;
    this.render();
  }

  private render(): void {
    this.status.textContent = this.error ?? (!this.loaded ? "Loading inventory…" : this.items.length ? `${this.items.length} item types · ${this.items.reduce((sum, item) => sum + item.quantity, 0)} items` : "Your inventory is empty.");
    const bagSlots = Math.max(27, Math.ceil(Math.max(0, this.items.length - 9) / 9) * 9);
    this.bag.replaceChildren(...Array.from({ length: bagSlots }, (_, index) => this.slot(this.items[index + 9])));
    this.hotbar.replaceChildren(...Array.from({ length: 9 }, (_, index) => this.slot(this.items[index], index + 1)));
  }

  private slot(item?: InventoryEntry, hotbarNumber?: number): HTMLElement {
    const slot = document.createElement("div");
    slot.className = "inventory-slot";
    slot.setAttribute("role", "img");
    slot.setAttribute("aria-label", item ? `${item.name}, ${item.quantity} items` : "Empty slot");
    if (hotbarNumber) {
      const number = document.createElement("small");
      number.textContent = String(hotbarNumber);
      slot.append(number);
    }
    if (item) {
      const img = document.createElement("img");
      img.src = iconFor(item.item_id);
      img.alt = "";
      img.onerror = () => {
        img.onerror = null;
        img.src = DEFAULT_ICON;
      };
      slot.append(img);
      const amount = document.createElement("strong");
      amount.textContent = String(item.quantity);
      slot.append(amount);
      slot.title = `${item.name} ×${item.quantity}`;
    }
    return slot;
  }
}
