
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class DialogueTurn(BaseModel):
    speaker: Literal["user", "npc", "coach"]
    text: str


class NPCTask(BaseModel):

    id: str
    description: str


class NPCIdentity(BaseModel):

    id: str
    name: str
    role: str
    user_role: str
    location: str
    personality: str
    tasks: list[NPCTask] = Field(default_factory=list)
    scenario_state: dict[str, Any] = Field(default_factory=dict)
    # Spell Book words the player struggles with; used only if they fit naturally.
    focus_words: list[str] = Field(default_factory=list)
    # Event-backed memories about the player, "(witnessed) ..." or "(heard) ..." (roleApp 7.3).
    memories: list[str] = Field(default_factory=list)
    # Sympathy tier: hostile, cold, neutral, friendly or close (roleApp 6.1).
    relationship_tier: Optional[str] = None
    # NPCs who can make plans: the game clock and the rules/plans they must respect (Kademe 2).
    world_time: Optional[str] = None
    plan_notes: list[str] = Field(default_factory=list)
    # The player's adventure tier sets the NPC's language ceiling (Kademe: A1, A2, B1…).
    cefr_level: Optional[str] = None
    # The story moment this turn happens in (an interactive cutscene step, or right after one).
    scene_note: Optional[str] = None


class LanguageEvaluationInput(BaseModel):

    utterance: str
    context: str
    speaker: str
    listener: str
    communicative_goals: list[str] = Field(default_factory=list)
    scenario_state: dict[str, Any] = Field(default_factory=dict)
    dialogue_history: list[DialogueTurn] = Field(default_factory=list)


class PlausibilityEstimate(BaseModel):

    probability_percent: float = Field(ge=0, le=100)
    brief_reason: str


class LanguageEvaluationResult(PlausibilityEstimate):

    threshold: float = Field(ge=0, le=100)
    accepted: bool


class CorrectionInput(BaseModel):

    model_config = ConfigDict(extra="forbid")

    utterance: str
    dialogue_history: list[DialogueTurn] = Field(default_factory=list)


class CorrectionResult(BaseModel):
    corrected_utterance: str
    coach_response: str


class GrammarFinding(BaseModel):
    topic_id: int = Field(ge=1, le=50)
    topic_name: str
    count: int = Field(default=1, ge=1)
    evidence: list[str] = Field(default_factory=list)
    issue: Optional[str] = None


class VocabularyFinding(BaseModel):
    lemma: str
    surface_form: str
    part_of_speech: Literal["noun", "adjective"]
    cefr_level: Literal["A1", "A2", "B1", "B2", "C1", "C2"]
    count: int = Field(default=1, ge=1)
    issue: Optional[str] = None


class VocabularyErrorFinding(BaseModel):
    lemma: str
    surface_form: str
    part_of_speech: Literal[
        "noun",
        "verb",
        "adjective",
        "adverb",
        "pronoun",
        "preposition",
        "conjunction",
        "determiner",
    ]
    error_type: Literal[
        "spelling",
        "word_form",
        "lexical_choice",
        "sense",
        "collocation",
    ]
    count: int = Field(default=1, ge=1)
    issue: str


class IdiomFinding(BaseModel):
    idiom: str
    normalized_idiom: str
    count: int = Field(default=1, ge=1)
    issue: Optional[str] = None


class ExtractionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    utterance: str


class CorrectExtractionResult(BaseModel):
    outcome: Literal["correct"] = "correct"
    grammar: list[GrammarFinding] = Field(default_factory=list)
    vocabulary: list[VocabularyFinding] = Field(default_factory=list)
    idioms: list[IdiomFinding] = Field(default_factory=list)


class IncorrectExtractionResult(BaseModel):
    outcome: Literal["incorrect"] = "incorrect"
    grammar: list[GrammarFinding] = Field(default_factory=list)
    vocabulary: list[VocabularyErrorFinding] = Field(default_factory=list)
    idioms: list[IdiomFinding] = Field(default_factory=list)


ExtractionResult = CorrectExtractionResult | IncorrectExtractionResult


