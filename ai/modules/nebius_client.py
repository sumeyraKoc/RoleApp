"""NVIDIA Nemotron on Nebius Token Factory (Nebius x NVIDIA hackathon).

Token Factory exposes an OpenAI-compatible API, so this mirrors groq_client.py:
a thin httpx wrapper, no extra SDK. NPC dialogue runs on a Nemotron model when
NEBIUS_API_KEY is set; Gemini/Groq stay behind it as fallbacks.

The model id comes from NEBIUS_MODEL, or is looked up once from the account's
model catalog (GET /models), preferring a Nemotron "super" model, then "nano".
"""

from __future__ import annotations

import os
import re
from functools import lru_cache

import httpx

from shared.schemas import DialogueTurn, NPCIdentity

NEBIUS_API_BASE = os.getenv("NEBIUS_API_BASE", "").strip() or "https://api.tokenfactory.nebius.com/v1"
_THINK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def build_nebius_client(api_key: str, *, timeout: float = 60.0) -> httpx.Client:
    if not api_key:
        raise ValueError("NEBIUS_API_KEY is not defined")
    return httpx.Client(base_url=NEBIUS_API_BASE, headers={"Authorization": f"Bearer {api_key}"}, timeout=timeout)


def pick_nemotron(model_ids: list[str]) -> str:
    """Choose a Nemotron model from the catalog: super > nano > any Nemotron."""
    nemotron = [m for m in model_ids if "nemotron" in m.lower()]
    if not nemotron:
        raise RuntimeError("No NVIDIA Nemotron model is available on this Nebius account; set NEBIUS_MODEL.")
    for tier in ("super", "nano"):
        for model in nemotron:
            if tier in model.lower() and "embed" not in model.lower() and "reward" not in model.lower():
                return model
    return nemotron[0]


@lru_cache(maxsize=1)
def resolve_model(api_key: str) -> str:
    configured = os.getenv("NEBIUS_MODEL", "").strip()
    if configured:
        return configured
    with build_nebius_client(api_key, timeout=20.0) as client:
        response = client.get("/models")
        response.raise_for_status()
        ids = [item["id"] for item in response.json().get("data", []) if "id" in item]
    return pick_nemotron(ids)


def clean_reply(text: str) -> str:
    """Nemotron reasoning models may wrap their thoughts in <think> tags; players only see the answer."""
    return _THINK.sub("", text or "").strip()


class NebiusTextGenerator:
    """NPC dialogue on NVIDIA Nemotron via Nebius Token Factory (same prompt as the other adapters)."""

    def __init__(self, api_key: str, model: str | None = None):
        self._api_key = api_key
        self._model = model
        self._client = build_nebius_client(api_key)

    @property
    def model(self) -> str:
        if not self._model:
            self._model = resolve_model(self._api_key)
        return self._model

    def generate(self, identity: NPCIdentity, dialogue_history: list[DialogueTurn]) -> str:
        from .npc import _npc_system_instruction

        messages = [{"role": "system", "content": _npc_system_instruction(identity)}]
        for turn in dialogue_history:
            messages.append({"role": "user" if turn.speaker == "user" else "assistant", "content": turn.text})
        response = self._client.post(
            "/chat/completions",
            json={"model": self.model, "temperature": 0.7, "max_tokens": 400, "messages": messages},
        )
        response.raise_for_status()
        reply = clean_reply(response.json()["choices"][0]["message"].get("content") or "")
        if not reply:
            raise RuntimeError("Nemotron returned an empty response")
        return reply
