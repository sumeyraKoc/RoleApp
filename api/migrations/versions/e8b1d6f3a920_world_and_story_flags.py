"""Where the player is (town or the Misty Isles) and story flags.

Revision ID: e8b1d6f3a920
Revises: d5a7c3e9f142
"""
from alembic import op
import sqlalchemy as sa


revision = "e8b1d6f3a920"
down_revision = "d5a7c3e9f142"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("world", sa.String(), nullable=False, server_default="town"))
    op.add_column("users", sa.Column("story_flags", sa.JSON(), nullable=False, server_default="{}"))


def downgrade() -> None:
    op.drop_column("users", "story_flags")
    op.drop_column("users", "world")
