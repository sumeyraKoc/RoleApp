import { guestAuthHeader, guestCredentials } from "./guestAuth";
const runtimeWindow = window as typeof window & { PRAGLISH_API_BASE_URL?: string };
const API_BASE_URL = (runtimeWindow.PRAGLISH_API_BASE_URL ?? "http://localhost:8000").replace(/\/$/, "");

interface SessionStartResponse {
  session_id: number;
  user_id: number;
}

export interface RewardInfo {
  gained_xp: number;
  gained_coins: number;
  total_xp: number;
  total_coins: number;
}

export interface TurnResponse {
  accepted: boolean;
  correction: string | null;
  npc_response: string;
  response_speaker: "npc" | "coach";
  probability_percent: number | null;
  evaluation_reason: string | null;
  rewards: RewardInfo | null;
  /** Spell Book words the NPC used in npc_response (highlighted in the panel). */
  used_focus_words?: string[];
  adventure_stage?: number | null;
  inventory_changes?: InventoryEntry[];
  adventure_notice?: string | null;
  /** How this NPC feels about the player after the turn (api/game_data/npcs.json rules). */
  relationship?: NpcRelationship | null;
  /** Player-facing lines for things the NPC will now remember. */
  new_memories?: string[];
  /** Set when this turn made, moved or cancelled a meeting (api/services/plans.py). */
  plan_update?: PlanUpdate | null;
}

export interface Appointment {
  id: number;
  npc_id: string;
  npc_name: string;
  place_id: string;
  place_name: string;
  game_seconds: number;
  label: string;
  status: "planned" | "kept" | "missed" | "cancelled";
  late_minutes: number;
  wait_minutes: number;
  /** Cutscene for a kept meeting at this place (api/game_data/plans.json). */
  scene_id?: string | null;
}

export interface PlanUpdate {
  status: "planned" | "cancelled" | "rejected";
  message: string;
  appointment?: Appointment | null;
}

export type RelationshipTier = "hostile" | "cold" | "neutral" | "friendly" | "close";

export interface NpcRelationship {
  npc_id: string;
  name: string;
  sympathy: number;
  trust: number;
  tier: RelationshipTier | string;
}

export interface InventoryEntry {
  item_id: string;
  name: string;
  quantity: number;
}

/** Content from api/game_data/adventure.json, served with the player's adventure state. */
export interface AdventureChapter {
  id: string;
  label: string;
  title: string;
  intro: string;
  complete_title: string;
  complete_text: string;
}

export interface QuestRule {
  type: "receive_item" | "talk" | "scene" | "plan_resolved" | "reach_place";
  scene_id?: string | null;
  place_id?: string;
  npc_id?: string;
  trigger?: { near_building?: string | null; world?: string; from: string; to: string };
}

export interface AdventureQuest {
  id: string;
  title: string;
  place: string;
  detail: string;
  complete_when?: QuestRule;
}

/** One kademe: its chapter text, language level and quests (api/game_data/adventure.json). */
export interface AdventureTier {
  tier: number;
  cefr: string;
  chapter: AdventureChapter;
  quests: AdventureQuest[];
}

export interface AdventureContent {
  tiers: AdventureTier[];
}

export interface AdventureFlags {
  kept_meeting: boolean;
  missed_meeting: boolean;
}

export interface AdventureState {
  /** Index of the active quest across all tiers laid end to end. */
  stage: number;
  inventory: InventoryEntry[];
  adventure: AdventureContent;
  flags?: AdventureFlags;
  /** Where the player is ("town" or "isles") and where they may sail. */
  world?: string;
  unlocked_worlds?: string[];
  story_flags?: { opened_gates?: string[]; spells?: string[] };
}

/** Kademe 3 spells: an English word, used correctly in a sentence, opens a rune gate. */
export interface SpellInfo {
  gate_id: string;
  gate_name: string;
  word: string;
  source: "spellbook" | "gate";
  min_words: number;
  opened: boolean;
}

export interface SpellCastResult {
  success: boolean;
  spell: SpellInfo;
  hint?: string;
  correction?: string | null;
  already_open?: boolean;
  /** Free-play cast: the gate opened only for this visit. */
  practice?: boolean;
  quest_completed?: boolean;
  stage?: number;
}

/** A cutscene played by the town engine (api/game_data/cutscenes/<id>.json). */
export interface Cutscene {
  id: string;
  title: string;
  /** What happened, for the NPCs' context afterwards. */
  summary?: string;
  /** After the scene: who stays where they are, and who to keep talking to. */
  after?: { stay?: string[]; talk?: string };
  steps: CutsceneStep[];
}

export type CutsceneTarget = string | { x: number; z: number };

