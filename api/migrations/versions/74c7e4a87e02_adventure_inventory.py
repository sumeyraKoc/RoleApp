"""Persist adventure stage and inventory transfers.

Revision ID: 74c7e4a87e02
Revises: 8b598b38b509
"""
from alembic import op
import sqlalchemy as sa


revision = "74c7e4a87e02"
down_revision = "8b598b38b509"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("adventure_stage", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("sessions", sa.Column("mode", sa.String(), nullable=False, server_default="roleplay"))
    op.create_table(
        "inventory_items",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("item_id", sa.String(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.UniqueConstraint("user_id", "item_id", name="uq_inventory_user_item"),
    )
    op.create_index("ix_inventory_items_user_id", "inventory_items", ["user_id"])
    op.create_table(
        "inventory_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("dialogue_id", sa.Integer(), sa.ForeignKey("dialogues.id"), nullable=False),
        sa.Column("item_id", sa.String(), nullable=False),
        sa.Column("delta", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("dialogue_id", "item_id", name="uq_inventory_dialogue_item"),
    )
    op.create_index("ix_inventory_events_user_id", "inventory_events", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_inventory_events_user_id", table_name="inventory_events")
    op.drop_table("inventory_events")
    op.drop_index("ix_inventory_items_user_id", table_name="inventory_items")
    op.drop_table("inventory_items")
    op.drop_column("sessions", "mode")
    op.drop_column("users", "adventure_stage")
