import logging
import math
import os
import time
import uuid
from functools import lru_cache

import httpx
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from dotenv import load_dotenv

from modules import (
    CorrectionModule,
    CorrectionProvider,
    CorrectExtractor,
    ExtractionProvider,
    GeminiCorrectionProvider,
    GeminiCorrectExtractionProvider,
    GeminiIncorrectExtractionProvider,
    GeminiPlausibilityEstimator,
    GeminiSpeechToTextProvider,
    GeminiTextToSpeechProvider,
    GeminiTextGenerator,
    GroqCorrectionProvider,
    GroqCorrectExtractionProvider,
    GroqIncorrectExtractionProvider,
    GroqPlausibilityEstimator,
    GroqSpeechToTextProvider,
    GroqTextToSpeechProvider,
    GroqTextGenerator,
    IncorrectExtractor,
    LanguageEvaluator,
    NpcModule,
    PlausibilityEstimator,
    SpeechToTextProvider,
    SpeechRateLimitError,
    TextGenerator,
    TextToSpeechProvider,
)

from shared.schemas import (
    InventoryDecisionRequest,
    InventoryDecisionResponse,
    CorrectionInput,
    CorrectionResult,
    CorrectExtractionResult,
    EvaluateRequest,
    EvaluateResponse,
    ExtractionRequest,
    IncorrectExtractionResult,
    LanguageEvaluationInput,
    NPCIdentity,
    NPCTask,
    PlanDecisionRequest,
    PlanDecisionResponse,
    SentenceCheckRequest,
    SentenceCheckResponse,
    STTResponse,
    TTSRequest,
)

load_dotenv()

app = FastAPI(title="English World - AI Service")
logger = logging.getLogger("uvicorn.error")


@app.post("/sentence/check", response_model=SentenceCheckResponse)
def sentence_check(payload: SentenceCheckRequest):
    """Spell check for rune gates: the evaluator judges the sentence; rejected ones get a correction."""
    evaluation = get_language_evaluator().evaluate(
        LanguageEvaluationInput(
            utterance=payload.utterance,
            context=payload.context,
            speaker="player",
            listener="rune gate",
            communicative_goals=[f"Use the word '{payload.target_word}' correctly and naturally in a full sentence"],
        )
    )
    correction = None
    if not evaluation.accepted:
        correction = get_correction_module().correct(
            CorrectionInput(utterance=payload.utterance, dialogue_history=[])
        ).corrected_utterance
    return SentenceCheckResponse(
        accepted=evaluation.accepted,
        probability_percent=evaluation.probability_percent,
        reason=evaluation.brief_reason,
        correction=correction,
    )


@app.post("/plan/decide", response_model=PlanDecisionResponse)
def plan_decide(payload: PlanDecisionRequest):
    from modules.plan_decision import decide_plan

    return decide_plan(payload)


@app.post("/inventory/decide", response_model=InventoryDecisionResponse)
def inventory_decide(payload: InventoryDecisionRequest):
    from modules.inventory_decision import decide_inventory_transfers

    return decide_inventory_transfers(payload)