export interface CutsceneStep {
  when?: "kept_meeting" | "missed_meeting";
  camera?: { focus: CutsceneTarget; zoom?: number };
  title?: { text: string; seconds: number };
  place?: { who: string; cell: { x: number; z: number } };
  walk?: { who: string; to?: { x: number; z: number }; near?: string; run?: boolean; wait?: boolean };
  say?: { who: string; text: string };
  effect?: "flash" | "fade_out" | "fade_in";
  wait?: number;
  toast?: string;
  /** A world effect the town performs (e.g. "light_beacon"). */
  call?: string;
  /** An interactive beat: the player answers in English before the scene goes on. */
  ask?: { who: string; goal: string; context: string; hint: string };
}

export interface ReachResult extends AdventureState {
  completed: boolean;
  scene_id: string | null;
  missing: string[];
}

export interface PhoneMessage {
  id: number;
  speaker: "user" | "npc" | "coach";
  text: string;
  channel: "phone" | "in_person";
}

export interface PhoneThread {
  session_id: number;
  contact: string;
  messages: PhoneMessage[];
  unread: number;
  seen_id: number;
}

/** The in-game clock as the API reports it (api/services/world_clock.py). */
export interface ClockState {
  game_seconds: number;
  day: number;
  hour: number;
  minute: number;
  label: string;
  game_seconds_per_real_second: number;
}

export interface TtsVoiceProfile {
  voice: string;
  style: string;
  /** Played with a cavernous echo (voiceFx.ts); not sent to the API. */
  echo?: boolean;
}

export const ROLEPLAY_TTS_PROFILES = {
  /** The player's own character in cutscenes. */
  player: {
    voice: "autumn",
    style: "Speak as a cheerful, warm young woman talking with old friends. Natural, friendly and relaxed pace.",
  },
  keeper: {
    voice: "diana",
    style: "Speak as a calm, wise old lighthouse keeper with a gentle, mysterious tone. Slow and clear.",
  },
  merchant: {
    voice: "daniel",
    style: "Speak as a sly, charming market trader who loves to bargain. Warm, playful and a little dramatic.",
  },
  friend: {
    voice: "troy",
    style: "Speak as an excited, energetic young man catching up with an old friend. Slightly breathless, laughs easily, natural relaxed pace.",
  },
  librarian: {
    voice: "diana",
    style: "Speak naturally and warmly as a patient, knowledgeable female librarian at a relaxed conversational pace.",
  },
  cafeNpc: {
    voice: "hannah",
    style: "Speak as a sweet, cheerful young woman working in a cafe. Sound friendly, bright, and natural at a relaxed conversational pace.",
  },
  barista: {
    voice: "austin",
    style: "Speak as a friendly, laid-back young man working as a barista. Sound upbeat and natural at a relaxed conversational pace.",
  },
  coach: {
    voice: "austin",
    style: "[calm] [confidently] [professionally]",
  },
  alchemist: {
    voice: "austin",
    style: "Speak as an excitable, slightly absent-minded old alchemist who loves his experiments. Quick, curious, a little theatrical.",
  },
  witch: {
    voice: "diana",
    style: "Speak as an ancient, lonely sea witch. Low, slow and dramatic, with long pauses, as if her words drift through mist.",
    echo: true,
  },
} as const satisfies Record<string, TtsVoiceProfile>;

export interface VocabularySubmitResponse {
  matched: boolean;
  already_earned: boolean;
  reward_coins: number;
  words_earned?: number;
  words_total?: number;
  concept_completed?: boolean;
  total_coins?: number;
}

export interface VocabularyProgressWord {
  word: string;
  earned: boolean;
}

export interface VocabularyProgressEntry {
  concept: string;
  words: VocabularyProgressWord[];
  completed: boolean;
}

export type SpellBookStatus = "new" | "yellow" | "red" | "green";

/** One word in the player's Spell Book (GET /api/spellbook/{user_id}). */
export interface SpellBookEntry {
  lemma: string;
  status: SpellBookStatus;
  struggle_score: number;
  meaning_fails: number;
  pronunciation_fails: number;
  usage_fails: number;
  active_successes: number;
  sources: string[];
  example: string | null;
  last_event_at: string;
}

export interface SpeechToTextResult {
  text: string;
  languageCode: string | null;
}

