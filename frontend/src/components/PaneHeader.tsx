/**
 * The band across the top of a pane: scenario, factor, scenario.
 *
 * Cycling map → belt → dial → table should change what is *drawn in* the pane,
 * not the frame around it. Before this, each view mode titled itself its own
 * way — the map with three positioned labels, the dial with text inside its
 * SVG, the table with a 2xl heading over a subtitle and a badge — so every
 * switch moved and restyled the one part that should have stayed put.
 *
 * The map's arrangement is the one adopted, because it was the only one that
 * already said all three things at once. Its styling is reproduced here to the
 * pixel; the map keeps drawing its own, since those are tied to the swiper and
 * hide when it docks, and two would be one too many.
 *
 * Scenario labels shrink and ellipsise. The factor does not: it names what the
 * pane is showing, and a grid of six unlabelled charts is the thing worth
 * avoiding.
 */
import { Box } from '@chakra-ui/react';

export interface PaneHeaderProps {
  /** The factor being shown. Centred, and the only label worth reading across a room. */
  title?: string;
  /** Left scenario, with its accent facing inward. Omitted when there is none. */
  leftLabel?: string;
  leftColor?: string;
  /** Right scenario. Omitted for views that show a single scenario. */
  rightLabel?: string;
  rightColor?: string;
  compact?: boolean;
}

function PaneHeader({
  title,
  leftLabel,
  leftColor,
  rightLabel,
  rightColor,
  compact = false,
}: PaneHeaderProps) {
  if (!title && !leftLabel && !rightLabel) return null;
  return (
    <>
      {leftLabel && (
        <Box
          position="absolute"
          top={0}
          left={0}
          zIndex={6}
          maxW="34%"
          bg="blackAlpha.700"
          color="gray.200"
          px={2}
          py={1}
          borderRadius="0 0 10px 0"
          // Inward-facing, like the map's: against the pane frame it would read
          // as part of the frame rather than as the scenario's colour.
          borderRight="3px solid"
          borderColor={leftColor || 'whiteAlpha.400'}
          fontSize="2xs"
          fontWeight="600"
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
          backdropFilter="blur(8px)"
          pointerEvents="none"
        >
          {leftLabel}
        </Box>
      )}

      {title && (
        <Box
          position="absolute"
          top={0}
          left="50%"
          transform="translateX(-50%)"
          zIndex={7}
          maxW="60%"
          bg="blackAlpha.800"
          color="white"
          px={4}
          py={1.5}
          borderRadius="0 0 10px 10px"
          fontSize={compact ? 'xs' : 'sm'}
          fontWeight="700"
          letterSpacing="0.5px"
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
          backdropFilter="blur(8px)"
          pointerEvents="none"
        >
          {title}
        </Box>
      )}

      {rightLabel && (
        <Box
          position="absolute"
          top={0}
          right={0}
          zIndex={6}
          maxW="34%"
          bg="blackAlpha.700"
          color="gray.200"
          px={2}
          py={1}
          borderRadius="0 0 0 10px"
          borderLeft="3px solid"
          borderColor={rightColor || 'whiteAlpha.400'}
          fontSize="2xs"
          fontWeight="600"
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
          backdropFilter="blur(8px)"
          pointerEvents="none"
        >
          {rightLabel}
        </Box>
      )}
    </>
  );
}

export default PaneHeader;
