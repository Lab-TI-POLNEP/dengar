"""add test_demographic_field and seed demographic_field_def

Revision ID: 0005_test_demographics
Revises: 0004_stimulus_kind
Create Date: 2026-08-29 00:00:00
"""

import sqlalchemy as sa
from alembic import op

revision = "0005_test_demographics"
down_revision = "0004_stimulus_kind"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Create test_demographic_field table
    op.create_table(
        "test_demographic_field",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "test_id",
            sa.Integer(),
            sa.ForeignKey("test.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "field_key",
            sa.String(128),
            sa.ForeignKey("demographic_field_def.key", ondelete="CASCADE"),
            nullable=False,
        ),
    )

    # 2. Seed demographic_field_def idempotently
    conn = op.get_bind()
    res = conn.execute(sa.text("SELECT key FROM demographic_field_def")).fetchall()
    existing_keys = {row[0] for row in res}

    default_fields = [
        {"key": "age", "label": "Age range", "field_type": "text", "required": False},
        {"key": "gender", "label": "Gender", "field_type": "text", "required": False},
        {"key": "native_speaker", "label": "Native speaker of Indonesian", "field_type": "text", "required": False},
        {"key": "normal_hearing", "label": "Normal hearing status", "field_type": "text", "required": False},
        {"key": "experience", "label": "Previous experience with audio/TTS evaluation", "field_type": "text", "required": False},
    ]

    demographic_field_def = sa.table(
        "demographic_field_def",
        sa.column("key", sa.String),
        sa.column("label", sa.String),
        sa.column("field_type", sa.String),
        sa.column("required", sa.Boolean),
    )

    fields_to_insert = [f for f in default_fields if f["key"] not in existing_keys]
    if fields_to_insert:
        op.bulk_insert(demographic_field_def, fields_to_insert)


def downgrade() -> None:
    op.drop_table("test_demographic_field")

