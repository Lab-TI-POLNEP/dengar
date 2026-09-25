"""add options_json to demographic_field_def

Revision ID: 0013_options_json
Revises: 0012_audio_asset_engine
Create Date: 2026-09-24 00:00:00

``backend/app/models.py`` declares ``DemographicFieldDef.options_json`` but no
migration ever added it, so a database created with ``alembic upgrade head``
lacked the column while ``Base.metadata.create_all`` created it. This migration
closes that drift; ``backend/tests/test_schema_parity.py`` now guards it.
"""

import sqlalchemy as sa
from alembic import op

revision = "0013_options_json"
down_revision = "0012_audio_asset_engine"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("demographic_field_def", sa.Column("options_json", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("demographic_field_def", "options_json")