NPC_PROFILES = {
    ("bakery", "baker"): {
        "name": "Maya",
        "personality": "Warm, cheerful, patient, and concise",
    },
    ("library", "librarian"): {
        "name": "Lina",
        "personality": "Warm, knowledgeable, patient, and concise",
    },
    ("cafe", "barista"): {
        "name": "Leo",
        "personality": "Friendly, laid-back, upbeat, and concise",
    },
    ("town", "friend"): {
        "name": "Sam",
        "personality": (
            "Sam Rivera, the player's childhood friend, just moved back to town and wants to be a "
            "photographer; his camera is always around his neck. Energetic and casual (\"No way!\", "
            "\"That's wild.\", \"Deal!\"), a little messy, usually five minutes late but always keeps "
            "his promises. He never corrects the player's English; if he does not understand he asks "
            "\"Wait, what do you mean?\". As kids he and the player built a raft at the pier that broke "
            "on the first wave. He keeps why he came back (he lost his job in the city) private unless "
            "he feels close to the player."
        ),
    },
    ("lighthouse", "keeper"): {
        "name": "Elowen",
        "personality": (
            "Elowen, the old keeper of the dark lighthouse on the Misty Isles. Calm, wise, a little "
            "mysterious, kind to travellers. The lighthouse went dark years ago when its lamp crystal "
            "broke, and the mist has never lifted since. To light it again you need a Mist Lantern; "
            "Tobias at the Mist Market has the last one, and he never gives anything away for free. "
            "She speaks in clear, simple sentences and enjoys gentle riddles."
        ),
    },
    ("market", "merchant"): {
        "name": "Tobias",
        "personality": (
            "Tobias, a sly but good-hearted merchant at the Mist Market. Dramatic, playful, loves to "
            "bargain. He sells charms, maps and the last Mist Lantern. He knows the old keeper Elowen "
            "lives in the lighthouse beyond the rune gate, and that the gate opens only to a spell "
            "spoken in good English. IMPORTANT: he never hands over the Mist Lantern for nothing. He "
            "gives it only after the player offers a fair trade (for example food, a drink, a book, "
            "a photo or a favour) or bargains politely and convincingly; then he hands it over and "
            "says so clearly. Until then he teases, haggles and asks what they can offer."
        ),
    },
    ("lab", "alchemist"): {
        "name": "Orrin",
        "personality": (
            "Orrin, an old, excitable and slightly absent-minded alchemist who lives in the Alchemy Lab on the "
            "eastern isle. He loves flasks, careful measurements and lab safety, and speaks in short, lively "
            "sentences. He treats the player as his lab assistant: he asks them to read labels, follow recipes "
            "step by step and name the tools (flask, cauldron, scales, mortar). He knows Morwen, the witch of the "
            "Thornwood, cast a curse, and that a moonlight potion of a Moonpetal and Silver Salt can break it."
        ),
    },
    ("tower", "witch"): {
        "name": "Morwen",
        "personality": (
            "Morwen, the ancient witch of the Thornwood, who lives alone in a dark tower. She is proud, dramatic "
            "and speaks slowly in short, mysterious sentences, but she is not truly evil: she cursed the isles "
            "because nobody has visited her for a hundred years and the bright lighthouse made her feel even more "
            "alone. Kindness, honesty and patience soften her; threats only make her colder. She never uses "
            "violence and never says anything frightening for children."
        ),
    },
}


@app.get("/health")
def health():
    try:
        ai_provider = _active_ai_provider()
    except RuntimeError:



        ai_provider = "unconfigured"
    return {
        "status": "ok", "service": "ai", "ai_provider": ai_provider,
        "npc_dialogue": "nvidia-nemotron@nebius" if _env("NEBIUS_API_KEY") else ai_provider,
    }


def _active_ai_provider() -> str:

    if _env("GEMINI_API_KEY"):
        return "gemini"
    if _env("GROQ_API_KEY"):
        return "groq"
    raise RuntimeError(
        "No AI provider is configured. Set GEMINI_API_KEY or GROQ_API_KEY in .env."
    )


def _env(key: str, default: str = "") -> str:

    return os.getenv(key, "").strip() or default


class _Fallback:
    """Call the primary provider; if a call fails (e.g. Gemini 503 "high demand"), retry it on the secondary.

    Used only when both GEMINI_API_KEY and GROQ_API_KEY are set, so a busy provider
    no longer turns into an error for the player.
    """

    def __init__(self, primary, secondary, label: str):
        self._primary = primary
        self._secondary = secondary
        self._label = label

    def __getattr__(self, name: str):
        primary = getattr(self._primary, name)
        if not callable(primary):
            return primary
        secondary = getattr(self._secondary, name)

        def call(*args, **kwargs):
            try:
                return primary(*args, **kwargs)
            except Exception as error:  # noqa: BLE001 - any provider failure falls back
                logger.warning("%s failed on the primary provider (%s); retrying on Groq", self._label, error)
                return secondary(*args, **kwargs)

        return call


def _maybe_fallback(primary, make_secondary, label: str):
    if _active_ai_provider() == "gemini" and _env("GROQ_API_KEY"):
        return _Fallback(primary, make_secondary(), label)
    return primary


@lru_cache
def get_correct_extraction_provider() -> ExtractionProvider:
    if _active_ai_provider() == "gemini":
        return _maybe_fallback(
            GeminiCorrectExtractionProvider(
                api_key=_env("GEMINI_API_KEY"),
                model=_env("GEMINI_MODEL", "gemini-3.5-flash-lite"),
            ),
            lambda: GroqCorrectExtractionProvider(
                api_key=_env("GROQ_API_KEY"), model=_env("GROQ_MODEL", "openai/gpt-oss-120b"),
            ),
            "Correct-utterance extraction",
        )
    return GroqCorrectExtractionProvider(
        api_key=_env("GROQ_API_KEY"),
        model=_env("GROQ_MODEL", "openai/gpt-oss-120b"),
    )


