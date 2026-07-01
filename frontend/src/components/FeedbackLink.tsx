import { Box } from '@chakra-ui/react';

const feedbackFormUrl = import.meta.env.VITE_FEEDBACK_FORM_URL;

// Floating footer link to the user feedback form. Renders nothing if no
// form URL is configured (see frontend/.env.example).
function FeedbackLink() {
  if (!feedbackFormUrl) {
    return null;
  }

  return (
    <Box
      as="a"
      href={feedbackFormUrl}
      target="_blank"
      rel="noopener noreferrer"
      position="fixed"
      bottom={2}
      right={4}
      zIndex={10}
      fontSize="xs"
      color="gray.500"
      _hover={{ color: 'brand.500', textDecoration: 'underline' }}
    >
      Enjoying the tool? We would love to hear from you!
    </Box>
  );
}

export default FeedbackLink;