export interface DashboardData {
  profile: { user_id: number; username: string; xp: number; coins: number; level: number };
  summary: {
    total_turns: number;
    correct_turns: number;
    incorrect_turns: number;
    success_percent: number;
    words_learned: number;
    idioms_discovered: number;
  };
  weekly_activity: { date: string; correct: number; incorrect: number }[];
  locations: { name: string; turn_count: number }[];
  grammar_topics: {
    topic_id: number;
    topic_name: string;
    correct_count: number;
    incorrect_count: number;
    mastery_percent: number;
  }[];
  vocabulary_levels: { name: string; count: number }[];
  vocabulary_errors: { name: string; count: number }[];
  idioms: {
    normalized_idiom: string;
    display_idiom: string;
    correct_count: number;
    incorrect_count: number;
    last_used_at: string | null;
  }[];
}

export interface PraglishSessionConfig {
  location: string;
  npcRole: string;
  npcName: string;
  mode?: "roleplay" | "adventure";
}

const DEFAULT_SESSION_CONFIG: PraglishSessionConfig = {
  location: "bakery",
  npcRole: "baker",
  npcName: "Maya",
};

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

export class PraglishApiClient {
  private static readonly instances = new Set<PraglishApiClient>();
  private sessionPromise: Promise<number> | null = null;
  private userId: number | null = null;

  constructor(private readonly config: PraglishSessionConfig = DEFAULT_SESSION_CONFIG) {
    PraglishApiClient.instances.add(this);
  }

  public static resetAllSessions(): void {
    PraglishApiClient.instances.forEach((client) => client.resetSession());
  }

