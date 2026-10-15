// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The collapse/close affordance shared by every docked right-hand panel
 * (control panel, target editor, chart details, identify results). A plain
 * ghost ">" read as an afterthought next to two sections sitting side by
 * side -- a filled circle in the site's own orange, with a white chevron
 * (matching every other white-on-orange control in the chrome), reads as a
 * deliberate control instead. Still points right, same direction as the
 * plain chevron it replaces.
 */
import { IconButton, Tooltip } from '@chakra-ui/react';
import { FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import type { ReactElement } from 'react';
import { colors } from '../styles/colors';

export interface PanelCollapseButtonProps {
  onClick: () => void;
  label?: string;
  size?: 'sm' | 'md';
}

// One styled control, two directions: the collapse chevron inside an open
// panel and the expand chevron left at the screen edge when it is closed
// are the same affordance, so they must look identical or the pair stops
// reading as open/close of one thing.
function chevronButton(
  { onClick, label, size = 'sm' }: Required<Pick<PanelCollapseButtonProps, 'onClick' | 'label'>> & Pick<PanelCollapseButtonProps, 'size'>,
  icon: ReactElement,
) {
  return (
    <Tooltip label={label} placement="left">
      <IconButton
        aria-label={label}
        icon={icon}
        size={size}
        borderRadius="full"
        bg={colors.orange}
        color="white"
        _hover={{ bg: colors.orangeHover }}
        _active={{ bg: colors.orangeHover }}
        onClick={onClick}
      />
    </Tooltip>
  );
}

function PanelCollapseButton({ onClick, label = 'Collapse panel', size = 'sm' }: PanelCollapseButtonProps) {
  return chevronButton({ onClick, label, size }, <FiChevronRight />);
}

/** The way back: shown at the screen edge while the panel is collapsed. */
export function PanelExpandButton({ onClick, label = 'Expand panel', size = 'sm' }: PanelCollapseButtonProps) {
  return chevronButton({ onClick, label, size }, <FiChevronLeft />);
}

export default PanelCollapseButton;
