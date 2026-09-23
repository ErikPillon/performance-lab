"""S3-compatible object storage.

Targets MinIO locally and real S3 / Cloudflare R2 in production with no code
change — only the four env vars differ.
"""

from __future__ import annotations

import io
import os
from functools import lru_cache

import boto3
import polars as pl
from botocore.client import Config


@lru_cache(maxsize=1)
def _client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["S3_SECRET_KEY"],
        region_name=os.getenv("S3_REGION", "us-east-1"),
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def bucket() -> str:
    return os.getenv("S3_BUCKET", "performance-lab")


def get_bytes(key: str) -> bytes:
    return _client().get_object(Bucket=bucket(), Key=key)["Body"].read()


def put_parquet(key: str, df: pl.DataFrame) -> int:
    """Write a frame as Parquet. Returns the number of bytes stored.

    zstd because these are write-once/read-many and typically compress 8-12x on
    per-second sensor data; the extra CPU is paid once at ingest.
    """
    buf = io.BytesIO()
    df.write_parquet(buf, compression="zstd", statistics=True)
    payload = buf.getvalue()
    _client().put_object(
        Bucket=bucket(), Key=key, Body=payload, ContentType="application/vnd.apache.parquet"
    )
    return len(payload)


def get_parquet(key: str) -> pl.DataFrame:
    """Read a stream file back out of object storage."""
    return pl.read_parquet(io.BytesIO(get_bytes(key)))


def put_bytes(key: str, payload: bytes, content_type: str) -> None:
    _client().put_object(Bucket=bucket(), Key=key, Body=payload, ContentType=content_type)


def get_bytes_if_fresh(key: str, max_age_s: float) -> bytes | None:
    """An object's bytes, or None when it is missing or older than `max_age_s`.

    Used for caches of third-party data: a miss and a stale entry are the same
    thing to the caller, which fetches again either way.
    """
    import datetime as dt

    from botocore.exceptions import ClientError

    try:
        obj = _client().get_object(Bucket=bucket(), Key=key)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            return None
        raise
    age = (dt.datetime.now(dt.timezone.utc) - obj["LastModified"]).total_seconds()
    if age > max_age_s:
        return None
    return obj["Body"].read()
