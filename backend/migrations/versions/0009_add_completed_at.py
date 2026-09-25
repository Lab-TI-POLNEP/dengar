"""add completed_at to respondent_session

Revision ID: 0009_add_completed_at
Revises: 0008_sus_ref_transcription_and_play_count
Create Date: 2026-08-30 00:00:00

"""
import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = '0009_add_completed_at'
down_revision = '0008_sus_ref_transcription_and_play_count'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('respondent_session', sa.Column('completed_at', sa.TIMESTAMP(), nullable=True))


def downgrade() -> None:
    op.drop_column('respondent_session', 'completed_at')

