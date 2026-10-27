import base64
import io
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import Mock

from modules.speech import (
    GeminiSpeechToTextProvider,
    GeminiTextToSpeechProvider,
    GroqTextToSpeechProvider,
    SpeechRateLimitError,
)


class FakeInteractions:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


class FakeClient:
    def __init__(self, response):
        self.interactions = FakeInteractions(response)


class RateLimitError(Exception):
    status_code = 429


class SequencedInteractions:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class GeminiSpeechToTextProviderTests(unittest.TestCase):
    def test_uses_inline_audio_and_verbatim_mode(self):
        client = FakeClient(SimpleNamespace(output_text=" He go yesterday. "))
        provider = GeminiSpeechToTextProvider("", client=client)

        result = provider.transcribe(
            b"fake-wav",
            mime_type="audio/x-wav",
            language_codes=["en-US"],
            custom_vocabulary=["espresso"],
        )

        call = client.interactions.calls[0]
        self.assertEqual(result.text, "He go yesterday.")
        self.assertEqual(result.mode, "verbatim")
        self.assertEqual(call["input"][0]["mime_type"], "audio/wav")
        self.assertEqual(base64.b64decode(call["input"][0]["data"]), b"fake-wav")
        config = call["generation_config"]["transcription_config"]
        self.assertEqual(config["mode"], {"type": "verbatim"})
        self.assertEqual(config["language_codes"], ["en-US"])
        self.assertEqual(config["custom_vocabulary"], ["espresso"])

    def test_rejects_empty_audio(self):
        client = FakeClient(SimpleNamespace(output_text="unused"))
        provider = GeminiSpeechToTextProvider("", client=client)
        with self.assertRaises(ValueError):
            provider.transcribe(b"", mime_type="audio/wav")

    def test_retries_once_after_gemini_suggested_rate_limit_delay(self):
        interactions = SequencedInteractions(
            [
                RateLimitError("Please retry in 8.237s."),
                SimpleNamespace(output_text="hello"),
            ]
        )
        waits = []
        provider = GeminiSpeechToTextProvider(
            "",
            client=SimpleNamespace(interactions=interactions),
            sleep=waits.append,
        )

        result = provider.transcribe(b"audio", mime_type="audio/webm")

        self.assertEqual(result.text, "hello")
        self.assertEqual(len(interactions.calls), 2)
        self.assertEqual(waits, [9.0])

    def test_surfaces_rate_limit_after_retry_is_exhausted(self):
        interactions = SequencedInteractions(
            [
                RateLimitError("Please retry in 2s."),
                RateLimitError("Please retry in 7.4s."),
            ]
        )
        provider = GeminiSpeechToTextProvider(
            "",
            client=SimpleNamespace(interactions=interactions),
            sleep=lambda _seconds: None,
        )

        with self.assertRaises(SpeechRateLimitError) as raised:
            provider.transcribe(b"audio", mime_type="audio/webm")

        self.assertEqual(raised.exception.retry_after_seconds, 7.4)


class GeminiTextToSpeechProviderTests(unittest.TestCase):
    def test_wraps_pcm_response_as_wav(self):
        pcm = b"\x00\x00\x01\x00"
        response = SimpleNamespace(
            output_audio=SimpleNamespace(data=base64.b64encode(pcm).decode("ascii"))
        )
        client = FakeClient(response)
        provider = GeminiTextToSpeechProvider("", client=client)

        result = provider.synthesize(
            "Hello!", voice="Kore", style="Speak warmly."
        )

        self.assertEqual(result.mime_type, "audio/wav")
        self.assertEqual(result.audio[:4], b"RIFF")
        self.assertEqual(result.audio[8:12], b"WAVE")
        call = client.interactions.calls[0]
        self.assertEqual(call["response_format"], {"type": "audio"})
        self.assertEqual(
            call["generation_config"]["speech_config"], [{"voice": "Kore"}]
        )


class GroqTextToSpeechProviderTests(unittest.TestCase):
    def test_coach_vocal_direction_is_sent_to_groq(self):
        response = SimpleNamespace(content=b"RIFFaudio", raise_for_status=lambda: None)
        client = Mock()
        client.post.return_value = response
        provider = GroqTextToSpeechProvider("", client=client)

        provider.synthesize("Take your time.", voice="daniel", style="[gravelly] [authoritatively]")

        self.assertEqual(client.post.call_args.kwargs["json"]["voice"], "daniel")
        self.assertEqual(
            client.post.call_args.kwargs["json"]["input"],
            "[gravelly] [authoritatively] Take your time.",
        )

    def test_direction_does_not_push_text_over_orpheus_limit(self):
        response = SimpleNamespace(content=b"RIFFaudio", raise_for_status=lambda: None)
        client = Mock()
        client.post.return_value = response
        provider = GroqTextToSpeechProvider("", client=client)
        long_text = "A" * 190

        provider.synthesize(long_text, voice="daniel", style="[gravelly] [authoritatively]")

        self.assertEqual(client.post.call_args.kwargs["json"]["input"], long_text)

    def test_streaming_wav_has_usable_duration(self):
        pcm = b"\x00\x00" * 24000
        streaming_wav = (
            b"RIFF\xff\xff\xff\xffWAVEfmt "
            + (16).to_bytes(4, "little")
            + b"\x01\x00\x01\x00"
            + (24000).to_bytes(4, "little")
            + (48000).to_bytes(4, "little")
            + b"\x02\x00\x10\x00data\xff\xff\xff\xff"
            + pcm
        )
        response = SimpleNamespace(content=streaming_wav, raise_for_status=lambda: None)
        client = Mock()
        client.post.return_value = response
        provider = GroqTextToSpeechProvider("", client=client)

        result = provider.synthesize("Hello", voice="daniel")

        with wave.open(io.BytesIO(result.audio), "rb") as reader:
            self.assertEqual(reader.getnframes(), 24000)
            self.assertEqual(reader.getframerate(), 24000)

    def test_legacy_character_voices_remain_distinct(self):
        response = SimpleNamespace(content=b"RIFFaudio", raise_for_status=lambda: None)
        client = Mock()
        client.post.return_value = response
        provider = GroqTextToSpeechProvider("", client=client)

        for old_voice, expected in (("Kore", "diana"), ("Leda", "hannah"), ("Puck", "austin"), ("Gacrux", "daniel")):
            with self.subTest(old_voice=old_voice):
                result = provider.synthesize("Hello", voice=old_voice)
                self.assertEqual(result.voice, expected)
                self.assertEqual(client.post.call_args.kwargs["json"]["voice"], expected)


if __name__ == "__main__":
    unittest.main()