@lru_cache
def get_incorrect_extraction_provider() -> ExtractionProvider:
    if _active_ai_provider() == "gemini":
        return _maybe_fallback(
            GeminiIncorrectExtractionProvider(
                api_key=_env("GEMINI_API_KEY"),
                model=_env("GEMINI_MODEL", "gemini-3.5-flash-lite"),
            ),
            lambda: GroqIncorrectExtractionProvider(
                api_key=_env("GROQ_API_KEY"), model=_env("GROQ_MODEL", "openai/gpt-oss-120b"),
            ),
            "Incorrect-utterance extraction",
        )
    return GroqIncorrectExtractionProvider(
        api_key=_env("GROQ_API_KEY"),
        model=_env("GROQ_MODEL", "openai/gpt-oss-120b"),
    )


@lru_cache
def get_language_evaluator() -> LanguageEvaluator:







    estimator: PlausibilityEstimator
    if _active_ai_provider() == "gemini":
        from modules.groq_client import DEFAULT_GROQ_FAST_MODEL

        estimator = _maybe_fallback(
            GeminiPlausibilityEstimator(
                api_key=_env("GEMINI_API_KEY"),
                model=_env("GEMINI_EVALUATOR_MODEL", _env("GEMINI_MODEL", "gemini-3.5-flash-lite")),
            ),
            lambda: GroqPlausibilityEstimator(
                api_key=_env("GROQ_API_KEY"), model=_env("GROQ_EVALUATOR_MODEL", DEFAULT_GROQ_FAST_MODEL),
            ),
            "Language evaluation",
        )
    else:
        from modules.groq_client import DEFAULT_GROQ_FAST_MODEL

        estimator = GroqPlausibilityEstimator(
            api_key=_env("GROQ_API_KEY"),
            model=_env("GROQ_EVALUATOR_MODEL", DEFAULT_GROQ_FAST_MODEL),
        )
    return LanguageEvaluator(
        estimator=estimator,
        threshold=float(_env("LANGUAGE_ACCEPTANCE_THRESHOLD", "50")),
    )


@lru_cache
def get_correction_module() -> CorrectionModule:
    provider: CorrectionProvider
    if _active_ai_provider() == "gemini":
        from modules.groq_client import DEFAULT_GROQ_FAST_MODEL

        provider = _maybe_fallback(
            GeminiCorrectionProvider(
                api_key=_env("GEMINI_API_KEY"),
                model=_env("CORRECTION_MODEL", _env("GEMINI_MODEL", "gemini-3.5-flash-lite")),
            ),
            lambda: GroqCorrectionProvider(
                api_key=_env("GROQ_API_KEY"), model=_env("GROQ_CORRECTION_MODEL", DEFAULT_GROQ_FAST_MODEL),
            ),
            "Correction",
        )
    else:
        from modules.groq_client import DEFAULT_GROQ_FAST_MODEL

        provider = GroqCorrectionProvider(
            api_key=_env("GROQ_API_KEY"),
            model=_env("GROQ_CORRECTION_MODEL", DEFAULT_GROQ_FAST_MODEL),
        )
    return CorrectionModule(provider)


@lru_cache
def get_npc_generator() -> TextGenerator:
    fallback = _base_npc_generator()
    if _env("NEBIUS_API_KEY"):
        # NPC dialogue runs on NVIDIA Nemotron via Nebius Token Factory; Gemini/Groq stay as fallbacks.
        from modules.nebius_client import NebiusTextGenerator

        return _Fallback(
            NebiusTextGenerator(api_key=_env("NEBIUS_API_KEY"), model=_env("NEBIUS_MODEL") or None),
            fallback,
            "NPC reply (Nemotron)",
        )
    return fallback


def _base_npc_generator() -> TextGenerator:
    if _active_ai_provider() == "gemini":
        return _maybe_fallback(
            GeminiTextGenerator(
                api_key=_env("GEMINI_API_KEY"),
                model=_env("GEMINI_MODEL", "gemini-3.5-flash-lite"),
            ),
            lambda: GroqTextGenerator(api_key=_env("GROQ_API_KEY"), model=_env("GROQ_MODEL", "openai/gpt-oss-120b")),
            "NPC reply",
        )
    return GroqTextGenerator(
        api_key=_env("GROQ_API_KEY"),
        model=_env("GROQ_MODEL", "openai/gpt-oss-120b"),
    )


