import { useMemo } from 'react'
import { encode } from 'uqr'

/** A QR code as one SVG path in ink on die-cut cream (never pure white); scales to its box. */
export default function Qr({ text, label }: { text: string; label: string }) {
  const { size, d } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 2 })
    let path = ''
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) path += `M${x} ${y}h1v1h-1z`
      }),
    )
    return { size: qr.size, d: path }
  }, [text])
  return (
    <svg className="rm-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="var(--df-cut)" />
      <path d={d} fill="var(--df-ink)" />
    </svg>
  )
}
