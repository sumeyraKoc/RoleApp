"""The in-game clock: 2 real minutes = 1 game hour (30 game seconds per real second).

The server owns the clock. The client calls tick() every few seconds while the
game is open; each call adds the real time since the previous one, capped at
MAX_GAP_SECONDS, so the clock pauses while the game is closed and cannot be
fast-forwarded by the client. Sleeping in the player's bed is the only jump.
"""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel

from models.models import User

GAME_SECONDS_PER_REAL_SECOND = 30
MAX_GAP_SECONDS = 30
DAY = 24 * 3600
START_SECONDS = 8 * 3600
WAKE_HOUR = 7
SLEEP_FROM_HOUR = 20  # bed works from 20:00 until 06:00
SLEEP_UNTIL_HOUR = 6


class ClockView(BaseModel):
    game_seconds: int
    day: int
    hour: int
    minute: int
    label: str
    game_seconds_per_real_second: int = GAME_SECONDS_PER_REAL_SECOND


def view(game_seconds: int) -> ClockView:
    day, rest = divmod(game_seconds, DAY)
    hour, minute = rest // 3600, (rest % 3600) // 60
    return ClockView(
        game_seconds=game_seconds, day=day + 1, hour=hour, minute=minute,
        label=f"Day {day + 1} · {hour:02d}:{minute:02d}",
    )


def advance(user: User, now: Optional[datetime] = None) -> ClockView:
    """Add the real time since the last sync (capped) to the player's clock."""
    now = now or datetime.utcnow()
    if user.game_seconds is None:
        user.game_seconds = START_SECONDS
    if user.clock_synced_at is not None:
        gap = (now - user.clock_synced_at).total_seconds()
        counted = min(max(gap, 0.0), MAX_GAP_SECONDS)
        user.game_seconds += int(counted * GAME_SECONDS_PER_REAL_SECOND)
    user.clock_synced_at = now
    return view(user.game_seconds)


def can_sleep(game_seconds: int) -> bool:
    hour = (game_seconds % DAY) // 3600
    return hour >= SLEEP_FROM_HOUR or hour < SLEEP_UNTIL_HOUR


def sleep(user: User, now: Optional[datetime] = None) -> ClockView:
    """Jump to the next 07:00. Callers check can_sleep() first."""
    current = advance(user, now)
    day_start = (current.game_seconds // DAY) * DAY
    wake = day_start + WAKE_HOUR * 3600
    if current.hour >= SLEEP_FROM_HOUR:
        wake += DAY
    user.game_seconds = wake
    return view(wake)
