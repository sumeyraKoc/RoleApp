import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

API_ROOT = Path(__file__).resolve().parents[1]
if str(API_ROOT) not in sys.path:
    sys.path.insert(0, str(API_ROOT))

from services import ai_client
from shared.schemas import EvaluateRequest


class ColdStartRetryTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.payload = EvaluateRequest(location="bakery", npc_role="baker", user_text="hi")

    async def test_retries_gateway_error_then_returns_npc_reply(self):
        calls = 0

        def respond(request):
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(502, request=request)
            return httpx.Response(200, request=request, json={
                "accepted": True,
                "npc_response": "Hello!",
                "response_speaker": "npc",
            })

        client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        with patch.object(ai_client, "USE_MOCK_AI", False), patch.object(
            ai_client.httpx, "AsyncClient", return_value=client
        ), patch.object(ai_client.asyncio, "sleep", new_callable=AsyncMock) as sleep:
            result = await ai_client.evaluate_and_respond(self.payload)

        self.assertEqual(calls, 2)
        self.assertEqual(result.npc_response, "Hello!")
        sleep.assert_awaited_once_with(2.0)

    async def test_does_not_retry_application_error(self):
        calls = 0

        def respond(request):
            nonlocal calls
            calls += 1
            return httpx.Response(400, request=request)

        client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        with patch.object(ai_client, "USE_MOCK_AI", False), patch.object(
            ai_client.httpx, "AsyncClient", return_value=client
        ), patch.object(ai_client.asyncio, "sleep", new_callable=AsyncMock) as sleep:
            with self.assertRaises(httpx.HTTPStatusError):
                await ai_client.evaluate_and_respond(self.payload)

        self.assertEqual(calls, 1)
        sleep.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
