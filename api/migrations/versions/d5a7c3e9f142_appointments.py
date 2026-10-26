"""Meetings arranged with NPCs.

Revision ID: d5a7c3e9f142
Revises: b2e8f4c61d07
"""
from alembic import op
import sqlalchemy as sa


revision = "d5a7c3e9f142"
down_revision = "b2e8f4c61d07"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "appointments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("npc_id", sa.String(), nullable=False),
        sa.Column("place_id", sa.String(), nullable=False),
        sa.Column("game_seconds", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="planned"),
        sa.Column("reminded", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("apologized", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("source_dialogue_id", sa.Integer(), sa.ForeignKey("dialogues.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_appointments_user_id", "appointments", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_appointments_user_id", table_name="appointments")
    op.drop_table("appointments")
