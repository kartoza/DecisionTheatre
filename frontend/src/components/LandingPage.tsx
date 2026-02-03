import {
  Box,
  Button,
  Flex,
  Heading,
  Text,
  VStack,
  useColorModeValue,
} from '@chakra-ui/react';
import { motion } from 'framer-motion';
import { FiInfo, FiFolderPlus } from 'react-icons/fi';
import type { AppPage } from '../types';

const MotionBox = motion(Box);
const MotionVStack = motion(VStack);

interface LandingPageProps {
  onNavigate: (page: AppPage) => void;
}

function LandingPage({ onNavigate }: LandingPageProps) {
  const overlayBg = useColorModeValue(
    'linear-gradient(135deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.6) 100%)',
    'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.7) 100%)'
  );
  const cardBg = useColorModeValue(
    'rgba(255,255,255,0.1)',
    'rgba(0,0,0,0.3)'
  );

  return (
    <Box
      position="relative"
      w="100%"
      h="100%"
      overflow="hidden"
    >
      {/* Background landscape image */}
      <Box
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        backgroundImage="url('https://images.unsplash.com/photo-1506905925346-21bda4d32df4?auto=format&fit=crop&w=2000&q=80')"
        backgroundSize="cover"
        backgroundPosition="center"
        backgroundRepeat="no-repeat"
        filter="brightness(0.9)"
      />

      {/* Gradient overlay */}
      <Box
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        bg={overlayBg}
      />

      {/* Content */}
      <Flex
        position="relative"
        direction="column"
        align="center"
        justify="center"
        h="100%"
        px={6}
      >
        <MotionVStack
          spacing={8}
          textAlign="center"
          maxW="800px"
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        >
          {/* Glassmorphism card */}
          <MotionBox
            bg={cardBg}
            backdropFilter="blur(20px)"
            borderRadius="2xl"
            p={{ base: 8, md: 12 }}
            border="1px solid"
            borderColor="whiteAlpha.200"
            boxShadow="0 25px 50px -12px rgba(0, 0, 0, 0.5)"
            initial={{ scale: 0.95 }}
            animate={{ scale: 1 }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <VStack spacing={6}>
              {/* Title */}
              <Heading
                as="h1"
                fontSize={{ base: '3xl', md: '5xl', lg: '6xl' }}
                fontWeight="bold"
                color="white"
                textShadow="0 4px 20px rgba(0,0,0,0.4)"
                letterSpacing="tight"
                lineHeight="1.1"
              >
                Landscape{' '}
                <Text
                  as="span"
                  bgGradient="linear(to-r, brand.300, accent.300)"
                  bgClip="text"
                >
                  Decision Theatre
                </Text>
              </Heading>

              {/* Strapline */}
              <Text
                fontSize={{ base: 'lg', md: 'xl', lg: '2xl' }}
                color="whiteAlpha.900"
                maxW="600px"
                fontWeight="medium"
                textShadow="0 2px 10px rgba(0,0,0,0.3)"
              >
                Exploring the possibilities of sustainable land use practices.
              </Text>

              {/* Action buttons */}
              <Flex
                direction={{ base: 'column', sm: 'row' }}
                gap={4}
                pt={4}
              >
                <Button
                  size="lg"
                  variant="outline"
                  colorScheme="whiteAlpha"
                  color="white"
                  borderColor="whiteAlpha.400"
                  leftIcon={<FiInfo />}
                  onClick={() => onNavigate('about')}
                  _hover={{
                    bg: 'whiteAlpha.200',
                    borderColor: 'whiteAlpha.600',
                    transform: 'translateY(-2px)',
                  }}
                  transition="all 0.2s"
                  px={8}
                >
                  About
                </Button>
                <Button
                  size="lg"
                  colorScheme="brand"
                  leftIcon={<FiFolderPlus />}
                  onClick={() => onNavigate('projects')}
                  _hover={{
                    transform: 'translateY(-2px)',
                    boxShadow: '0 10px 30px -10px rgba(43, 176, 237, 0.5)',
                  }}
                  transition="all 0.2s"
                  px={8}
                >
                  Projects
                </Button>
              </Flex>
            </VStack>
          </MotionBox>
        </MotionVStack>

        {/* Animated background particles effect */}
        <Box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          pointerEvents="none"
          overflow="hidden"
        >
          {[...Array(6)].map((_, i) => (
            <MotionBox
              key={i}
              position="absolute"
              borderRadius="full"
              bg="whiteAlpha.100"
              initial={{
                x: `${Math.random() * 100}%`,
                y: `${Math.random() * 100}%`,
                scale: 0,
              }}
              animate={{
                y: [null, '-20%'],
                scale: [0, 1, 0],
                opacity: [0, 0.5, 0],
              }}
              transition={{
                duration: 8 + Math.random() * 4,
                repeat: Infinity,
                delay: i * 1.5,
                ease: 'easeInOut',
              }}
              w={`${60 + Math.random() * 100}px`}
              h={`${60 + Math.random() * 100}px`}
            />
          ))}
        </Box>
      </Flex>
    </Box>
  );
}

export default LandingPage;
