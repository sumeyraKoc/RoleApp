from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from core.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    password_hash = Column(String, nullable=False)
    coins = Column(Integer, default=0)
    xp = Column(Integer, default=0)
    adventure_stage = Column(Integer, nullable=False, default=0)
    # In-game clock (services/world_clock.py): game time in seconds since Day 1 00:00,
    # and the real UTC moment it was last advanced. The clock only runs while the game is open.
    game_seconds = Column(Integer, nullable=False, default=8 * 3600)
    clock_synced_at = Column(DateTime, nullable=True)
    # Phone (services/phone.py): the newest NPC message the player has seen.
    phone_seen_dialogue_id = Column(Integer, nullable=False, default=0)
    # Which world the player is in ("town", "isles") and story facts such as opened rune gates.
    world = Column(String, nullable=False, default="town")
    story_flags = Column(JSON, nullable=False, default=dict)

    sessions = relationship("GameSession", back_populates="user")


class GameSession(Base):
    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    location = Column(String)
    npc_role = Column(String)
    mode = Column(String, nullable=False, default="roleplay")
    scenario_state = Column(JSON, default=dict)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User", back_populates="sessions")
    dialogues = relationship("Dialogue", back_populates="session", cascade="all, delete")


class Dialogue(Base):

    __tablename__ = "dialogues"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("sessions.id"))
    speaker = Column(String)
    text = Column(String)


    is_natural = Column(Boolean, nullable=True)
    correction = Column(String, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    session = relationship("GameSession", back_populates="dialogues")


class InventoryItem(Base):
    __tablename__ = "inventory_items"
    __table_args__ = (UniqueConstraint("user_id", "item_id", name="uq_inventory_user_item"),)

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    item_id = Column(String, nullable=False)
    name = Column(String, nullable=True)
    quantity = Column(Integer, nullable=False, default=0)


class InventoryEvent(Base):
    __tablename__ = "inventory_events"
    __table_args__ = (UniqueConstraint("dialogue_id", "item_id", name="uq_inventory_dialogue_item"),)

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    dialogue_id = Column(Integer, ForeignKey("dialogues.id"), nullable=False)
    item_id = Column(String, nullable=False)
    delta = Column(Integer, nullable=False)
    reason = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class NpcRelationship(Base):
    """How one NPC feels about one player (roleApp 6.1). Rules live in game_data/npcs.json."""

    __tablename__ = "npc_relationships"
    __table_args__ = (UniqueConstraint("user_id", "npc_id", name="uq_npc_relationship"),)

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    npc_id = Column(String, nullable=False)
    sympathy = Column(Integer, nullable=False, default=0)
    trust = Column(Integer, nullable=False, default=40)
    # Per-conversation cap for small-talk sympathy (roleApp 6.1).
    turn_session_id = Column(Integer, nullable=True)
    turn_sympathy_gained = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class NpcMemory(Base):
    """One thing an NPC remembers about a player, always tied to a real game event (roleApp 7.6)."""

    __tablename__ = "npc_memories"
    __table_args__ = (
        UniqueConstraint("user_id", "npc_id", "source_type", "source_id", name="uq_npc_memory_source"),
    )

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    npc_id = Column(String, nullable=False)
    kind = Column(String, nullable=False)  # "witnessed" or "heard"
    text = Column(String, nullable=False)
    source_type = Column(String, nullable=False)  # "inventory_event" or "quest"
    source_id = Column(String, nullable=False)
    heard_from = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Appointment(Base):
    """A meeting the player arranged with an NPC (services/plans.py)."""

    __tablename__ = "appointments"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    npc_id = Column(String, nullable=False)
    place_id = Column(String, nullable=False)
    game_seconds = Column(Integer, nullable=False)  # meeting time on the in-game clock
    status = Column(String, nullable=False, default="planned")  # planned, kept, missed, cancelled
    reminded = Column(Boolean, nullable=False, default=False)
    apologized = Column(Boolean, nullable=False, default=False)
    source_dialogue_id = Column(Integer, ForeignKey("dialogues.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class VocabularyProgress(Base):

    __tablename__ = "vocabulary_progress"
    __table_args__ = (
        UniqueConstraint("user_id", "location", "concept", "word", name="uq_vocab_progress"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    location = Column(String)
    concept = Column(String)
    word = Column(String)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class LearningExtractionEvent(Base):

    __tablename__ = "learning_extraction_events"

    id = Column(Integer, primary_key=True, index=True)
    dialogue_id = Column(Integer, ForeignKey("dialogues.id"), unique=True, nullable=False)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    outcome = Column(String, nullable=False)
    utterance = Column(String, nullable=False)
    raw_result = Column(JSON, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class LearningTurnEvent(Base):

    __tablename__ = "learning_turn_events"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=False, index=True)
    dialogue_id = Column(Integer, ForeignKey("dialogues.id"), nullable=True, unique=True)
    location = Column(String, nullable=False, index=True)
    outcome = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class GrammarUsageStat(Base):
    __tablename__ = "grammar_usage_stats"
    __table_args__ = (
        UniqueConstraint("user_id", "outcome", "topic_id", name="uq_grammar_usage_stat"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    outcome = Column(String, nullable=False)
    topic_id = Column(Integer, nullable=False)
    topic_name = Column(String, nullable=False)
    count = Column(Integer, nullable=False, default=0)


class VocabularyLevelStat(Base):
    __tablename__ = "vocabulary_level_stats"
    __table_args__ = (
        UniqueConstraint("user_id", "outcome", "cefr_level", name="uq_vocabulary_level_stat"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    outcome = Column(String, nullable=False)
    cefr_level = Column(String, nullable=False)
    count = Column(Integer, nullable=False, default=0)


class VocabularyErrorTypeStat(Base):
    __tablename__ = "vocabulary_error_type_stats"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "error_type",
            name="uq_vocabulary_error_type_stat",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    error_type = Column(String, nullable=False)
    count = Column(Integer, nullable=False, default=0)


class IdiomUsageStat(Base):
    __tablename__ = "idiom_usage_stats"
    __table_args__ = (
        UniqueConstraint("user_id", "outcome", "normalized_idiom", name="uq_idiom_usage_stat"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    outcome = Column(String, nullable=False)
    normalized_idiom = Column(String, nullable=False)
    display_idiom = Column(String, nullable=False)
    count = Column(Integer, nullable=False, default=0)
    first_used_at = Column(DateTime(timezone=True), server_default=func.now())
    last_used_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class WordEvent(Base):
    """One raw signal about a word for the Spell Book (roleApp 4.1).

    event_type: meaning_fail, pronunciation_fail, usage_fail, passive_encounter,
    context_success, active_success. Scores are recomputed from these rows.
    """

    __tablename__ = "word_events"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    lemma = Column(String, nullable=False, index=True)
    surface_form = Column(String, nullable=True)
    event_type = Column(String, nullable=False)
    location = Column(String, nullable=True)
    example = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
