"""Reopen Lina's quest for players advanced by the old talk-only rule.

Revision ID: e2d47af691bc
Revises: c9a5d62b384f
"""
from alembic import op
import sqlalchemy as sa

revision = "e2d47af691bc"
down_revision = "c9a5d62b384f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text("""
        UPDATE users
        SET adventure_stage = 1
        WHERE adventure_stage >= 2
          AND NOT EXISTS (
            SELECT 1
            FROM inventory_events AS event
            JOIN dialogues AS dialogue ON dialogue.id = event.dialogue_id
            JOIN sessions AS game_session ON game_session.id = dialogue.session_id
            WHERE event.user_id = users.id
              AND event.item_id = 'boat_building_manual'
              AND event.delta > 0
              AND game_session.location = 'library'
              AND game_session.npc_role = 'librarian'
          )
    """))


def downgrade() -> None:
    # Historical talk-only progress cannot be reconstructed after the correction.
    pass
