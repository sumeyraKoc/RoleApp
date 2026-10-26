"""Store display names for open-ended inventory items.

Revision ID: c9a5d62b384f
Revises: 74c7e4a87e02
"""
from alembic import op
import sqlalchemy as sa

revision = "c9a5d62b384f"
down_revision = "74c7e4a87e02"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("inventory_items", sa.Column("name", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("inventory_items", "name")
