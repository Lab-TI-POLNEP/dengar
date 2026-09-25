"""add reference transcription to audio asset and play count to sus response

Revision ID: 0008_sus_ref_transcription_and_play_count
Revises: 0007_mos_responses
Create Date: 2026-08-30 00:00:00
"""

import sqlalchemy as sa
from alembic import op

revision = "0008_sus_ref_transcription_and_play_count"
down_revision = "0007_mos_responses"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Add reference_transcription to audio_asset table
    op.add_column("audio_asset", sa.Column("reference_transcription", sa.Text(), nullable=True))

    # 2. Add play_count to sus_response table
    op.add_column("sus_response", sa.Column("play_count", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("sus_response", "play_count")
    op.drop_column("audio_asset", "reference_transcription")

