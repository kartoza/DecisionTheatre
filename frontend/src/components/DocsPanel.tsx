import { useRef, useState, useCallback } from 'react';
import { Box, IconButton, useColorModeValue } from '@chakra-ui/react';
import { FiX } from 'react-icons/fi';

interface DocsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const MIN_WIDTH = 300;
const MAX_WIDTH_RATIO = 0.85;

function DocsPanel({ isOpen, onClose }: DocsPanelProps) {
  const bgColor = useColorModeValue('white', 'gray.800');
  const borderColor = useColorModeValue('gray.200', 'gray.700');
  const handleColor = useColorModeValue('gray.400', 'gray.500');
  const handleHoverColor = useColorModeValue('brand.500', 'brand.400');

  const [width, setWidth] = useState<number | null>(null);
  const isDragging = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Disable iframe pointer events during drag so mouse events aren't swallowed
  const setIframePointerEvents = useCallback((enabled: boolean) => {
    const iframe = panelRef.current?.querySelector('iframe');
    if (iframe) {
      iframe.style.pointerEvents = enabled ? 'auto' : 'none';
    }
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    isDragging.current = true;
    setIframePointerEvents(false);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [setIframePointerEvents]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const maxWidth = window.innerWidth * MAX_WIDTH_RATIO;
    const newWidth = Math.max(MIN_WIDTH, Math.min(window.innerWidth - e.clientX, maxWidth));
    setWidth(newWidth);
  }, []);

  const onPointerUp = useCallback(() => {
    isDragging.current = false;
    setIframePointerEvents(true);
  }, [setIframePointerEvents]);

  const widthStyle = width ? `${width}px` : undefined;

  return (
    <Box
      ref={panelRef}
      position="fixed"
      top={0}
      right={0}
      bottom={0}
      w={widthStyle || { base: '100vw', md: '50vw', lg: '45vw' }}
      bg={bgColor}
      borderLeft="1px"
      borderColor={borderColor}
      zIndex={30}
      transform={isOpen ? 'translateX(0)' : 'translateX(100%)'}
      transition={isDragging.current ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)'}
      boxShadow={isOpen ? '-4px 0 12px rgba(0,0,0,0.3)' : 'none'}
      display="flex"
      flexDirection="column"
    >
      {/* Drag handle on the left edge */}
      <Box
        position="absolute"
        top={0}
        left={0}
        bottom={0}
        w="6px"
        cursor="ew-resize"
        zIndex={32}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        _hover={{ '& > div': { bg: handleHoverColor, opacity: 1 } }}
      >
        <Box
          position="absolute"
          top="50%"
          left="50%"
          transform="translate(-50%, -50%)"
          w="4px"
          h="48px"
          borderRadius="full"
          bg={handleColor}
          opacity={0.5}
          transition="opacity 0.2s, background 0.2s"
        />
      </Box>

      {/* Close bar */}
      <Box
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        px={4}
        py={2}
        borderBottom="1px"
        borderColor={borderColor}
        flexShrink={0}
        bg={bgColor}
      >
        <Box fontSize="sm" fontWeight="600" color="gray.400">
          Documentation
        </Box>
        <IconButton
          aria-label="Close documentation"
          icon={<FiX />}
          onClick={onClose}
          size="sm"
          variant="solid"
          colorScheme="brand"
        />
      </Box>

      {/* iframe stays mounted so it preserves navigation state */}
      <Box
        as="iframe"
        src="/docs/"
        title="Documentation"
        w="100%"
        h="100%"
        border="none"
        flex={1}
      />
    </Box>
  );
}

export default DocsPanel;
