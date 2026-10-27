# RoleApp

RoleApp is a game for practicing English by talking and acting in a small 3D block town. Players speak or type to NPCs powered by language models, get feedback on their English, and move a story forward through what they actually say and do.

## Modes

- **Roleplay:** Walk around the town freely and practice everyday conversations with Maya at the bakery, Lina at the library, Leo at the café and other townspeople.
- **Adventure:** A story in four tiers, from A1 to B1. The player helps an old friend Sam, sails to the Misty Isles, opens rune gates with spells and finally breaks the curse of the Thornwood Witch. Quests complete through real conversations, item handovers, meetings and cutscenes.
- **Dub the Scene:** Pick a film scene and a character, record the lines, see word-level feedback and replay the scene with your own voice.

Along the way, NPCs remember what happened with the player and their relationship changes over time. A Spell Book tracks the words the player struggles with, and a Progress Journal shows grammar, vocabulary and activity.

## Architecture

| Service | Stack | Responsibility |
|---|---|---|
| `game` | TypeScript, three.js, Vite | Town, modes, panels and dubbing interface |
| `api` | FastAPI, SQLAlchemy, Alembic | Sessions, quests, inventory, NPC memory, world clock, analytics |
| `ai` | FastAPI, Gemini / Groq / Nebius | NPC replies, language evaluation, corrections, item and plan decisions, STT, TTS |
| `db` | PostgreSQL 16 | Player and gameplay data |

The client talks only to the `api` service; the `api` calls the `ai` service for every conversation turn. Story content (quests, NPCs, scenarios, cutscenes, vocabulary, spells) lives as JSON in `api/game_data/`, so new content needs no code change.

## Run locally

1. Copy `.env.example` to `.env` and set at least `GROQ_API_KEY` (optionally `GEMINI_API_KEY`).
2. Start everything with Docker:

```bash
docker compose up --build -d
```

Then open <http://localhost:5173>. API docs are at <http://localhost:8000/docs> and AI service docs at <http://localhost:8001/docs>.

Tests:

```bash
docker compose exec -T game npm test
docker compose exec -T api python -m unittest discover -s tests
docker compose exec -T ai python -m unittest discover -s tests
```
