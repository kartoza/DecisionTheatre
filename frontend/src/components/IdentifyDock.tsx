/**
 * The identify results panel's own docking shell -- a Slide/Box wrapper
 * identical in structure to the target editor's and ControlPanel's (see
 * ContentArea.tsx and ControlPanel.tsx), but for identify results, and
 * positioned to sit immediately left of whichever of those is open rather
 * than always flush against the right edge.
 *
 * This is a fourth, independent panel rather than a fourth case merged into
 * the other three: those three are already mutually exclusive with each
 * other (one "slot B"), but identify results now show *alongside* whichever
 * of them is open, not instead of it -- reported: opening the identify tool
 * while the indicator panel was open used to have nowhere to go. Because it
 * shares the same `usePanelWidth()` value as slot B, dragging either
 * panel's own resize handle resizes both sections together, and the two
 * sections read as one panel that got wider rather than two unrelated
 * floating panels that happen to be adjacent.
 */
import { useEffect, useState } from 'react';
import { Box, Slide } from '@chakra-ui/react';
import { usePanelWidth } from '../lib/panelWidth';
import PanelResizeHandle from './PanelResizeHandle';
import IdentifyPanel from './IdentifyPanel';
import type { IdentifyResult, SiteIdentifyResult } from '../types';

export interface IdentifyDockProps {
  identifyResult: IdentifyResult;
  siteIdentifyResult: SiteIdentifyResult;
  onClose: () => void;
  /** Whether the target editor / indicator panel / chart details is open --
   *  identify docks flush right alone, or to the left of that panel. */
  isSlotBOpen: boolean;
}

function IdentifyDock({ identifyResult, siteIdentifyResult, onClose, isSlotBOpen }: IdentifyDockProps) {
  const isOpen = identifyResult !== null || siteIdentifyResult !== null;
  const { width: panelWidth, startResize } = usePanelWidth();

  // Same header-measurement pattern as the other three docked panels (see
  // ContentArea.tsx) -- the header is content-sized, not a fixed height.
  const [headerOffset, setHeaderOffset] = useState(0);
  useEffect(() => {
    const header = document.querySelector('header');
    if (!header) return;
    const apply = () => setHeaderOffset(header.getBoundingClientRect().height);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  const content = identifyResult
    ? {
      title: `Catchment ${identifyResult.catchmentID}`,
      leftLabel: identifyResult.leftLabel,
      rightLabel: identifyResult.rightLabel,
      rows: identifyResult.rows,
      emptyMessage: 'No comparable values available.',
    }
    : siteIdentifyResult
      ? {
        title: 'Site Indicators',
        leftLabel: siteIdentifyResult.leftLabel,
        rightLabel: siteIdentifyResult.rightLabel,
        rows: siteIdentifyResult.rows,
        emptyMessage: 'No indicator values available.',
      }
      : null;

  return (
    <Slide
      direction="right"
      in={isOpen}
      style={{
        zIndex: 15,
        position: 'fixed',
        top: headerOffset,
        // Only reposition while actually open -- Chakra's Slide assumes a
        // `direction="right"` panel rests at `right: 0` for its off-screen
        // transform, same as the other three docked panels. Moving that
        // anchor while closed broke that assumption: the (invisible, no
        // content) closed panel could render over whatever was open
        // underneath it, which read as "chart details shows blank until I
        // also identify a catchment" -- the identify dock, still sitting at
        // the slot-B offset from a previous open, covering it.
        right: isOpen && isSlotBOpen ? panelWidth : 0,
        // Slot B can close (its own collapse button) while identify stays
        // open -- animate over to take its place rather than snapping,
        // same easing as the main content area's margin when a panel
        // opens/closes (App.tsx).
        transition: 'right 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        height: `calc(100% - ${headerOffset}px)`,
        width: 'auto',
      }}
    >
      <Box
        role="region"
        aria-label="Identify results"
        w={{ base: '100vw', md: `${panelWidth}px` }}
        h="100%"
        bg="gray.800"
        color="white"
        borderLeft="1px"
        borderColor="whiteAlpha.200"
        boxShadow="-4px 0 24px rgba(0,0,0,0.35)"
        display="flex"
        flexDirection="column"
        position="relative"
      >
        <PanelResizeHandle onResizeStart={startResize} />
        {content && (
          <IdentifyPanel
            title={content.title}
            leftLabel={content.leftLabel}
            rightLabel={content.rightLabel}
            rows={content.rows}
            emptyMessage={content.emptyMessage}
            onClose={onClose}
          />
        )}
      </Box>
    </Slide>
  );
}

export default IdentifyDock;
