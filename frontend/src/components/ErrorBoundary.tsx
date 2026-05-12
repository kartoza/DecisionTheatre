import { Component, ErrorInfo, ReactNode } from 'react';
import { Box, Heading, Text, Button, VStack, Code } from '@chakra-ui/react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <Box
          minH="100vh"
          display="flex"
          alignItems="center"
          justifyContent="center"
          bg="gray.900"
          p={8}
        >
          <VStack spacing={6} maxW="600px" textAlign="center">
            <Heading color="red.400" size="lg">
              Something went wrong
            </Heading>
            <Text color="gray.300">
              An error occurred while rendering the application.
            </Text>
            {this.state.error && (
              <Code
                p={4}
                borderRadius="md"
                bg="gray.800"
                color="red.300"
                width="100%"
                textAlign="left"
                whiteSpace="pre-wrap"
                fontSize="sm"
              >
                {this.state.error.toString()}
              </Code>
            )}
            {this.state.errorInfo && (
              <Code
                p={4}
                borderRadius="md"
                bg="gray.800"
                color="gray.400"
                width="100%"
                textAlign="left"
                whiteSpace="pre-wrap"
                fontSize="xs"
                maxH="200px"
                overflowY="auto"
              >
                {this.state.errorInfo.componentStack}
              </Code>
            )}
            <Button colorScheme="brand" onClick={this.handleReset}>
              Reload Application
            </Button>
          </VStack>
        </Box>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