@lru_cache
def get_stt_provider() -> SpeechToTextProvider:
    gemini_stt_key = _env("GEMINI_STT_API_KEY") or _env("GEMINI_API_KEY")
    if gemini_stt_key:
        return GeminiSpeechToTextProvider(
            api_key=gemini_stt_key,
            model=_env("STT_MODEL", "gemini-3.5-transcribe"),
        )
    return GroqSpeechToTextProvider(
        api_key=_env("GROQ_API_KEY"),
        model=_env("GROQ_STT_MODEL", "whisper-large-v3-turbo"),
    )


@lru_cache
def get_tts_provider() -> TextToSpeechProvider:
    return GroqTextToSpeechProvider(
        api_key=_env("GROQ_API_KEY"),
        model=_env("GROQ_TTS_MODEL", "canopylabs/orpheus-v1-english"),
    )


@app.post("/extract/correct", response_model=CorrectExtractionResult)
def extract_correct_language_features(payload: ExtractionRequest):
    return CorrectExtractor(get_correct_extraction_provider()).extract(payload)


@app.post("/extract/incorrect", response_model=IncorrectExtractionResult)
def extract_incorrect_language_features(payload: ExtractionRequest):
    return IncorrectExtractor(get_incorrect_extraction_provider()).extract(payload)


@app.post("/correct", response_model=CorrectionResult)
def correct_language(payload: CorrectionInput):
    return get_correction_module().correct(payload)


@app.post("/evaluate-and-respond", response_model=EvaluateResponse)
def evaluate_and_respond(payload: EvaluateRequest):
    history = list(payload.dialogue_history)
    if history and history[-1].speaker == "user" and history[-1].text == payload.user_text:
        history = history[:-1]

    goals = [
        f"Learn or confirm the value of: {field}"
        for field, value in payload.scenario_state.items()
        if value is None
    ]
    evaluation = get_language_evaluator().evaluate(
        LanguageEvaluationInput(
            utterance=payload.user_text,
            context=f"{payload.location} role-play",
            speaker="player",
            listener=payload.npc_role,
            communicative_goals=goals,
            scenario_state=payload.scenario_state,
            dialogue_history=history,
        )
    )

    if not evaluation.accepted:
        correction = get_correction_module().correct(
            CorrectionInput(
                utterance=payload.user_text,
                dialogue_history=history,
            )
        )
        return EvaluateResponse(
            accepted=False,
            correction=correction.corrected_utterance,
            npc_response=correction.coach_response,
            response_speaker="coach",
            updated_scenario_state=payload.scenario_state,
            probability_percent=evaluation.probability_percent,
            evaluation_reason=evaluation.brief_reason,
        )

    profile = NPC_PROFILES.get(
        (payload.location, payload.npc_role),
        {
            "name": payload.npc_role.replace("_", " ").title(),
            "personality": "Friendly, patient, and concise",
        },
    )
    identity = NPCIdentity(
        id=f"{payload.location}_{payload.npc_role}",
        name=profile["name"],
        role=payload.npc_role,
        user_role="player",
        location=payload.location,
        personality=profile["personality"],
        tasks=[
            NPCTask(id=f"task_{index}", description=goal)
            for index, goal in enumerate(goals, start=1)
        ],
        scenario_state=payload.scenario_state,
        focus_words=payload.focus_words[:2],
        memories=payload.npc_memories[:10],
        relationship_tier=payload.relationship_tier,
        world_time=payload.world_time,
        plan_notes=payload.plan_notes[:6],
        cefr_level=payload.cefr_level,
        scene_note=payload.scene_note,
    )
    npc = NpcModule(identity=identity, generator=get_npc_generator())
    npc.dialogue_history = history
    npc_reply = npc.respond(payload.user_text)
    return EvaluateResponse(
        accepted=True,
        correction=None,
        npc_response=npc_reply,
        response_speaker="npc",
        updated_scenario_state=payload.scenario_state,
        probability_percent=evaluation.probability_percent,
        evaluation_reason=evaluation.brief_reason,
    )


