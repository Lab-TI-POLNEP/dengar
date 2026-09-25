"""add audio asset table (M4.1)

Revision ID: 0003_audio_asset
Revises: 0002_m3_configuration
Create Date: 2026-08-27 00:00:00
"""

import sqlalchemy as sa
from alembic import op

revision = "0003_audio_asset"
down_revision = "0002_m3_configuration"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "audio_asset",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("stored_filename", sa.String(length=255), nullable=False, unique=True),
        sa.Column("content_type", sa.String(length=128), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=False), nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=False), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("audio_asset")
