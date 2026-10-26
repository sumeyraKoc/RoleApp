"""Track which phone messages the player has seen.

Revision ID: b2e8f4c61d07
Revises: 9c4e2b7d1a33
"""
from alembic import op
import sqlalchemy as sa


revision = "b2e8f4c61d07"
down_revision = "9c4e2b7d1a33"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("phone_seen_dialogue_id", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("users", "phone_seen_dialogue_id")
