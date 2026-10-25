"""Signature dances: famous songs' viral dances, pinned onto the chorus with credit to their creators.

* ``table``   bundled song -> dance table + title normalization (works with no keys)
* ``moves``   the signature move library (assets/moves/signature/, "inspired by" approximations)
* ``search``  SerpApi (Google + YouTube) and Gemini extraction, stdlib urllib only
* ``lookup``  table -> SerpApi -> Gemini, cached on disk for 24 h
* ``pins``    pinned-move helpers for the choreographer (app.choreo.generator)
* ``router``  GET /api/signature/lookup, GET /api/signature/moves
"""
