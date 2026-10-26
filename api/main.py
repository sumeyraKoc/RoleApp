import logging
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from core.migrate import upgrade_database
from services.adventure_quests import load_adventure
from services.npc_memory import load_npcs
from services.plans import load_plans
from services.spells import load_spells
from routes import adventure, analytics, dub, leaderboard, session, phone, plans, speech, spellbook, spells, turn, user, vocabulary, world

logger = logging.getLogger("uvicorn.error")

app = FastAPI(title="English World - API Service")

allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    # Phones on the same Wi-Fi open the dev game at the computer's local address.
    allow_origin_regex=r"^http://(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+):5173$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # ONEMLI: @app.exception_handler(Exception) (yani ciplak Exception sinifi)
    # Starlette tarafindan ozel olarak ele alinir ve ExceptionMiddleware'e degil,
    # dogrudan EN DISTAKI ServerErrorMiddleware'e baglanir - ki o CORSMiddleware'in
    # DISINDA oturuyor. Yani bu handler calisip 500 donse bile, cevap
    # CORSMiddleware'in icinden GECMEZ ve Access-Control-Allow-Origin header'i
    # otomatik eklenmez. Tarayicida gercek 500 hatasi, "CORS policy" hatasi gibi
    # gorunur. Bu yuzden header'i burada MANUEL olarak ekliyoruz.
    logger.exception("Unhandled exception while handling %s", request.url, exc_info=exc)
    response = JSONResponse(status_code=500, content={"detail": "Internal server error"})
    origin = request.headers.get("origin")
    if origin and origin in allowed_origins:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    return response


app.include_router(session.router, prefix="/api/session", tags=["session"])
app.include_router(turn.router, prefix="/api/session", tags=["turn"])
app.include_router(user.router, prefix="/api/user", tags=["user"])
app.include_router(leaderboard.router, prefix="/api/leaderboard", tags=["leaderboard"])
app.include_router(vocabulary.router, prefix="/api/vocabulary", tags=["vocabulary"])
app.include_router(speech.router, prefix="/api/speech", tags=["speech"])
app.include_router(dub.router, prefix="/api/dub", tags=["dub"])
app.include_router(analytics.router, prefix="/api/analytics", tags=["analytics"])
app.include_router(spellbook.router, prefix="/api/spellbook", tags=["spellbook"])
app.include_router(adventure.router, prefix="/api/adventure", tags=["adventure"])
app.include_router(world.router, prefix="/api/world", tags=["world"])
app.include_router(phone.router, prefix="/api/phone", tags=["phone"])
app.include_router(plans.router, prefix="/api/plans", tags=["plans"])
app.include_router(spells.router, prefix="/api/spells", tags=["spells"])


@app.on_event("startup")
def on_startup():
    # Fail fast on broken game_data content instead of on the first quest turn.
    load_adventure()
    load_npcs()
    load_plans()
    load_spells()
    upgrade_database()


@app.get("/health")
def health():
    return {"status": "ok", "service": "api"}
