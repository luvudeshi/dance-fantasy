"""Song analysis models (Stage 1 API responses).

Hand-written to match shared/analysis.schema.json and shared/analysis.ts; change all three
together (tests/test_analyze_api.py checks the fields and validates responses against the
schema). Field names are camelCase so the JSON is identical on both sides of the stack.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.routine import Section, Song

ID_PATTERN = r"^[0-9a-f]{64}$"

SectionLabel = Literal["intro", "verse", "chorus", "bridge", "outro"]
NonNegFloat = Annotated[float, Field(ge=0)]
UnitFloat = Annotated[float, Field(ge=0, le=1)]
NonNegInt = Annotated[int, Field(ge=0)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class AnalysisSection(_Strict):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    label: SectionLabel
    energy: float = Field(ge=0, le=1)
    group: str = Field(pattern=r"^[A-Z]$")
    startBeat: int = Field(ge=0)
    endBeat: int = Field(ge=0)  # exclusive
    bars: int = Field(ge=0)


class AnalysisSource(_Strict):
    kind: Literal["library", "upload"]
    file: str | None = None


class OnsetEnvelope(_Strict):
    hopSec: float = Field(gt=0)
    values: list[UnitFloat]


class Analysis(_Strict):
    id: str = Field(pattern=ID_PATTERN)
    analysisVersion: int = Field(ge=1)
    title: str
    artist: str | None = None
    source: AnalysisSource
    audioUrl: str
    durationSec: float = Field(ge=0)
    sampleRate: int = Field(ge=1)
    bpm: float = Field(ge=0)
    beatsPerBar: Literal[4]
    beats: list[NonNegFloat]
    filledBeats: list[NonNegInt]
    downbeats: list[NonNegFloat]
    downbeatPhase: int = Field(ge=0, le=3)
    onsetEnvelope: OnsetEnvelope
    beatEnergy: list[UnitFloat]
    sections: list[AnalysisSection]
    elapsedMs: float = Field(ge=0)
    cached: bool

    def to_json_dict(self) -> dict[str, Any]:
        """Serialize for the wire / disk. Omits unset optionals so the output validates against the schema."""
        return self.model_dump(mode="json", exclude_none=True)


def song_from_analysis(analysis: Analysis) -> Song:
    """The ``song`` block of a routine: id, title, artist, durationSec, bpm, beats, downbeats, sections."""
    return Song(
        id=analysis.id,
        title=analysis.title,
        artist=analysis.artist,
        durationSec=analysis.durationSec,
        bpm=analysis.bpm,
        beats=list(analysis.beats),
        downbeats=list(analysis.downbeats),
        sections=[Section(start=s.start, end=s.end, label=s.label, energy=s.energy) for s in analysis.sections],
    )
