"""shared/ (skeleton.json, routine.schema.json, example) must match the Python models."""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from typing import Any

import pytest
from helpers import SHARED_DIR
from jsonschema import Draft202012Validator
from pydantic import BaseModel, ValidationError

from app.routine import Keyframe, Move, Routine, Section, Song
from app.skeleton import JOINTS, LEG_JOINTS, MIRROR

SKELETON = json.loads((SHARED_DIR / "skeleton.json").read_text())
SCHEMA = json.loads((SHARED_DIR / "routine.schema.json").read_text())
EXAMPLE = json.loads((SHARED_DIR / "examples" / "routine.example.json").read_text())
VALIDATOR = Draft202012Validator(SCHEMA)


def schema_ok(doc: dict) -> bool:
    return not list(VALIDATOR.iter_errors(doc))


def pydantic_ok(doc: dict) -> bool:
    try:
        Routine.model_validate(doc)
    except ValidationError:
        return False
    return True


# --- skeleton --------------------------------------------------------------------------


def test_joint_order_matches_everywhere() -> None:
    assert len(JOINTS) == 17
    assert SKELETON["joints"] == list(JOINTS) == SCHEMA["$defs"]["joint"]["enum"]


def test_mediapipe_index_covers_all_joints() -> None:
    index = SKELETON["mediapipeIndex"]
    assert list(index) == list(JOINTS)
    values = list(index.values())
    assert len(set(values)) == len(values)
    assert all(isinstance(v, int) and 0 <= v < 33 for v in values)


def test_mirror_matches() -> None:
    assert SKELETON["mirror"] == MIRROR
    assert all(MIRROR[MIRROR[j]] == j for j in JOINTS)


def test_leg_joints_match() -> None:
    assert SKELETON["legJoints"] == list(LEG_JOINTS)


def test_bones_and_limbs_use_known_joints() -> None:
    known = set(JOINTS) | {"mid_hip", "mid_shoulder"}
    assert all(a in JOINTS and b in JOINTS for a, b in SKELETON["bones"])
    assert all(a in known and b in known for a, b in SKELETON["limbs"].values())


# --- routine schema vs Pydantic ------------------------------------------------------------


@pytest.mark.parametrize(
    ("model", "schema_def"),
    [(Routine, None), (Song, "song"), (Section, "section"), (Move, "move"), (Keyframe, "keyframe")],
)
def test_model_fields_match_schema(model: type[BaseModel], schema_def: str | None) -> None:
    node = SCHEMA if schema_def is None else SCHEMA["$defs"][schema_def]
    assert set(model.model_fields) == set(node["properties"])
    required = {name for name, field in model.model_fields.items() if field.is_required()}
    # `version` has a default in Python (it can only be 1) but is required on the wire.
    assert required | ({"version"} if model is Routine else set()) == set(node["required"])


def test_example_validates_both_ways() -> None:
    VALIDATOR.validate(EXAMPLE)
    Routine.model_validate(EXAMPLE)


def test_to_json_dict_round_trips() -> None:
    out = Routine.model_validate(EXAMPLE).to_json_dict()
    assert out == EXAMPLE
    VALIDATOR.validate(out)
    assert Routine.model_validate(out) == Routine.model_validate(EXAMPLE)


def test_to_json_dict_drops_unset_optionals() -> None:
    doc = copy.deepcopy(EXAMPLE)
    doc.pop("meta", None)
    doc["song"].pop("id", None)
    out = Routine.model_validate(doc).to_json_dict()
    assert "meta" not in out and "id" not in out["song"] and "artist" not in out["song"]
    VALIDATOR.validate(out)


def _mutate(fn: Callable[[dict], Any]) -> dict:
    doc = copy.deepcopy(EXAMPLE)
    fn(doc)
    return doc


def _first_pose(doc: dict) -> dict:
    return doc["moves"][0]["keyframes"][0]["pose"]


REJECTED_BY_BOTH = {
    "unknown joint in pose": lambda d: _first_pose(d).update({"l_tail": [0.0, 0.0]}),
    "unknown scored joint": lambda d: d["moves"][0]["scoredJoints"].append("l_tail"),
    "keyframe t > 1": lambda d: d["moves"][0]["keyframes"][-1].update({"t": 1.5}),
    "intensity 6": lambda d: d["moves"][0].update({"intensity": 6}),
    "extra top-level field": lambda d: d.update({"bonus": True}),
    "extra move field": lambda d: d["moves"][0].update({"tempo": 1}),
    "vec2 with 3 numbers": lambda d: _first_pose(d).update({"nose": [0.0, -1.45, 0.0]}),
    "version 2": lambda d: d.update({"version": 2}),
    "bad difficulty": lambda d: d.update({"difficulty": "insane"}),
    "duplicate scored joints": lambda d: d["moves"][0]["scoredJoints"].append(d["moves"][0]["scoredJoints"][0]),
}

REJECTED_BY_PYDANTIC_ONLY = {
    "overlapping moves": lambda d: d["moves"][1].update({"startTime": d["moves"][0]["endTime"] - 0.5}),
    "endTime <= startTime": lambda d: d["moves"][0].update({"endTime": d["moves"][0]["startTime"]}),
    "keyframes not ascending": lambda d: d["moves"][0]["keyframes"].reverse(),
}


@pytest.mark.parametrize("case", list(REJECTED_BY_BOTH))
def test_rejected_by_schema_and_pydantic(case: str) -> None:
    doc = _mutate(REJECTED_BY_BOTH[case])
    assert not schema_ok(doc), f"schema accepted: {case}"
    assert not pydantic_ok(doc), f"pydantic accepted: {case}"


@pytest.mark.parametrize("case", list(REJECTED_BY_PYDANTIC_ONLY))
def test_rejected_by_pydantic_only(case: str) -> None:
    doc = _mutate(REJECTED_BY_PYDANTIC_ONLY[case])
    assert schema_ok(doc), f"schema now catches '{case}': move it to REJECTED_BY_BOTH"
    assert not pydantic_ok(doc), f"pydantic accepted: {case}"


def test_partial_pose_is_allowed() -> None:
    doc = _mutate(lambda d: _first_pose(d).pop("l_ear"))
    assert schema_ok(doc) and pydantic_ok(doc)
