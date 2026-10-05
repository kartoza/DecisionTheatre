// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useState } from 'react';

/**
 * The application header's live height in pixels.
 *
 * The header is content-sized, not a fixed height, so anything docked
 * beneath it measures it instead of repeating a magic number that goes
 * stale the moment the header's contents change. Shared by the control
 * panel and the collapsed-panel expand chevron so the two agree on the
 * same offset by construction — the chevron sits exactly where the
 * panel's collapse button was (Fitts's law: reopening should not require
 * a mouse journey).
 */
export function useHeaderOffset(): number {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const header = document.querySelector('header');
    if (!header) return;
    const apply = () => setOffset(header.getBoundingClientRect().height);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  return offset;
}
