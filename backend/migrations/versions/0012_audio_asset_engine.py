"""associate audio assets with administrator-managed engines"""

import sqlalchemy as sa
from alembic import op

revision = "0012_audio_asset_engine"
down_revision = "0011_sus_play_authorizations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("audio_asset", sa.Column("engine_id", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("audio_asset", "engine_id")
