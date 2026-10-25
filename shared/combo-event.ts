// One kept combo (a streak of 8+ Good-or-better checkpoints) as a time-series row. Emitted by
// the web client's combo clipper (web/src/reel/comboClipper.ts) for every kept clip; carries
// numbers only, never video or poses. The backend can store these as time-series data
// (one row per combo, `at` as the time column).

export const COMBO_EVENT_VERSION = 1

export interface ComboEvent {
  version: typeof COMBO_EVENT_VERSION
  /** Wall-clock time the combo ended (ISO 8601): the row's time column. */
  at: string
  /** null until rooms exist (single-player rounds). */
  roomId: string | null
  playerId: string
  /** Analysis id of the song, when known. */
  songId: string | null
  /** Song time (s) the combo is filed under: its first judged checkpoint. */
  songTime: number
  /** Song time range (s) of the kept clip. */
  start: number
  end: number
  /** Checkpoints in the streak. */
  comboLength: number
  /** Mean checkpoint score over the streak, 0..100. */
  avgScore: number
  /** Move-library id of the streak's best-scoring move. */
  bestMoveId: string
  /** Local clip id (the video itself stays on the device). */
  clipId: string
}
