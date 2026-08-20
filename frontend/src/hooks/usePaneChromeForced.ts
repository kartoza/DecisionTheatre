import { useEffect } from 'react';

/**
 * Keep the pane chrome visible while a guided tour is on screen.
 *
 * Pane controls hide themselves until the pointer is over the pane they act on
 * (see styles/paneChrome.css). Two of them — the compare swiper handle and the
 * pane toolbar — are tour targets, and a spotlight ring drawn around something
 * invisible is worse than no ring at all.
 *
 * Shared by both tour components rather than written twice: they already carry
 * duplicate spotlight implementations, and the override has to agree with the
 * stylesheet's class name in one place, not two.
 */
export function usePaneChromeForced(active: boolean): void {
  useEffect(() => {
    document.body.classList.toggle('dt-tour-active', active);
    return () => document.body.classList.remove('dt-tour-active');
  }, [active]);
}
