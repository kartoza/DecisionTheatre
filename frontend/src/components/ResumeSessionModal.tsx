import { Box, Button, Flex, Heading, Text, VStack, Icon } from '@chakra-ui/react';
import { FiClock, FiHome } from 'react-icons/fi';
import type { AppPage } from '../types';

interface ResumeSessionModalProps {
  savedPage: AppPage;
  hasSite: boolean;
  onResume: () => void;
  onStartFresh: () => void;
}

const PAGE_LABELS: Partial<Record<AppPage, string>> = {
  map: 'your map view',
  explore: 'explore mode',
  indicators: 'the indicator editor',
  sites: 'your sites',
  'create-site': 'creating a site',
};

function describeSavedSession(savedPage: AppPage, hasSite: boolean): string {
  if (hasSite) return 'You had a site open';
  return `You were in ${PAGE_LABELS[savedPage] ?? 'the app'}`;
}

export default function ResumeSessionModal({ savedPage, hasSite, onResume, onStartFresh }: ResumeSessionModalProps) {
  return (
    <Flex
      position="relative"
      align="center"
      justify="center"
      minH="100vh"
      bg="gray.900"
      color="white"
      p={8}
    >
      <Box maxW="480px" w="full">
        <VStack spacing={6} align="stretch">
          <Box textAlign="center">
            <Heading size="lg" mb={2}>
              Welcome back
            </Heading>
            <Text color="gray.400">
              {describeSavedSession(savedPage, hasSite)} from your last visit.
            </Text>
          </Box>

          <VStack spacing={3} align="stretch">
            <Button
              size="lg"
              colorScheme="blue"
              leftIcon={<Icon as={FiClock} />}
              onClick={onResume}
            >
              Continue where I left off
            </Button>
            <Button
              size="lg"
              variant="outline"
              colorScheme="whiteAlpha"
              color="gray.200"
              leftIcon={<Icon as={FiHome} />}
              onClick={onStartFresh}
            >
              Go to home page
            </Button>
          </VStack>
        </VStack>
      </Box>
    </Flex>
  );
}
