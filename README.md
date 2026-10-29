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

1. Copy `.env.example` to `.env` and set `GROQ_API_KEY` or `GEMINI_API_KEY`. To use NVIDIA Nemotron for NPC dialogue, also set `NEBIUS_API_KEY`. Never commit `.env`.
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
## NVIDIA Nemotron on Nebius Token Factory

NPC dialogue uses an NVIDIA Nemotron chat model through the Nebius Token Factory inference API when `NEBIUS_API_KEY` is set. The AI service reads the available model catalog and prefers a Nemotron Super chat model; set `NEBIUS_MODEL` to pin a specific available model. Every NPC turn sends the character instructions and conversation history to Token Factory's `/v1/chat/completions` endpoint. A failed Nebius request falls back to the configured Gemini or Groq text provider. Without a Nebius key, NPC dialogue uses Gemini or Groq directly.

Token Factory serves the model through a hosted inference API, so the game can generate live NPC replies without hosting NVIDIA model weights or managing inference GPUs. This keeps the interactive conversation path simple to deploy. The speech and language evaluation paths currently use Gemini or Groq; they do not use Nebius. No other Nebius service is required by this project.

To verify the active NPC provider, open `http://localhost:8001/health` after starting the stack and check `npc_dialogue`. A value of `nvidia-nemotron@nebius` confirms the configured route; make a test NPC turn to confirm a successful live inference call.

## Deploy

Deploy `roleapp-ai` and `roleapp-api` from `render.yaml` as Docker web services on Render. Provide `DATABASE_URL` for a PostgreSQL database, `NEBIUS_API_KEY`, and at least one of `GEMINI_API_KEY` or `GROQ_API_KEY` in the service settings. Set `AI_SERVICE_URL` on `roleapp-api` to the public URL of `roleapp-ai`; leave `USE_MOCK_AI=false`. Deploy the `game` directory to Vercel as a Vite project (build command `npm run build`, output directory `dist`). Its production pages call `https://roleapp-api.onrender.com`; if Render assigns a different API URL, update the two HTML page settings before building. Set `CORS_ORIGINS` on the API to the exact public game origin.

Check `/health` on both backend services, then start a new game session and complete an NPC turn in the public client. Keep all API keys in service environment variables, never in browser code or the repository.

## License

RoleApp is released under the [MIT License](LICENSE), an OSI-approved open source license.