class EvaluateRequest(BaseModel):
    location: str  # orn: "bakery"
    npc_role: str  # orn: "baker"
    scenario_state: dict = Field(default_factory=dict)
    dialogue_history: list[DialogueTurn] = Field(default_factory=list)
    user_text: str
    # Red/yellow Spell Book words chosen by the API for this turn (roleApp 4.5).
    focus_words: list[str] = Field(default_factory=list)
    # What this NPC remembers about the player and how it feels (roleApp 6.1, 7.3).
    npc_memories: list[str] = Field(default_factory=list)
    relationship_tier: Optional[str] = None
    world_time: Optional[str] = None
    plan_notes: list[str] = Field(default_factory=list)
    cefr_level: Optional[str] = None
    scene_note: Optional[str] = None


class RewardInfo(BaseModel):
    gained_xp: int
    gained_coins: int
    total_xp: int
    total_coins: int


class EvaluateResponse(BaseModel):
    accepted: bool
    correction: Optional[str] = None
    npc_response: str
    response_speaker: Literal["npc", "coach"]
    updated_scenario_state: dict = Field(default_factory=dict)
    probability_percent: Optional[float] = Field(default=None, ge=0, le=100)
    evaluation_reason: Optional[str] = None
    rewards: Optional[RewardInfo] = None
    # Focus words that actually appear in npc_response (set by the API).
    used_focus_words: list[str] = Field(default_factory=list)
    adventure_stage: Optional[int] = None
    inventory_changes: list[dict[str, Any]] = Field(default_factory=list)
    adventure_notice: Optional[str] = None
    # Set by the API: the NPC's relationship after this turn and anything it newly remembers.
    relationship: Optional[dict[str, Any]] = None
    new_memories: list[str] = Field(default_factory=list)
    # Set by the API when this turn made, moved or cancelled a meeting.
    plan_update: Optional[dict[str, Any]] = None


class InventoryEntry(BaseModel):
    item_id: str
    name: str
    quantity: int = Field(ge=1)


class InventoryTransfer(BaseModel):
    item_id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=80)
    delta: int = Field(ge=-99, le=99)
    category: Literal["food", "drink", "other"]


class KnownItem(BaseModel):
    """A familiar item from api/game_data/adventure.json; not an allowed-item list."""
    item_id: str
    name: str
    aliases: list[str] = Field(default_factory=list)


class InventoryDecisionRequest(BaseModel):
    location: str
    npc_role: str
    player_text: str
    npc_reply: str
    previous_dialogue: list[DialogueTurn] = Field(default_factory=list)
    inventory: list[InventoryEntry] = Field(default_factory=list)
    known_items: list[KnownItem] = Field(default_factory=list)


class InventoryDecisionResponse(BaseModel):
    transfers: list[InventoryTransfer] = Field(default_factory=list)


class KnownPlace(BaseModel):
    place_id: str
    name: str
    aliases: list[str] = Field(default_factory=list)


class PlanDecisionRequest(BaseModel):
    npc_name: str
    world_time: str
    player_text: str
    npc_reply: str
    previous_dialogue: list[DialogueTurn] = Field(default_factory=list)
    places: list[KnownPlace] = Field(default_factory=list)
    current_plan: Optional[str] = None
    missed_plan: Optional[str] = None


class PlanDecisionResponse(BaseModel):
    """What the latest exchange did to the meeting plan; the API validates and applies it."""
    action: Literal["none", "create", "cancel"] = "none"
    place_id: Optional[str] = Field(default=None, max_length=40)
    time: Optional[str] = Field(default=None, pattern=r"^\d{1,2}:\d{2}$")
    day: Literal["today", "tomorrow"] = "today"
    apologized: bool = False


class SentenceCheckRequest(BaseModel):
    """Is this a natural English sentence that uses the target word correctly? (Kademe 3 spells)"""
    utterance: str
    target_word: str
    context: str = "casting a spell at a rune gate"


class SentenceCheckResponse(BaseModel):
    accepted: bool
    probability_percent: Optional[float] = None
    reason: Optional[str] = None
    correction: Optional[str] = None


class TTSRequest(BaseModel):
    text: str
    voice: str = "hannah"
    style: str = "Speak naturally, warmly, and at a patient conversational pace."


class TTSResponse(BaseModel):
    audio_url: str


class STTResponse(BaseModel):
    text: str
    language_code: Optional[str] = None
    mode: Literal["verbatim"] = "verbatim"
    model: str
    latency_ms: int = Field(ge=0)
