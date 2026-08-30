# lab

Exploratory analysis over the same data the services use — no ETL, no export step.

Streams are Parquet in object storage, so DuckDB queries them in place. The
`app.*` modules from `services/analytics` import directly, which means anything
worked out here ships to production without a rewrite.

## Setup

```bash
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
```

## Use

```bash
set -a; . ../.env; set +a
./.venv/bin/python explore.py
```

Or open `explore.py` in an editor with an interactive Python console — it is
written as a linear script so it can be run whole or a block at a time.
