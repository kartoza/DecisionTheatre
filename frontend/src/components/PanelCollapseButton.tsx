/**
 * The collapse/close affordance shared by every docked right-hand panel
 * (control panel, target editor, chart details, identify results). A plain
 * ghost ">" read as an afterthought next to two sections sitting side by
 * side -- a filled circle in the site's own orange, with the chevron in
 * the inverted (dark-on-orange, rather than light-on-transparent) colours
 * that come with that, reads as a deliberate control instead. Still points
 * right, same direction as the plain chevron it replaces.
 */
import { IconButton, Tooltip } from '@chakra-ui/react';
import { FiChevronRight } from 'react-icons/fi';
import { colors } from '../styles/colors';

export interface PanelCollapseButtonProps {
  onClick: () => void;
  label?: string;
  size?: 'sm' | 'md';
}

function PanelCollapseButton({ onClick, label = 'Collapse panel', size = 'sm' }: PanelCollapseButtonProps) {
  return (
    <Tooltip label={label} placement="left">
      <IconButton
        aria-label={label}
        icon={<FiChevronRight />}
        size={size}
        borderRadius="full"
        bg={colors.orange}
        color={colors.dark}
        _hover={{ bg: colors.orangeHover }}
        _active={{ bg: colors.orangeHover }}
        onClick={onClick}
      />
    </Tooltip>
  );
}

export default PanelCollapseButton;
