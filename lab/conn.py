"""Shared connection helpers for the lab.

Wires DuckDB at the same MinIO bucket the services write to, and Postgres at the
same database, so exploration runs against live data rather than a copy.
"""

from __future__ import annotations

import os
from urllib.parse import urlparse

import duckdb


def duck() -> duckdb.DuckDBPyConnection:
    """DuckDB configured to read the activity stream bucket over S3."""
    endpoint = os.getenv("S3_ENDPOINT", "http://localhost:9100")
    parsed = urlparse(endpoint)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute(f"SET s3_endpoint='{parsed.netloc}'")
    con.execute(f"SET s3_use_ssl={'true' if parsed.scheme == 'https' else 'false'}")
    con.execute("SET s3_url_style='path'")
    con.execute(f"SET s3_access_key_id='{os.environ['S3_ACCESS_KEY']}'")
    con.execute(f"SET s3_secret_access_key='{os.environ['S3_SECRET_KEY']}'")
    con.execute(f"SET s3_region='{os.getenv('S3_REGION', 'us-east-1')}'")

    # Attach Postgres so summaries and streams join in one query.
    con.execute("INSTALL postgres; LOAD postgres;")
    con.execute(f"ATTACH '{os.environ['DATABASE_URL']}' AS pg (TYPE postgres, READ_ONLY)")
    return con


def bucket() -> str:
    return os.getenv("S3_BUCKET", "performance-lab")


def streams_glob() -> str:
    """Every activity stream, as a DuckDB-readable path."""
    return f"s3://{bucket()}/streams/*.parquet"
