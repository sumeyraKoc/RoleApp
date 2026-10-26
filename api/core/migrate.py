"""Apply schema revisions while preserving pre-Alembic prototype databases."""
from pathlib import Path

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import inspect

from core.database import Base, engine
from models import models  # noqa: F401 - registers the mapped tables


def upgrade_database() -> None:
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    with engine.connect() as connection:
        tables = set(inspect(connection).get_table_names()) - {"alembic_version"}
        has_version = inspect(connection).has_table("alembic_version")
        if tables and not has_version:
            differences = compare_metadata(
                MigrationContext.configure(connection, opts={"compare_type": True}),
                Base.metadata,
            )
            if differences:
                raise RuntimeError(
                    "Existing database differs from the roleApp baseline. "
                    "Back it up and create a targeted migration before starting the API."
                )
            # Old deployments already have this exact schema. Mark their starting
            # point without recreating tables or discarding player progress.
            command.stamp(config, "head")
    command.upgrade(config, "head")
