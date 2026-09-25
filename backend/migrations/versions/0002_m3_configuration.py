"""add M3 test configuration and master data tables"""

import sqlalchemy as sa
from alembic import op

revision = "0002_m3_configuration"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "engine",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("description", sa.Text(), nullable=True),
    )
    op.create_table(
        "sus_sentence",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("reference_transcription", sa.Text(), nullable=False),
    )
    op.create_table(
        "mos_scale_preset",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False, unique=True),
        sa.Column("minimum", sa.Integer(), nullable=False),
        sa.Column("maximum", sa.Integer(), nullable=False),
        sa.Column("labels_json", sa.Text(), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
    )
    op.create_table(
        "demographic_field_def",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("key", sa.String(128), nullable=False, unique=True),
        sa.Column("label", sa.String(255), nullable=False),
        sa.Column("field_type", sa.String(32), nullable=False),
        sa.Column("required", sa.Boolean(), nullable=False),
    )
    op.create_table(
        "text_template",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
    )
    op.create_table(
        "test",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("config_yaml", sa.Text(), nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(), nullable=False),
        sa.Column("updated_at", sa.TIMESTAMP(), nullable=False),
    )
    op.create_table(
        "test_stimulus",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("test_id", sa.Integer(), sa.ForeignKey("test.id", ondelete="CASCADE"), nullable=False),
        sa.Column("neutral_label", sa.String(16), nullable=False),
        sa.Column("engine_id", sa.Integer(), sa.ForeignKey("engine.id"), nullable=False),
        sa.Column("audio_ref", sa.String(255), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("test_stimulus")
    op.drop_table("test")
    op.drop_table("text_template")
    op.drop_table("demographic_field_def")
    op.drop_table("mos_scale_preset")
    op.drop_table("sus_sentence")
    op.drop_table("engine")