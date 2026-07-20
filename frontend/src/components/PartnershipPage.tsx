import { Box, Button, Container, Heading, Text, VStack } from '@chakra-ui/react';
import { motion } from 'framer-motion';
import { FiArrowLeft } from 'react-icons/fi';
import { colors } from '../styles/colors';
import type { AppPage } from '../types';

const MotionBox = motion(Box);

interface PartnershipPageProps {
  onNavigate: (page: AppPage) => void;
}

interface SectionProps {
  title: string;
  body: string;
  delay: number;
}

function Section({ title, body, delay }: SectionProps) {
  return (
    <MotionBox
      bg="whiteAlpha.50"
      borderRadius="2xl"
      p={{ base: 6, md: 10 }}
      border="1px solid"
      borderColor="whiteAlpha.200"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay }}
    >
      <Heading size="lg" color="white" mb={4}>
        {title}
      </Heading>
      <Text color="whiteAlpha.800" fontSize="md" lineHeight="tall">
        {body}
      </Text>
    </MotionBox>
  );
}

function PartnershipPage({ onNavigate }: PartnershipPageProps) {
  const sections: SectionProps[] = [
    {
      title: 'Rewild Capital',
      body:
        'A nature-based carbon project developer focused on restoring African landscapes through innovative conservation finance. By combining ecological science, carbon markets, and technology, Rewild Capital delivers high-integrity projects that enhance biodiversity, strengthen ecosystem resilience, sequester carbon, and create lasting benefits for local communities.',
      delay: 0.2,
    },
    {
      title: 'Future Ecosystems for Africa',
      body:
        'Future Ecosystems for Africa (FEFA) advances African-led research at the intersection of conservation and development. Through interdisciplinary collaboration, FEFA generates knowledge, harnesses African data and expertise, and develops tools that support informed decision-making for resilient ecosystems and sustainable futures.',
      delay: 0.3,
    },
    {
      title: 'ReWild Capital and FEFA Collaboration',
      body:
        "The Landscape Decision Dashboard brings together Rewild Capital's expertise in nature-based carbon project development with FEFA's leadership in ecosystem, rangeland, and climate science. Together, the partnership empowers evidence-based decision-making that supports context-specific ecosystem restoration, sustainable land management, and resilient livelihoods across African landscapes.",
      delay: 0.4,
    },
  ];

  return (
    <Box bg={colors.darkGray} w="100%" minH="100%">
      <Container maxW="container.md" pt={8} pb={16}>
        <MotionBox
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4 }}
        >
          <Button
            variant="ghost"
            color="white"
            leftIcon={<FiArrowLeft />}
            onClick={() => onNavigate('landing')}
            mb={8}
            _hover={{ bg: 'whiteAlpha.200' }}
          >
            Back to Home
          </Button>
        </MotionBox>

        <MotionBox
          textAlign="center"
          mb={12}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <Heading as="h1" fontSize={{ base: '3xl', md: '4xl' }} color="white" fontWeight="bold">
            The FEFA and Rewild Capital Partnership
          </Heading>
        </MotionBox>

        <VStack spacing={6} align="stretch">
          {sections.map((section) => (
            <Section key={section.title} {...section} />
          ))}
        </VStack>
      </Container>
    </Box>
  );
}

export default PartnershipPage;
