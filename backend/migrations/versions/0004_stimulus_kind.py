"""add kind column to test_stimulus (M5.4)

Revision ID: 0004_stimulus_kind
Revises: 0003_audio_asset
Create Date: 2026-08-28 00:00:00
"""

import sqlalchemy as sa
from alembic import op

revision = "0004_stimulus_kind"
down_revision = "0003_audio_asset"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "test_stimulus",
        sa.Column("kind", sa.String(length=8), nullable=False, server_default="mos"),
    )


def downgrade() -> None:
    op.drop_column("test_stimulus", "kind")
