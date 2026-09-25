"""add one-time SUS play authorizations

Revision ID: 0011_sus_play_authorizations
Revises: 0010_add_calibration_fields
Create Date: 2026-08-31 00:00:00
"""

import sqlalchemy as sa
from alembic import op

revision = "0011_sus_play_authorizations"
down_revision = "0010_add_calibration_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sus_play_authorization",
        sa.Column("id", sa.String(length=64), primary_key=True),
        sa.Column("session_id", sa.Integer(), sa.ForeignKey("respondent_session.id", ondelete="CASCADE"), nullable=False),
        sa.Column("stimulus_id", sa.Integer(), sa.ForeignKey("test_stimulus.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="authorized"),
        sa.Column("created_at", sa.TIMESTAMP(), nullable=False),
        sa.Column("consumed_at", sa.TIMESTAMP(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("sus_play_authorization")