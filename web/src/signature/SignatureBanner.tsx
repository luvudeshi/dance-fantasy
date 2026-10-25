// In-game banner while a signature move plays: "★ SIGNATURE: <dance>, created by <creator>"
// (or "inspired by <dance>"), with a 2x points badge. Polls the song clock each frame.

import { useEffect, useState } from 'react'
import type { Routine } from '@shared/routine'
import { bannerText, inspiredBy, SIGNATURE_MULTIPLIER, signatureAt } from './dances'
import './dances.css'

export function SignatureBanner({ routine, songTime }: { routine: Pick<Routine, 'moves'>; songTime: () => number }) {
  const [index, setIndex] = useState(-1)
  const hasSignature = routine.moves.some((m) => m.signatureDance)

  useEffect(() => {
    if (!hasSignature) return
    let raf = 0
    const tick = (): void => {
      const m = signatureAt(routine, songTime())
      setIndex(m ? routine.moves.indexOf(m) : -1)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [routine, songTime, hasSignature])

  const sd = index >= 0 ? routine.moves[index]?.signatureDance : undefined
  if (!sd) return null
  return (
    <div className="mb-sig-banner" role="status" aria-live="polite">
      <span className="mb-sig-banner-text">{bannerText(sd)}</span>
      <span className="mb-sig-banner-badge">{SIGNATURE_MULTIPLIER}× points</span>
      {sd.creator && <span className="mb-sig-banner-sub">our move is {inspiredBy(sd.name)}</span>}
    </div>
  )
}