  public startSession(): Promise<number> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.createSession().catch((error: unknown) => {
        this.sessionPromise = null;
        throw error;
      });
    }
    return this.sessionPromise;
  }

  public resetSession(): void {
    this.sessionPromise = null;
  }

  /** `sceneNote` tells the NPC which story moment this turn happens in (cutscene steps, right after a scene). */
  public async sendTurn(userText: string, sceneNote?: string | null): Promise<TurnResponse> {
    const sessionId = await this.startSession();
    return this.request<TurnResponse>(`/api/session/${sessionId}/turn`, {
      user_text: userText,
      ...(sceneNote ? { scene_note: sceneNote } : {}),
    });
  }

  /** Advance the server-owned game clock by the real time since the last tick (POST /api/world/clock/tick). */
  public async tickClock(): Promise<ClockState> {
    await this.startSession(); // creates the guest account on a first visit
    return this.request<ClockState>("/api/world/clock/tick", {});
  }

  /** Sleep until 07:00; the API answers 409 before 20:00. */
  public async sleep(): Promise<ClockState> {
    await this.startSession();
    return this.request<ClockState>("/api/world/sleep", {});
  }

  /** The persistent text thread with a phone contact (GET /api/phone/{contact}). */
  public async getPhoneThread(contact: string): Promise<PhoneThread> {
    await this.startSession();
    return this.requestGet<PhoneThread>(`/api/phone/${encodeURIComponent(contact)}`);
  }

  public async getCutscene(sceneId: string): Promise<Cutscene> {
    await this.startSession();
    return this.requestGet<Cutscene>(`/api/adventure/cutscenes/${encodeURIComponent(sceneId)}`);
  }

  /** The player watched (or skipped) a scene; may finish a scene quest. */
  public async sceneSeen(sceneId: string): Promise<AdventureState & { completed: boolean }> {
    return this.request(`/api/adventure/scenes/${encodeURIComponent(sceneId)}/seen`, {});
  }

  /** The word a rune gate asks this player for (GET /api/spells/{gate}). */
  public async getSpell(gateId: string): Promise<SpellInfo> {
    await this.startSession();
    return this.requestGet<SpellInfo>(`/api/spells/${encodeURIComponent(gateId)}`);
  }

  /** `practice`: free play — the word counts, but the gate is not saved as open and no quest moves. */
  public async castSpell(gateId: string, text: string, practice = false): Promise<SpellCastResult> {
    return this.request<SpellCastResult>(`/api/spells/${encodeURIComponent(gateId)}/cast`, { text, practice });
  }

  /** Sail to another world (POST /api/adventure/travel/{world}). */
  public async travel(world: string): Promise<AdventureState> {
    await this.startSession();
    return this.request<AdventureState>(`/api/adventure/travel/${encodeURIComponent(world)}`, {});
  }

  /** The player reached a place; may finish a reach_place quest. */
  public async reachPlace(placeId: string): Promise<ReachResult> {
    return this.request<ReachResult>(`/api/adventure/reach/${encodeURIComponent(placeId)}`, {});
  }

  /** Upcoming meetings (GET /api/plans). */
  public async getPlans(): Promise<Appointment[]> {
    await this.startSession();
    return (await this.requestGet<{ plans: Appointment[] }>("/api/plans")).plans;
  }

  /** Tell the server the player reached the meeting place; it checks its own clock. */
  public async arriveForPlan(appointmentId: number): Promise<{ appointment: Appointment; memory: string | null }> {
    return this.request(`/api/plans/${appointmentId}/arrive`, {});
  }

  public async markPhoneRead(contact: string, lastId: number): Promise<void> {
    await this.request(`/api/phone/${encodeURIComponent(contact)}/read`, { last_id: lastId });
  }

  /** Send a text in a phone thread; it goes through the normal turn pipeline. */
  public async sendPhoneMessage(threadSessionId: number, text: string): Promise<TurnResponse> {
    return this.request<TurnResponse>(`/api/session/${threadSessionId}/turn`, { user_text: text });
  }

  public async getAdventureState(): Promise<AdventureState> {
    await this.startSession();
    return this.requestGet<AdventureState>("/api/adventure/state");
  }

  public async submitVocabulary(concept: string, word: string): Promise<VocabularySubmitResponse> {
    await this.startSession();
    if (this.userId === null) {
      throw new ApiError("No active session yet - cannot submit vocabulary.");
    }
    return this.request<VocabularySubmitResponse>("/api/vocabulary/submit", {
      user_id: this.userId,
      location: this.config.location,
      concept,
      word,
    });
  }

  public async getVocabularyProgress(): Promise<VocabularyProgressEntry[]> {
    await this.startSession();
    if (this.userId === null) return [];
    return this.requestGet<VocabularyProgressEntry[]>(
      `/api/vocabulary/progress/${this.userId}/${this.config.location}`,
    );
  }

  public async getSpellBook(): Promise<SpellBookEntry[]> {
    await this.startSession();
    if (this.userId === null) return [];
    return this.requestGet<SpellBookEntry[]>(`/api/spellbook/${this.userId}`);
  }

  public async getDashboard(): Promise<DashboardData> {
    return this.request<DashboardData>("/api/analytics/dashboard", guestCredentials());
  }

  public async transcribeAudio(audioBlob: Blob): Promise<SpeechToTextResult> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const formData = new FormData();
      formData.append("audio", audioBlob, "recording.webm");
      const response = await fetch(`${API_BASE_URL}/api/speech/stt`, {
        method: "POST",
        body: formData,
        headers: { Authorization: guestAuthHeader() },
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { detail?: string } | null;
        throw new ApiError(
          payload?.detail ?? `Speech-to-text failed (${response.status})`,
          response.status,
        );
      }
      const data = await response.json() as { text: string; language_code: string | null };
      return { text: data.text, languageCode: data.language_code };
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiError("Speech recognition took too long. Please try again.");
      }
      throw new ApiError("Speech-to-text service is unavailable.");
    } finally {
      window.clearTimeout(timeout);
    }
  }

  public async synthesizeSpeech(text: string, profile?: TtsVoiceProfile): Promise<Blob> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${API_BASE_URL}/api/speech/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: guestAuthHeader() },
        body: JSON.stringify(profile ? { text, voice: profile.voice, style: profile.style } : { text }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const detail = body && typeof body === "object" && "detail" in body && typeof body.detail === "string"
          ? body.detail
          : `HTTP ${response.status}`;
        throw new ApiError(`Speech could not be generated: ${detail}`, response.status);
      }
      return await response.blob();
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiError("Text-to-speech took too long.");
      }
      throw new ApiError("Text-to-speech service is unavailable.");
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private async createSession(): Promise<number> {
    const credentials = guestCredentials();
    const response = await this.request<SessionStartResponse>("/api/session/start", {
      ...credentials,
      location: this.config.location,
      npc_role: this.config.npcRole,
      mode: this.config.mode ?? "roleplay",
    });
    this.userId = response.user_id;
    return response.session_id;
  }

  private async request<T>(path: string, body: object): Promise<T> {
    return this.performFetch<T>(path, { method: "POST", body });
  }

  private async requestGet<T>(path: string): Promise<T> {
    return this.performFetch<T>(path, { method: "GET" });
  }

  private async performFetch<T>(
    path: string,
    options: { method: "GET" | "POST"; body?: object },
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 125_000);
    try {
      const init: RequestInit = { method: options.method, signal: controller.signal, headers: { Authorization: guestAuthHeader() } };
      if (options.body !== undefined) {
        init.headers = { "Content-Type": "application/json", Authorization: guestAuthHeader() };
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(`${API_BASE_URL}${path}`, init);
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { detail?: string } | null;
        throw new ApiError(payload?.detail ?? `API request failed (${response.status})`, response.status);
      }
      return await response.json() as T;
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ApiError(`${this.config.npcName} took too long to answer. Please try again.`);
      }
      throw new ApiError("Backend is unavailable at localhost:8000.");
    } finally {
      window.clearTimeout(timeout);
    }
  }

}
