/**
 * One "identify" result -- a catchment click or a site-boundary click --
 * rendered in the right-hand dock instead of a map-anchored popup.
 *
 * The header is a flex sibling of the scrollable body, not a `position:
 * sticky` cell inside a `border-collapse: collapse` table (the old popups'
 * approach) -- that combination is what left a gap above the header as rows
 * scrolled underneath it. A header outside the scroll container can't have
 * that problem: there's nothing for it to scroll relative to.
 */
import { Box, HStack, Table, Thead, Tbody, Tr, Th, Td, Text } from '@chakra-ui/react';
import type { IdentifyRow } from '../types';
import PanelCollapseButton from './PanelCollapseButton';

export interface IdentifyPanelProps {
  title: string;
  leftLabel: string;
  rightLabel: string;
  rows: IdentifyRow[];
  emptyMessage: string;
  onClose: () => void;
}

const TREND_COLOR = { up: '#FC8181', down: '#63B3ED' } as const;

function TrendBar({ delta, trend, trendWidthPx }: Pick<IdentifyRow, 'delta' | 'trend' | 'trendWidthPx'>) {
  return (
    <Box position="relative" width="68px" height="12px">
      <Box
        position="absolute"
        left="50%"
        top="1px"
        bottom="1px"
        width="2px"
        transform="translateX(-1px)"
        borderRadius="full"
        bg="#A0AEC0"
      />
      {delta === null ? (
        <Box position="absolute" left="50%" top="4px" width="4px" height="4px" transform="translateX(-2px)" borderRadius="full" bg="#718096" />
      ) : delta === 0 ? (
        <Box position="absolute" left="50%" top="4px" width="4px" height="4px" transform="translateX(-2px)" borderRadius="full" bg="#A0AEC0" />
      ) : (
        <Box
          position="absolute"
          top="5px"
          height="2px"
          width={`${trendWidthPx}px`}
          borderRadius="full"
          bg={TREND_COLOR[trend as 'up' | 'down']}
          left={delta > 0 ? 'calc(50% + 1px)' : `calc(50% - ${trendWidthPx + 1}px)`}
        />
      )}
    </Box>
  );
}

function IdentifyPanel({ title, leftLabel, rightLabel, rows, emptyMessage, onClose }: IdentifyPanelProps) {
  return (
    <Box h="100%" display="flex" flexDirection="column" minW={0}>
      <HStack px={4} pt={3} pb={2} align="center" spacing={2}>
        <Box fontSize="md" fontWeight="bold" flex="1" noOfLines={1}>{title}</Box>
        <PanelCollapseButton label="Collapse identify results" onClick={onClose} />
      </HStack>

      <Box px={4} pb={4} flex="1" overflowY="auto">
        {rows.length === 0 ? (
          <Text fontSize="sm" color="gray.400">{emptyMessage}</Text>
        ) : (
          <Table variant="simple" size="sm">
            <Thead>
              <Tr>
                <Th color="gray.300" borderColor="whiteAlpha.200">Attribute</Th>
                <Th color="gray.300" borderColor="whiteAlpha.200" isNumeric>{leftLabel}</Th>
                <Th color="gray.300" borderColor="whiteAlpha.200" isNumeric>{rightLabel}</Th>
                <Th color="gray.300" borderColor="whiteAlpha.200">Departure from reference</Th>
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((row) => (
                <Tr key={row.label}>
                  <Td borderColor="whiteAlpha.200">{row.label}</Td>
                  <Td borderColor="whiteAlpha.200" isNumeric>{row.left}</Td>
                  <Td borderColor="whiteAlpha.200" isNumeric>{row.right}</Td>
                  <Td borderColor="whiteAlpha.200">
                    <TrendBar delta={row.delta} trend={row.trend} trendWidthPx={row.trendWidthPx} />
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Box>
    </Box>
  );
}

export default IdentifyPanel;
