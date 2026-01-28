# REQ-003: Chakra UI Framework

| Field | Value |
|-------|-------|
| **Component** | Frontend |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a user, when I interact with the application, I should see a consistently styled, accessible interface built with the Chakra UI component library, served entirely from the embedded application. |
| **Importance** | High |

## Wireframe

```
Component Library Usage:
┌─────────────────────────────┐
│ <ChakraProvider theme={...}>│
│   <Header />  ← Flex, HStack, Badge, IconButton
│   <MapView /> ← Box (container)
│   <ControlPanel /> ← VStack, Select, Slide, Divider
│ </ChakraProvider>           │
└─────────────────────────────┘
```

## Implementation Details

- Chakra UI v2 with Emotion for CSS-in-JS (zero external CSS files needed)
- Custom theme extending Chakra's default with brand colors and dark mode
- All Chakra UI code is bundled at build time via Vite - no runtime fetches
- Framer Motion for animations (Chakra UI dependency)
- Dark mode as default color mode
- Components used: Flex, Box, VStack, HStack, Select, Badge, IconButton, Heading, Text, Slide, Divider, Tooltip
- Responsive breakpoints: `base` (mobile), `md` (tablet), `lg` (desktop)
- Custom color schemes: `brand` (blue) and `accent` (orange)

### Key Files

- `frontend/src/styles/theme.ts` - Custom Chakra UI theme
- `frontend/src/main.tsx` - ChakraProvider setup
