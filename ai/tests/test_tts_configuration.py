import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient



AI_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AI_DIR))
import main as ai_main  # noqa: E402


class SpeechConfigurationTests(unittest.TestCase):
    def tearDown(self):
        ai_main.get_stt_provider.cache_clear()
        ai_main.get_tts_provider.cache_clear()

    @patch.object(ai_main, "GeminiSpeechToTextProvider")
    def test_dedicated_gemini_stt_key_takes_priority(self, provider):
        with patch.dict(
            os.environ,
            {
                "GEMINI_STT_API_KEY": "paid-stt-key",
                "GEMINI_API_KEY": "shared-free-key",
                "STT_MODEL": "stt-model",
            },
        ):
            ai_main.get_stt_provider.cache_clear()
            ai_main.get_stt_provider()

        provider.assert_called_once_with(api_key="paid-stt-key", model="stt-model")

    @patch.object(ai_main, "GeminiSpeechToTextProvider")
    def test_stt_falls_back_to_shared_gemini_key(self, provider):
        with patch.dict(
            os.environ,
            {
                "GEMINI_STT_API_KEY": "",
                "GEMINI_API_KEY": "shared-free-key",
                "STT_MODEL": "stt-model",
            },
        ):
            ai_main.get_stt_provider.cache_clear()
            ai_main.get_stt_provider()

        provider.assert_called_once_with(api_key="shared-free-key", model="stt-model")

    @patch.object(ai_main, "GroqTextToSpeechProvider")
    def test_tts_uses_groq_even_when_gemini_is_configured(self, provider):
        with patch.dict(
            os.environ,
            {
                "GEMINI_API_KEY": "evaluation-key",
                "GEMINI_TTS_API_KEY": "stale-key-must-be-ignored",
                "GROQ_API_KEY": "groq-speech-key",
                "GROQ_TTS_MODEL": "groq-tts-model",
            },
        ):
            ai_main.get_tts_provider.cache_clear()
            ai_main.get_tts_provider()

        provider.assert_called_once_with(
            api_key="groq-speech-key",
            model="groq-tts-model",
        )

    def test_tts_exposes_required_model_terms(self):
        request = httpx.Request("POST", "https://api.groq.com/openai/v1/audio/speech")
        response = httpx.Response(400, request=request, json={"error": {"code": "model_terms_required"}})
        provider_error = httpx.HTTPStatusError("Groq rejected speech", request=request, response=response)
        with patch.object(ai_main, "get_tts_provider") as get_provider:
            get_provider.return_value.synthesize.side_effect = provider_error
            with TestClient(ai_main.app) as client:
                result = client.post("/tts", json={"text": "Hello"})

        self.assertEqual(result.status_code, 424)
        self.assertIn("model terms", result.json()["detail"])


if __name__ == "__main__":
    unittest.main()
