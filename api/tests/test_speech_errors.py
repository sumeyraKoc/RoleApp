import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import HTTPException

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from routes import speech  # noqa: E402
from shared.schemas import TTSRequest  # noqa: E402


class SpeechErrorTests(unittest.TestCase):
    def test_tts_preserves_actionable_ai_error(self):
        request = httpx.Request("POST", "http://ai:8001/tts")
        response = httpx.Response(424, request=request, json={"detail": "The Groq Orpheus model terms have not been accepted."})
        upstream_error = httpx.HTTPStatusError("AI rejected speech", request=request, response=response)
        with patch.object(speech, "synthesize_speech", side_effect=upstream_error):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(speech.text_to_speech(TTSRequest(text="Hello"), _user=None))

        self.assertEqual(raised.exception.status_code, 424)
        self.assertIn("Groq Orpheus", raised.exception.detail)
