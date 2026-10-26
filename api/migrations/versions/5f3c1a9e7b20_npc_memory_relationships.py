"""NPC memories and player relationships.

Revision ID: 5f3c1a9e7b20
Revises: e2d47af691bc
"""
from alembic import op
import sqlalchemy as sa


revision = "5f3c1a9e7b20"
down_revision = "e2d47af691bc"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "npc_relationships",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("npc_id", sa.String(), nullable=False),
        sa.Column("sympathy", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("trust", sa.Integer(), nullable=False, server_default="40"),
        sa.Column("turn_session_id", sa.Integer(), nullable=True),
        sa.Column("turn_sympathy_gained", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "npc_id", name="uq_npc_relationship"),
    )
    op.create_index("ix_npc_relationships_user_id", "npc_relationships", ["user_id"])
    op.create_table(
        "npc_memories",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("npc_id", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("text", sa.String(), nullable=False),
        sa.Column("source_type", sa.String(), nullable=False),
        sa.Column("source_id", sa.String(), nullable=False),
        sa.Column("heard_from", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "npc_id", "source_type", "source_id", name="uq_npc_memory_source"),
    )
    op.create_index("ix_npc_memories_user_id", "npc_memories", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_npc_memories_user_id", table_name="npc_memories")
    op.drop_table("npc_memories")
    op.drop_index("ix_npc_relationships_user_id", table_name="npc_relationships")
    op.drop_table("npc_relationships")
