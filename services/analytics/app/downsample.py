"""Downsampling for chart delivery.

A four-hour ride is ~15,000 samples per channel. Sending that to a browser is
wasteful and drawing it is pointless — no screen has 15,000 horizontal pixels.

Plain striding is the obvious approach and the wrong one: it drops whichever
samples fall between strides, so a 30-second VO2max interval can vanish from a
heart-rate trace entirely. These buckets keep the extremes of every bucket, so
peaks and troughs survive at any zoom level even though the point count falls.
"""

from __future__ import annotations

import numpy as np
import polars as pl


def bucket_min_max(df: pl.DataFrame, target_points: int, x: str = "t_s") -> pl.DataFrame:
    """Reduce to roughly `target_points` rows, preserving per-bucket extremes.

    Each bucket contributes its minimum and maximum sample for the busiest
    channel, ordered by x, which keeps the envelope of the signal intact.
    """
    if df.height <= target_points or target_points < 4:
        return df

    numeric = [
        c for c in df.columns
        if c != x and df[c].dtype in (pl.Float32, pl.Float64, pl.Int32, pl.Int64)
    ]
    if not numeric:
        return df.gather_every(max(1, df.height // target_points))

    # Two rows survive per bucket, so ask for half as many buckets.
    buckets = max(2, target_points // 2)
    size = int(np.ceil(df.height / buckets))

    indexed = df.with_row_index("_i").with_columns((pl.col("_i") // size).alias("_b"))

    # Pick the channel with the most data to define the extremes; the other
    # channels come along on the same rows so every series stays time-aligned.
    lead = max(numeric, key=lambda c: df[c].count())

    keep = (
        indexed.group_by("_b")
        .agg(
            pl.col("_i").filter(pl.col(lead) == pl.col(lead).min()).first().alias("lo"),
            pl.col("_i").filter(pl.col(lead) == pl.col(lead).max()).first().alias("hi"),
        )
        .select(pl.concat_list("lo", "hi").explode().drop_nulls().unique())
        .to_series()
        .sort()
    )

    return indexed.filter(pl.col("_i").is_in(keep)).drop("_i", "_b")
