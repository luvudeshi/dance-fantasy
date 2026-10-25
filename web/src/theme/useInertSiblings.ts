import { useEffect, type RefObject } from 'react'

/**
 * Modal overlays on the play stage: while mounted, every sibling of `ref`'s element (the stage's
 * canvas, top bar icons, other cards) is `inert`, so Tab stays inside the overlay. Restores them on
 * unmount; siblings that were already inert, or that belong with the overlay (`data-overlay-peer`, e.g.
 * the highlight-reel launcher under the results), are left alone.
 */
export function useInertSiblings(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    const others = el?.parentElement ? [...el.parentElement.children].filter((c) => c !== el && !c.hasAttribute('inert') && !c.hasAttribute('data-overlay-peer')) : []
    for (const c of others) c.setAttribute('inert', '')
    return () => {
      for (const c of others) c.removeAttribute('inert')
    }
  }, [ref])
}
