from logging.config import fileConfig
import os
import sys
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.database import Base  # noqa: E402
from models import models  # noqa: F401, E402

config = context.config
if config.config_file_name and config.get_section(config.config_ini_section, {}).get("loggers"):
    fileConfig(config.config_file_name)
config.set_main_option("sqlalchemy.url", os.environ.get("DATABASE_URL", config.get_main_option("sqlalchemy.url")))
target_metadata = Base.metadata


def run_migrations_offline():
    context.configure(url=config.get_main_option("sqlalchemy.url"), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online():
    connectable = engine_from_config(config.get_section(config.config_ini_section), prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
