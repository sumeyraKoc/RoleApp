import asyncio
import logging
import os
import time
from typing import Literal

import httpx

from shared.schemas import (
    PlanDecisionRequest,
    PlanDecisionResponse,
    SentenceCheckRequest,
    SentenceCheckResponse,
    InventoryDecisionRequest,
    InventoryDecisionResponse,
    CorrectExtractionResult,
    EvaluateRequest,
    EvaluateResponse,
    ExtractionRequest,
    ExtractionResult,
    IncorrectExtractionResult,
    STTResponse,
    TTSRequest,
)

AI_SERVICE_URL = os.getenv("AI_SERVICE_URL", "http://ai:8001")
USE_MOCK_AI = os.getenv("USE_MOCK_AI", "true").lower() == "true"
AI_EVALUATION_TIMEOUT_SECONDS = float(
    os.getenv("AI_EVALUATION_TIMEOUT_SECONDS", "120")
)
AI_EXTRACTION_TIMEOUT_SECONDS = float(
    os.getenv("AI_EXTRACTION_TIMEOUT_SECONDS", "120")
)
AI_SPEECH_TIMEOUT_SECONDS = float(os.getenv("AI_SPEECH_TIMEOUT_SECONDS", "45"))
logger = logging.getLogger(__name__)





MOCK_RESPONSES: dict[str, EvaluateResponse] = {
    "bakery": EvaluateResponse(
        accepted=False,
        correction="Could I get a croissant, please?",
        npc_response="Sure... do you mean 'Could I get a croissant, please?'",
        response_speaker="coach",
        updated_scenario_state={},
    ),
    "library": EvaluateResponse(
        accepted=False,
        correction="Could you help me find a mystery novel, please?",
        npc_response=(
            "Of course. Try saying, "
            "'Could you help me find a mystery novel, please?'"
        ),
        response_speaker="coach",
        updated_scenario_state={},
    ),
    "cafe": EvaluateResponse(
        accepted=False,
        correction="Could I have a medium latte with oat milk, please?",
        npc_response=(
            "Sure thing. You could say, "
            "'Could I have a medium latte with oat milk, please?'"
        ),
        response_speaker="coach",
        updated_scenario_state={},
    ),
}


async def evaluate_and_respond(payload: EvaluateRequest) -> EvaluateResponse:
    if USE_MOCK_AI:
        template = MOCK_RESPONSES.get(payload.location)
        if template is None:



            return EvaluateResponse(
                accepted=False,
                correction=None,
                npc_response=(
                    f"[mock] No response is defined for '{payload.location}' yet. "
                    "Add one to MOCK_RESPONSES in api/services/ai_client.py."
                ),
                response_speaker="coach",
                updated_scenario_state=payload.scenario_state,
            )
        return template.model_copy(update={"updated_scenario_state": payload.scenario_state})

    # Render's free AI instance can be asleep when the API receives the first
    # turn. Its gateway may answer 502 before the AI process has started.
    deadline = time.monotonic() + AI_EVALUATION_TIMEOUT_SECONDS
    retry_delay = 2.0
    async with httpx.AsyncClient() as client:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise httpx.ReadTimeout("AI service did not become available in time")
            try:
                response = await client.post(
                    f"{AI_SERVICE_URL}/evaluate-and-respond",
                    json=payload.model_dump(),
                    timeout=remaining,
                )
                response.raise_for_status()
                return EvaluateResponse(**response.json())
            except httpx.HTTPStatusError as error:
                if error.response.status_code not in (502, 503, 504):
                    raise
                last_error = error
            except (httpx.ConnectError, httpx.ConnectTimeout) as error:
                last_error = error

            remaining = deadline - time.monotonic()
            if remaining <= retry_delay:
                raise last_error
            logger.warning("AI service unavailable (%s); retrying in %.0fs", last_error, retry_delay)
            await asyncio.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, 8.0)


async def check_sentence(payload: SentenceCheckRequest) -> SentenceCheckResponse:
    if USE_MOCK_AI:
        return SentenceCheckResponse(accepted=True, reason="mock")
    async with httpx.AsyncClient(timeout=AI_EVALUATION_TIMEOUT_SECONDS) as client:
        response = await client.post(f"{AI_SERVICE_URL}/sentence/check", json=payload.model_dump())
        response.raise_for_status()
        return SentenceCheckResponse.model_validate(response.json())


async def decide_plan(payload: PlanDecisionRequest) -> PlanDecisionResponse:
    if USE_MOCK_AI:
        return PlanDecisionResponse()
    async with httpx.AsyncClient(timeout=AI_EVALUATION_TIMEOUT_SECONDS) as client:
        response = await client.post(f"{AI_SERVICE_URL}/plan/decide", json=payload.model_dump())
        response.raise_for_status()
        return PlanDecisionResponse.model_validate(response.json())


async def decide_inventory_transfers(payload: InventoryDecisionRequest) -> InventoryDecisionResponse:
    if USE_MOCK_AI:
        return InventoryDecisionResponse()
    async with httpx.AsyncClient(timeout=AI_EVALUATION_TIMEOUT_SECONDS) as client:
        response = await client.post(f"{AI_SERVICE_URL}/inventory/decide", json=payload.model_dump())
        response.raise_for_status()
        return InventoryDecisionResponse.model_validate(response.json())


async def extract_utterance(
    payload: ExtractionRequest,
    outcome: Literal["correct", "incorrect"],
) -> ExtractionResult | None:

    if USE_MOCK_AI:
        return None

    async with httpx.AsyncClient(timeout=AI_EXTRACTION_TIMEOUT_SECONDS) as client:
        response = await client.post(
            f"{AI_SERVICE_URL}/extract/{outcome}",
            json=payload.model_dump(),
        )
        response.raise_for_status()
        result_type = (
            CorrectExtractionResult
            if outcome == "correct"
            else IncorrectExtractionResult
        )
        return result_type(**response.json())


async def transcribe_audio(
    audio_bytes: bytes,
    content_type: str,
    language_code: str | None = None,
) -> STTResponse:

    async with httpx.AsyncClient(timeout=AI_SPEECH_TIMEOUT_SECONDS) as client:
        files = {"audio": ("recording", audio_bytes, content_type)}
        params: dict[str, str] = {}
        if language_code:
            params["language_code"] = language_code
        response = await client.post(f"{AI_SERVICE_URL}/stt", files=files, params=params)
        response.raise_for_status()
        return STTResponse(**response.json())


async def synthesize_speech(payload: TTSRequest) -> tuple[bytes, dict[str, str]]:

    async with httpx.AsyncClient(timeout=AI_SPEECH_TIMEOUT_SECONDS) as client:
        response = await client.post(f"{AI_SERVICE_URL}/tts", json=payload.model_dump())
        response.raise_for_status()
        speech_headers = {
            key: value
            for key, value in response.headers.items()
            if key.lower().startswith("x-speech-")
        }
        return response.content, speech_headers
