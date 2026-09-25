"""add access_code and respondent session tables

Revision ID: 0006_respondent_sessions
Revises: 0005_test_demographics
Create Date: 2026-08-30 00:00:00
"""

import sqlalchemy as sa
from alembic import op

revision = "0006_respondent_sessions"
down_revision = "0005_test_demographics"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Add access_code column to test table
    op.add_column("test", sa.Column("access_code", sa.String(length=6), nullable=True))
    op.create_index("ix_test_access_code", "test", ["access_code"], unique=True)

    # 2. Create respondent_session table
    op.create_table(
        "respondent_session",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "test_id",
            sa.Integer(),
            sa.ForeignKey("test.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token", sa.String(length=64), nullable=False),
        sa.Column("random_seed", sa.Integer(), nullable=False),
        sa.Column("consent_accepted", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(), nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(), nullable=False),
        sa.UniqueConstraint("token", name="uq_respondent_session_token"),
    )

    # 3. Create respondent_demographic_response table
    op.create_table(
        "respondent_demographic_response",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "session_id",
            sa.Integer(),
            sa.ForeignKey("respondent_session.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("field_key", sa.String(length=128), nullable=False),
        sa.Column("value", sa.Text(), nullable=True),
    )

    # 4. Create respondent_stimulus_order table
    op.create_table(
        "respondent_stimulus_order",
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
        sa.Column("position", sa.Integer(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("respondent_stimulus_order")
    op.drop_table("respondent_demographic_response")
    op.drop_table("respondent_session")
    op.drop_index("ix_test_access_code", table_name="test")
    op.drop_column("test", "access_code")