@app.post("/stt", response_model=STTResponse)
async def speech_to_text(
    audio: UploadFile,
    language_code: str | None = "en-US",
    custom_vocabulary: str | None = None,
):
    request_id = uuid.uuid4().hex[:12]
    started = time.perf_counter()
    audio_bytes = await audio.read()
    content_type = audio.content_type or "application/octet-stream"
    max_bytes = int(os.getenv("STT_MAX_AUDIO_BYTES", str(10 * 1024 * 1024)))
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    if len(audio_bytes) > max_bytes:
        raise HTTPException(status_code=413, detail="Audio file is too large")

    vocabulary = (
        [term.strip() for term in custom_vocabulary.split(",") if term.strip()]
        if custom_vocabulary
        else []
    )
    try:
        provider = get_stt_provider()
        provider_name = type(provider).__name__
        model_name = getattr(provider, "_model", "unknown")
        logger.info(
            "STT request started request_id=%s provider=%s model=%s "
            "content_type=%s audio_bytes=%d language_code=%s",
            request_id,
            provider_name,
            model_name,
            content_type,
            len(audio_bytes),
            language_code,
        )
        result = await run_in_threadpool(
            provider.transcribe,
            audio_bytes,
            mime_type=content_type,
            language_codes=[language_code] if language_code else [],
            custom_vocabulary=vocabulary,
        )
    except ValueError as exc:
        logger.warning(
            "STT request rejected request_id=%s content_type=%s audio_bytes=%d "
            "language_code=%s error_type=%s error=%s",
            request_id,
            content_type,
            len(audio_bytes),
            language_code,
            type(exc).__name__,
            exc,
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except SpeechRateLimitError as exc:
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        retry_after = max(1, math.ceil(exc.retry_after_seconds or 10))
        logger.exception(
            "STT request rate limited request_id=%s provider=%s model=%s "
            "content_type=%s audio_bytes=%d language_code=%s elapsed_ms=%d "
            "retry_after_seconds=%d",
            request_id,
            locals().get("provider_name", "unavailable"),
            locals().get("model_name", "unavailable"),
            content_type,
            len(audio_bytes),
            language_code,
            elapsed_ms,
            retry_after,
        )
        raise HTTPException(
            status_code=429,
            detail=(
                "Speech recognition is temporarily busy. "
                f"Please retry in {retry_after} seconds "
                f"(reference: {request_id})."
            ),
            headers={"Retry-After": str(retry_after)},
        ) from exc
    except Exception as exc:
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        logger.exception(
            "STT request failed request_id=%s provider=%s model=%s "
            "content_type=%s audio_bytes=%d language_code=%s elapsed_ms=%d "
            "error_type=%s",
            request_id,
            locals().get("provider_name", "unavailable"),
            locals().get("model_name", "unavailable"),
            content_type,
            len(audio_bytes),
            language_code,
            elapsed_ms,
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=502,
            detail=f"Speech transcription failed (reference: {request_id})",
        ) from exc

    logger.info(
        "STT request completed request_id=%s provider=%s model=%s latency_ms=%d "
        "elapsed_ms=%d",
        request_id,
        provider_name,
        result.model,
        result.latency_ms,
        round((time.perf_counter() - started) * 1000),
    )

    return STTResponse(
        text=result.text,
        language_code=result.language_code,
        mode="verbatim",
        model=result.model,
        latency_ms=result.latency_ms,
    )


@app.post(
    "/tts",
    response_class=Response,
    responses={200: {"content": {"audio/wav": {}}}},
)
def text_to_speech(payload: TTSRequest):
    try:
        result = get_tts_provider().synthesize(
            payload.text,
            voice=payload.voice,
            style=payload.style,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.HTTPStatusError as exc:
        try:
            provider_body = exc.response.json()
            provider_error = provider_body.get("error", {}) if isinstance(provider_body, dict) else {}
            code = provider_error.get("code") if isinstance(provider_error, dict) else None
        except ValueError:
            code = None
        if code == "model_terms_required":
            detail = "The Groq Orpheus model terms have not been accepted. Open the model in Groq Console and accept the terms."
            status = 424
        else:
            detail = f"Groq TTS request was rejected (HTTP {exc.response.status_code}{f', code: {code}' if code else ''})."
            status = 502
        logger.warning("TTS provider rejected request: status=%s code=%s", exc.response.status_code, code)
        raise HTTPException(status_code=status, detail=detail) from exc
    except Exception as exc:
        logger.exception("Speech synthesis failed")
        raise HTTPException(status_code=502, detail="Speech synthesis failed") from exc

    return Response(
        content=result.audio,
        media_type=result.mime_type,
        headers={
            "Content-Disposition": 'inline; filename="speech.wav"',
            "X-Speech-Model": result.model,
            "X-Speech-Voice": result.voice,
            "X-Speech-Latency-Ms": str(result.latency_ms),
        },
    )
