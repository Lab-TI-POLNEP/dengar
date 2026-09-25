"""add calibration fields to respondent_session

Revision ID: 0010_add_calibration_fields
Revises: 0009_add_completed_at
Create Date: 2026-08-30 00:00:00
"""
import sqlalchemy as sa
from alembic import op

revision = "0010_add_calibration_fields"
down_revision = "0009_add_completed_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "respondent_session",
        sa.Column("calibration_play_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "respondent_session",
        sa.Column("calibration_completed", sa.Boolean(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("respondent_session", "calibration_completed")
    op.drop_column("respondent_session", "calibration_play_count")
