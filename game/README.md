# RoleApp game client

The Vite entry point, `index.html`, opens an English three-card selector:

- **Roleplay** — everyday conversations in the three.js block town (`?mode=roleplay`).
- **Adventure** — the same town with a three-step, server-persisted quest chain (`?mode=adventure`).
- **Dub the Scene** — voice a character in a film scene (`?open=dub`).

The town contains Maya's bakery, Lina's library, Leo's café, and the Dub Shop. The old Phaser page at `studio.html?scene=...` remains for deep links; the town and opening cards are the current player flow. Combat and later story chapters are not implemented.

## Run

The full Docker stack is described in the [root README](../README.md). It runs Vite on <http://localhost:5173> and connects to the API at <http://localhost:8000>.

For frontend-only development, use Node.js 24:

```bash
npm ci
npm run dev
```

The client reads `window.PRAGLISH_API_BASE_URL` when supplied before its script loads; otherwise it calls `http://localhost:8000`. That runtime variable name is retained for compatibility. For UI work without the real API, start `npm run dev:mock-api` in another terminal. The mock returns fixed speech text and a silent WAV, so it cannot verify real AI or audio quality.

## Town controls

| Input | Action |
|---|---|
| Click floor, arrow keys, or `W`/`A`/`S`/`D` | Move |
| `T` near a character | Talk |
| `F` near an object | Name it in English |
| `E` | Inventory |
| `G` in Adventure | Quest journal |
| `B` | Spell Book |
| `P` | Progress Journal |
| `K` near CD shelves | Dubbing shop |
| `Enter` near an activity or portal | Interact |
| `Esc` | Close the active panel |

Keyboard shortcuts do not run while typing in a conversation field. The microphone uses browser `getUserMedia` and `MediaRecorder`; use localhost or HTTPS.

## Adventure inventory

The API decides when items enter or leave the player inventory after an accepted Adventure exchange. The UI displays the server's item IDs, English names, and quantities in a nine-slot hotbar plus at least 27 bag slots. Hovering over an occupied slot shows its name and quantity.

Known item IDs map to SVGs in `public/assets/inventory/`, including the boat-building handbook. Every other item uses `item.svg` as a generic fallback; it does not need a new image to appear in inventory. There is no runtime image generator. Adventure progress and inventory persist on the server; dubbing completion uses browser `localStorage`.

## Validation

```bash
npm run typecheck
npm test
npm run build
```

The player sprite sheet's attribution details are in `public/assets/characters/SOURCE.md`.
