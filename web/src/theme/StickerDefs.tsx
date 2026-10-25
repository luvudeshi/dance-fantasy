// The SVG filters behind the whole look (ported from Body Double), mounted once in main.tsx.
// #dc / #dc-sm / #dc-lg: die-cut sticker (warm white border + soft shadow), sized for small to large pieces.
// #dc-type: the same cut around display lettering. #foil: embossed antique-gold foil for night glass.
// ponytail: SVG filters are GPU-cheap on desktop but cost on old phones; if a phone stutters, drop #foil first.

type CutProps = { id: string; dilate: number; blur: number; shadowBlur: number; dy: number; opacity?: number }

function Cut({ id, dilate, blur, shadowBlur, dy, opacity = 0.32 }: CutProps) {
  return (
    <filter id={id} x="-30%" y="-30%" width="160%" height="160%" colorInterpolationFilters="sRGB">
      <feMorphology in="SourceAlpha" operator="dilate" radius={dilate} result="d1" />
      <feGaussianBlur in="d1" stdDeviation={blur} />
      <feComponentTransfer result="cut">
        <feFuncA type="linear" slope="9" intercept="-2.2" />
      </feComponentTransfer>
      <feFlood floodColor="#fffaf0" />
      <feComposite in2="cut" operator="in" result="border" />
      <feGaussianBlur in="cut" stdDeviation={shadowBlur} />
      <feOffset dx={dy / 3} dy={dy} result="so" />
      <feFlood floodColor="#4a3220" floodOpacity={opacity} />
      <feComposite in2="so" operator="in" result="shadow" />
      <feMerge>
        <feMergeNode in="shadow" />
        <feMergeNode in="border" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  )
}

export function StickerDefs() {
  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" style={{ position: 'absolute' }}>
      <Cut id="dc" dilate={4} blur={2.4} shadowBlur={3.4} dy={4.5} />
      <Cut id="dc-sm" dilate={2.4} blur={1.2} shadowBlur={1.8} dy={2.2} />
      <Cut id="dc-lg" dilate={6} blur={3} shadowBlur={6} dy={8} opacity={0.3} />
      <Cut id="dc-type" dilate={5} blur={2.6} shadowBlur={4} dy={6} opacity={0.28} />
      <filter id="foil" x="-6%" y="-12%" width="112%" height="124%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency=".012 .05" numOctaves="2" seed="5" result="streak" />
        <feColorMatrix in="streak" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1.6 -.55" result="streakA" />
        <feFlood floodColor="#9c7428" />
        <feComposite in2="streakA" operator="in" result="tarnish" />
        <feComposite in="tarnish" in2="SourceAlpha" operator="in" result="tarnishIn" />
        <feMerge result="base">
          <feMergeNode in="SourceGraphic" />
          <feMergeNode in="tarnishIn" />
        </feMerge>
        <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="11" result="grain" />
        <feGaussianBlur in="SourceAlpha" stdDeviation="2.4" result="soft" />
        <feComposite in="soft" in2="grain" operator="arithmetic" k1="0" k2="1" k3=".1" k4="0" result="bump" />
        <feSpecularLighting in="bump" surfaceScale="6" specularConstant="1.1" specularExponent="16" lightingColor="#fff2c8" result="spec">
          <feDistantLight azimuth="225" elevation="40" />
        </feSpecularLighting>
        <feComposite in="spec" in2="SourceAlpha" operator="in" result="sheen" />
        <feComposite in="base" in2="sheen" operator="arithmetic" k1="0" k2="1" k3=".7" k4="0" />
      </filter>
    </svg>
  )
}
