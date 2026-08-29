import pathlib
import warnings

import pytest

CORPUS = pathlib.Path(__file__).resolve().parents[3] / "inputs"

# fitparse still calls utcfromtimestamp internally; not actionable here and it
# otherwise emits millions of warnings across a full-corpus run.
warnings.filterwarnings("ignore", category=DeprecationWarning, module="fitparse.*")


@pytest.fixture(scope="session")
def corpus() -> list[pathlib.Path]:
    """The local FIT corpus. Tests needing it skip when it is absent.

    These files are personal training data and are deliberately not committed,
    so this behaves as an integration suite on a developer machine and no-ops
    in CI until an anonymised fixture set exists.
    """
    if not CORPUS.is_dir():
        pytest.skip(f"no FIT corpus at {CORPUS}")
    files = sorted(CORPUS.glob("*.fit"))
    if not files:
        pytest.skip("FIT corpus is empty")
    return files


@pytest.fixture(scope="session")
def parsed(corpus):
    """Parse the corpus exactly once for the whole session.

    Decoding is ~140 ms/file, so re-parsing per test turned a 35 s suite into
    5+ minutes. Returns [(path, summary, frame)] and reports parse failures as
    a first-class result rather than an exception.
    """
    from app.fit import parse_fit

    results, failures = [], []
    for path in corpus:
        try:
            summary, frame = parse_fit(path.read_bytes())
            results.append((path, summary, frame))
        except Exception as exc:  # noqa: BLE001 - collected and asserted on
            failures.append(f"{path.name}: {type(exc).__name__}: {exc}")
    return results, failures
