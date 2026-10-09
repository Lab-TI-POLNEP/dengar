"""harden SUS play authorization and response protocol

Revision ID: 0014_sus_hardening
Revises: 0013_options_json
Create Date: 2026-10-08 00:00:00
"""

import sqlalchemy as sa
from alembic import op

revision = "0014_sus_hardening"
down_revision = "0013_options_json"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("sus_play_authorization") as batch_op:
        batch_op.alter_column(
            "status",
            existing_type=sa.String(length=16),
            type_=sa.String(length=32),
            existing_nullable=False,
            server_default="ISSUED",
        )
        batch_op.add_column(sa.Column("idempotency_key", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("request_hash", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("expires_at", sa.TIMESTAMP(), nullable=True))
        batch_op.create_unique_constraint(
            "uq_sus_play_auth_session_stimulus_key",
            ["session_id", "stimulus_id", "idempotency_key"],
        )

    op.execute("UPDATE sus_play_authorization SET status = 'ISSUED' WHERE status = 'authorized'")
    op.execute("UPDATE sus_play_authorization SET status = 'RETRIEVAL_STARTED' WHERE status = 'consumed'")

    with op.batch_alter_table("sus_response") as batch_op:
        batch_op.add_column(
            sa.Column(
                "authorization_id",
                sa.String(length=64),
                nullable=True,
            )
        )
        batch_op.create_foreign_key(
            "fk_sus_response_authorization_id",
            "sus_play_authorization",
            ["authorization_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch_op.add_column(sa.Column("idempotency_key", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("request_hash", sa.String(length=64), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("sus_response") as batch_op:
        batch_op.drop_column("request_hash")
        batch_op.drop_column("idempotency_key")
        batch_op.drop_column("authorization_id")

    op.execute("UPDATE sus_play_authorization SET status = 'authorized' WHERE status = 'ISSUED'")
    op.execute("UPDATE sus_play_authorization SET status = 'consumed' WHERE status = 'RETRIEVAL_STARTED'")

    with op.batch_alter_table("sus_play_authorization") as batch_op:
        batch_op.drop_constraint("uq_sus_play_auth_session_stimulus_key", type_="unique")
        batch_op.drop_column("expires_at")
        batch_op.drop_column("request_hash")
        batch_op.drop_column("idempotency_key")
        batch_op.alter_column(
            "status",
            existing_type=sa.String(length=32),
            type_=sa.String(length=16),
            existing_nullable=False,
            server_default="authorized",
        )
