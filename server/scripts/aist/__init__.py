"""AIST++ -> real-dancer move clips (assets/moves/aist_clips.json).

Pipeline modules (importable; the CLI is build_clips.py):
  safe_load   restricted unpickler for the AIST++ .pkl keypoint files (numpy arrays only)
  project     3D world keypoints -> our 2D body frame (+ root offset) for a window
  tempo       tempo + beat phase estimated from the motion itself
  segment     beat-aligned candidate windows, half-beat keyframes
  filters     quality filters (floor work, turns, jitter, limb lengths, static/chaotic, travel, collapsed arms)
  tags        intensity / difficulty / scored joints / names
  selection   diverse, well-connected subset per genre
  export      clip-file contract (version 1) writer + validator
  render      SVG contact sheets for visual QA
"""
