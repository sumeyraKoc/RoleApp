"""Per-player in-game clock.

Revision ID: 9c4e2b7d1a33
Revises: 5f3c1a9e7b20
"""
from alembic import op
import sqlalchemy as sa


revision = "9c4e2b7d1a33"
down_revision = "5f3c1a9e7b20"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("game_seconds", sa.Integer(), nullable=False, server_default=str(8 * 3600)))
    op.add_column("users", sa.Column("clock_synced_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "clock_synced_at")
    op.drop_column("users", "game_seconds")
