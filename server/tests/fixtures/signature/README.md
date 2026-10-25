Sample payloads for `tests/test_signature.py`. No API keys were available when these were written, so they are
hand-built in the response shapes documented by SerpApi (Google: `organic_results`, `inline_videos`; YouTube:
`video_results` with `thumbnail.static`, `channel`) and Gemini `generateContent` (`candidates[].content.parts[].text`),
trimmed to the fields we read. Video URLs are placeholders (`EXAMPLE…`), not real videos. Any `api_key` in
`search_metadata` / `search_parameters` was replaced with `"REDACTED"`. To refresh them with real responses,
save the JSON SerpApi returns and strip `api_key` everywhere.
