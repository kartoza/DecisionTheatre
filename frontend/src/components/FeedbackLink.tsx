import { Flex, Icon, Text } from '@chakra-ui/react';
import { FiHeart, FiArrowRight } from 'react-icons/fi';
import { colors } from '../styles/colors';

const FEEDBACK_FORM_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSeuKAoitOcZ4bfjEH906qiXKjhcrVUB-cE-QXR39QEfP3XHCA/viewform?usp=header';

const heartbeatSx = {
  '@keyframes feedbackHeartbeat': {
    '0%, 100%': { transform: 'scale(1)' },
    '15%': { transform: 'scale(1.25)' },
    '30%': { transform: 'scale(1)' },
  },
  animation: 'feedbackHeartbeat 3s ease-in-out infinite',
};

/**
 * Persistent footer call-to-action, pinned under every page (see App.tsx) --
 * not scoped to the landing page, so it's visible without scrolling
 * anywhere in the app. Reported three times over: effectively invisible (a
 * single xs, gray.500 line easy to read as decoration); once noticed, a
 * dead "click here" because the URL was read from VITE_FEEDBACK_FORM_URL,
 * a build-time env var this project's build pipeline does not treat as a
 * rebuild trigger (see scripts/lib-build.sh's dt_is_stale), so an edited
 * .env silently kept shipping the old (unconfigured) build; and, simplest
 * of all, there is only one form and no deployment that needs a different
 * one, so the URL is hardcoded rather than reintroducing that whole class
 * of problem for no benefit.
 *
 * Hover effects use nested `&:hover` selectors rather than Chakra's
 * `_groupHover` (which needs `role="group"` on the parent) -- that role
 * would override the anchor's own implicit link role, which is exactly the
 * kind of thing this component should not be doing to itself.
 */
function FeedbackLink() {
  return (
    <Flex
      as="a"
      href={FEEDBACK_FORM_URL}
      target="_blank"
      rel="noopener noreferrer"
      align="center"
      justify="center"
      gap={2.5}
      py={2}
      px={4}
      bg="gray.800"
      borderTop="2px solid"
      borderColor={colors.orange}
      cursor="pointer"
      transition="background-color 0.2s ease"
      sx={{
        '&:hover': { bg: 'whiteAlpha.100' },
        '&:hover .feedback-cta': { color: colors.orangeHover, textDecoration: 'underline' },
        '&:hover .feedback-arrow': { opacity: 1, transform: 'translateX(0)' },
      }}
    >
      <Icon as={FiHeart} boxSize="14px" color={colors.orange} flexShrink={0} sx={heartbeatSx} />
      <Text fontSize="xs" color="whiteAlpha.800" textAlign="center">
        We would love to know more about you and what you think of our tool
        <Text as="span" className="feedback-cta" ml={1} fontWeight="semibold" color={colors.orange} transition="color 0.2s ease">
          - click here...
        </Text>
      </Text>
      <Icon
        as={FiArrowRight}
        className="feedback-arrow"
        boxSize="12px"
        color={colors.orange}
        opacity={0}
        transform="translateX(-4px)"
        transition="all 0.2s ease"
      />
    </Flex>
  );
}

export default FeedbackLink;
