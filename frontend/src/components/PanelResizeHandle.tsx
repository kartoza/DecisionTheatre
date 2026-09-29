/**
 * The draggable edge of a docked panel.
 *
 * A strip on the panel's left border. It is deliberately wider than it looks —
 * a 1px border is a target nobody can hit — and it only appears from the medium
 * breakpoint up, because below that the panel is the full width of the window
 * and there is nothing to drag it to.
 */
import { Box } from '@chakra-ui/react';

export interface PanelResizeHandleProps {
  onResizeStart: (event: { clientX: number; preventDefault: () => void }) => void;
}

function PanelResizeHandle({ onResizeStart }: PanelResizeHandleProps) {
  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      display={{ base: 'none', md: 'block' }}
      position="absolute"
      left={0}
      top={0}
      bottom={0}
      width="6px"
      cursor="col-resize"
      zIndex={20}
      onMouseDown={onResizeStart}
      _hover={{ bg: 'cyan.400' }}
      transition="background 0.15s ease"
    />
  );
}

export default PanelResizeHandle;
