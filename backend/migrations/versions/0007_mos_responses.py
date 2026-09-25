"""add mos response and session status

Revision ID: 0007_mos_responses
Revises: 0006_respondent_sessions
Create Date: 2026-08-30 00:00:00
"""

import sqlalchemy as sa
from alembic import op

revision = "0007_mos_responses"
down_revision = "0006_respondent_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Add status column to respondent_session table
    op.add_column("respondent_session", sa.Column("status", sa.String(length=16), nullable=False, server_default="active"))

    # 2. Create mos_response table
    op.create_table(
        "mos_response",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "session_id",
            sa.Integer(),
            sa.ForeignKey("respondent_session.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "stimulus_id",
            sa.Integer(),
            sa.ForeignKey("test_stimulus.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("rating", sa.Integer(), nullable=False),
        sa.Column("play_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.TIMESTAMP(), nullable=False),
        sa.UniqueConstraint("session_id", "stimulus_id", name="uq_mos_response_session_stimulus"),
    )

    # 3. Create sus_response table
    op.create_table(
        "sus_response",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "session_id",
            sa.Integer(),
            sa.ForeignKey("respondent_session.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "stimulus_id",
            sa.Integer(),
            sa.ForeignKey("test_stimulus.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("raw_transcription", sa.Text(), nullable=True),
        sa.Column("normalized_transcription", sa.Text(), nullable=True),
        sa.Column("wacc", sa.Float(), nullable=True),
        sa.Column("substitutions", sa.Integer(), nullable=True),
        sa.Column("deletions", sa.Integer(), nullable=True),
        sa.Column("insertions", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(), nullable=False),
        sa.UniqueConstraint("session_id", "stimulus_id", name="uq_sus_response_session_stimulus"),
    )


def downgrade() -> None:
    op.drop_table("sus_response")
    op.drop_table("mos_response")
    op.drop_column("respondent_session", "status")

