import http from "node:http";
import { readFileSync } from "node:fs";

const headers = {
  "Access-Control-Allow-Origin": "http://localhost:5173",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

function reply(response, status, payload) {
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

function replyAudio(response, buffer) {
  response.writeHead(200, {
    ...headers,
    "Content-Type": "audio/wav",
    "X-Speech-Model": "mock",
    "X-Speech-Voice": "mock",
    "X-Speech-Latency-Ms": "0",
  });
  response.end(buffer);
}

function buildSilentWav(durationSeconds = 0.4, sampleRate = 24000) {
  const sampleCount = Math.round(durationSeconds * sampleRate);
  const dataSize = sampleCount * 2; // 16-bit mono PCM
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

const MOCK_TRANSCRIPT =
  "Hello, I would like to practice my English here, please.";

const earnedWords = new Map(); // key: `${location}:${concept}` -> Set<word lowercased>

function keyFor(location, concept) {
  return `${location}:${concept}`;
}

// Uses the real word lists so the town's vocabulary props behave like the API.
function loadVocabulary(location) {
  if (!/^[a-z_]+$/.test(String(location))) return { concepts: [] };
  try {
    const url = new URL(`../../api/game_data/vocabulary/${location}.json`, import.meta.url);
    return JSON.parse(readFileSync(url, "utf-8"));
  } catch {
    return { concepts: [] };
  }
}

// Dub scenes generated from api/routes/dub.py (see mock-dub-scripts.json).
const DUB_SCRIPTS = JSON.parse(readFileSync(new URL("./mock-dub-scripts.json", import.meta.url), "utf-8"));

const sessions = []; // index = session id - 1 -> location
const PLACE_NAMES = { bakery: "bakery", library: "library", cafe: "café" };

// Spell Book: raw word events + the same scoring as api/services/spell_book.py.
const wordEvents = []; // { lemma, type, location, at }
const WEIGHTS = { meaning_fail: 25, pronunciation_fail: 20, usage_fail: 15, passive_encounter: -3, context_success: -10, active_success: -15 };

function spellBook() {
  const now = Date.now();
  const byLemma = new Map();
  for (const e of wordEvents) byLemma.set(e.lemma, [...(byLemma.get(e.lemma) ?? []), e]);
  const order = { red: 0, yellow: 1, new: 2, green: 3 };
  return [...byLemma.entries()].map(([lemma, events]) => {
    const raw = events.reduce((sum, e) => sum + WEIGHTS[e.type] * 2 ** (-(now - e.at) / 86400000 / 14), 0);
    const score = Math.round(Math.min(100, Math.max(0, raw)) * 10) / 10;
    const count = (type) => events.filter((e) => e.type === type).length;
    const successes = count("active_success") + count("context_success");
    const status = score >= 60 ? "red" : score >= 30 ? "yellow" : successes >= 2 ? "green" : "new";
    return {
      lemma, status, struggle_score: score,
      meaning_fails: count("meaning_fail"), pronunciation_fails: count("pronunciation_fail"), usage_fails: count("usage_fail"),
      active_successes: successes,
      sources: [...new Set(events.map((e) => e.location).filter(Boolean))].sort(),
      example: null,
      last_event_at: new Date(events[events.length - 1].at).toISOString(),
    };
  }).sort((a, b) => order[a.status] - order[b.status] || b.struggle_score - a.struggle_score || a.lemma.localeCompare(b.lemma));
}

function conceptProgress(location, concept) {
  const earned = earnedWords.get(keyFor(location, concept.concept)) ?? new Set();
  const words = concept.words.map((w) => ({ word: w.word, earned: earned.has(w.word.toLowerCase()) }));
  return { concept: concept.concept, words, completed: words.every((w) => w.earned) };
}

const server = http.createServer((request, response) => {
  if (request.method === "OPTIONS") {
    reply(response, 204, {});
    return;
  }

  if (request.method === "GET" && request.url === "/api/dub/scripts") {
    reply(response, 200, DUB_SCRIPTS);
    return;
  }

  const scoreMatch = request.method === "POST"
    ? /^\/api\/dub\/scripts\/([^/]+)\/lines\/(\d+)\/score$/.exec(request.url ?? "")
    : null;
  if (scoreMatch) {
    request.resume(); // ignore the uploaded audio
    const script = DUB_SCRIPTS.find((s) => s.id === scoreMatch[1]);
    const line = script?.lines.find((l) => l.id === Number(scoreMatch[2]));
    if (!line) {
      reply(response, 404, { detail: "Line not found" });
      return;
    }
    // Pretend the player got most words right; one random word is marked wrong.
    const words = line.text.split(/\s+/).filter(Boolean);
    const miss = words.length > 3 ? Math.floor(Math.random() * words.length) : -1;
    const verdicts = words.map((word, i) => ({ word, correct: i !== miss }));
    const accuracy = Math.round((verdicts.filter((w) => w.correct).length / Math.max(1, words.length)) * 100);
    reply(response, 200, { transcript: line.text, expected: line.text, words: verdicts, accuracy_percent: accuracy });
    return;
  }

  if (request.method === "GET" && /^\/api\/spellbook\/[^/]+$/.test(request.url ?? "")) {
    reply(response, 200, spellBook());
    return;
  }

  const progressMatch = request.method === "GET"
    ? /^\/api\/vocabulary\/progress\/[^/]+\/([^/]+)$/.exec(request.url ?? "")
    : null;
  if (progressMatch) {
    const location = decodeURIComponent(progressMatch[1]);
    const vocab = loadVocabulary(location);
    reply(response, 200, vocab.concepts.map((c) => conceptProgress(location, c)));
    return;
  }

  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    if (request.method === "POST" && request.url === "/api/session/start") {
      const parsed = JSON.parse(body || "{}");
      const location = String(parsed.location ?? "bakery");
      const sessionId = sessions.length + 1;
      sessions.push(location);
      reply(response, 200, { session_id: sessionId, user_id: 1, location, npc_role: parsed.npc_role ?? "baker" });
      return;
    }

    if (request.method === "POST" && /^\/api\/session\/\d+\/turn$/.test(request.url ?? "")) {
      const parsed = JSON.parse(body || "{}");
      const sessionId = Number((request.url ?? "").split("/")[3]);
      const location = sessions[sessionId - 1] ?? "bakery";
      const place = PLACE_NAMES[location] ?? "here";
      // Like the real API: weave one red/yellow Spell Book word into the reply.
      const focus = spellBook().find((e) => e.status === "red" || e.status === "yellow");
      let npcResponse = `Nice to meet you! You said: "${parsed.user_text}" What would you like from the ${place}?`;
      const used = [];
      if (focus) {
        npcResponse += ` By the way, the ${focus.lemma} is right over there.`;
        used.push(focus.lemma);
        wordEvents.push({ lemma: focus.lemma, type: "passive_encounter", location, at: Date.now() });
      }
      reply(response, 200, {
        used_focus_words: used,
        accepted: true,
        correction: null,
        npc_response: npcResponse,
        response_speaker: "npc",
        updated_scenario_state: { item: null, quantity: null },
        probability_percent: 92,
        evaluation_reason: "Natural and understandable",
        rewards: { gained_xp: 10, gained_coins: 2, total_xp: 10, total_coins: 2 },
      });
      return;
    }

    if (request.method === "POST" && request.url === "/api/vocabulary/submit") {
      const parsed = JSON.parse(body || "{}");
      const word = String(parsed.word ?? "").trim().toLowerCase();
      if (!word) {
        reply(response, 200, {
          matched: false,
          already_earned: false,
          reward_coins: 0,
          concept_completed: false,
        });
        return;
      }

      const concept = loadVocabulary(parsed.location).concepts.find((c) => c.concept === parsed.concept);
      const entry = concept?.words.find((w) => w.word.toLowerCase() === word);
      if (concept && !entry && concept.words[0]) {
        wordEvents.push({ lemma: concept.words[0].word, type: "meaning_fail", location: parsed.location, at: Date.now() });
      }
      if (concept && entry) {
        wordEvents.push({ lemma: entry.word, type: "active_success", location: parsed.location, at: Date.now() });
      }
      if (!concept || !entry) {
        reply(response, 200, { matched: false, already_earned: false, reward_coins: 0, concept_completed: false });
        return;
      }

      const key = keyFor(parsed.location, parsed.concept);
      const words = earnedWords.get(key) ?? new Set();
      const already = words.has(word);
      words.add(word);
      earnedWords.set(key, words);
      const total = concept.words.length;
      reply(response, 200, {
        matched: true,
        already_earned: already,
        reward_coins: already ? 0 : entry.reward_coins ?? 10,
        words_earned: words.size,
        words_total: total,
        concept_completed: words.size >= total,
      });
      return;
    }

    if (request.method === "POST" && request.url === "/api/speech/stt") {
      reply(response, 200, {
        text: MOCK_TRANSCRIPT,
        language_code: "en-US",
        mode: "verbatim",
        model: "mock",
        latency_ms: 0,
      });
      return;
    }

    if (request.method === "POST" && request.url === "/api/speech/tts") {
      replyAudio(response, buildSilentWav());
      return;
    }

    if (request.method === "GET" && /^\/api\/vocabulary\/progress\/\d+\/[^/]+$/.test(request.url ?? "")) {
      const location = (request.url ?? "").split("/").pop();
      const result = [];
      for (const [key, words] of earnedWords.entries()) {
        const [loc, concept] = key.split(":");
        if (loc !== location) continue;
        result.push({
          concept,
          words: [...words].map((word) => ({ word, earned: true })),
          completed: false,
        });
      }
      reply(response, 200, result);
      return;
    }

    reply(response, 404, { detail: "Not found" });
  });
});

server.listen(8000, "127.0.0.1", () => {
  console.log("Praglish development mock API: http://localhost:8000");
});
