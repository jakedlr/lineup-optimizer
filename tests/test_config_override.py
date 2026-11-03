import json
import shutil
from pathlib import Path

from ppopt import cli
from ppopt.matching import Config, config_file

ROOT = Path(__file__).resolve().parents[1]
FILES = ["payouts.json", "books.json", "stats.json", "teams.json", "aliases.json"]


def root_with_overrides(tmp_path, **overrides):
    for name in FILES:
        shutil.copy(ROOT / name, tmp_path / name)
    (tmp_path / "config").mkdir()
    for name, data in overrides.items():
        (tmp_path / "config" / f"{name}.json").write_text(json.dumps(data))
    return tmp_path


def test_built_in_file_when_there_is_no_override(tmp_path):
    root = root_with_overrides(tmp_path)
    assert config_file(root, "payouts.json") == root / "payouts.json"


def test_override_wins(tmp_path):
    root = root_with_overrides(tmp_path, aliases={"jj mccarthy": "j j mccarthy"})
    assert config_file(root, "aliases.json") == root / "config" / "aliases.json"
    assert Config.load(root).aliases == {"jj mccarthy": "j j mccarthy"}


def test_payout_override_changes_the_engine_and_the_options(tmp_path):
    from fastapi.testclient import TestClient

    from ppopt.web import create_app

    payouts = json.loads((ROOT / "payouts.json").read_text())
    payouts["power"] = {"2": {"2": 3.0}, "3": {"3": 6.0}}  # Power 4-6 removed
    root = root_with_overrides(tmp_path, payouts=payouts)

    opts = TestClient(create_app(static_dir=tmp_path, data_dir=tmp_path / "data", root=root)).get("/api/options").json()
    assert [r for r in opts["ref_slips"] if r.startswith("power")] == ["power2", "power3"]

    from tests.test_cli import NOW, markets, pp_payload

    report = cli.run(cli.parse_args([]), root, pp_payload(), markets(), NOW)
    assert {s["size"] for s in report["slips"] if s["type"] == "power"} <= {2, 3}
