import {
  FiActivity,
  FiBarChart2,
  FiCheckCircle,
  FiMap,
  FiTarget,
} from 'react-icons/fi';
import DemoTour, { type DemoStep } from './DemoTour';

const AFRICA_SITE_ID = '6dede7c6-8eb3-47a8-a678-16c610b551e6';
const LOAD_SITE_STEP = 1;
const SCENARIO_1_STEP = 10;
const SCENARIO_2_STEP = 11;

const DEMO_STEPS: DemoStep[] = [
  {
    icon: <FiMap size={28} />,
    title: 'Rewilding Africa',
    description:
      'Africa is the one continent that still retains most of its indigenous mammalian herbivores, but their extent and distribution is severely constrained. These wildlife communities are now largely confined to small, fragmented conservation areas — outside of which livestock such as cattle, sheep and goats dominate the herbivore biomass. Some parts of Africa have less herbivory than in the past, from the loss of large grazers like rhino and buffalo; others have more, where people maintain livestock at higher densities than previous wildlife populations by providing extra water points and protection from predation.',
  },
  {
    icon: <FiMap size={28} />,
    title: 'A View Back to the Past',
    description:
      'Explore the current and reference density of different herbivores across Africa by dragging the swiper across the map and choosing different herbivore layers. We\'ll start with total herbivore biomass, then grazing biomass, then megaherbivore biomass.',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-single-map-view',
    autoPaneState: { attribute: 'herbs_tot_kgkm2', leftScenario: 'reference', rightScenario: 'current' },
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Total Herbivore Biomass',
    description:
      'This layer shows total herbivore biomass — wild and domestic combined. Drag the swiper to compare the reference state with today. Overall biomass is now far lower than it once was, driven by the loss of large, charismatic grazers.',
    targetId: 'tour-map-swiper',
    navigateTo: 'map',
    autoPaneState: { attribute: 'herbs_tot_kgkm2', leftScenario: 'reference', rightScenario: 'current' },
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Grazing Biomass',
    description:
      'Now look at the proportion of grazing animals specifically. Unlike the total, this share has increased in many areas — livestock, sustained by extra water points and protection from predators, now often exceed the grazing pressure of the wild herds they replaced.',
    targetId: 'tour-map-swiper',
    navigateTo: 'map',
    autoPaneState: { attribute: 'fracGrazing', leftScenario: 'reference', rightScenario: 'current' },
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Megaherbivore Biomass',
    description:
      'Finally, megaherbivore biomass — elephant, rhino, hippo and other giants. This is where the collapse is starkest: megaherbivores have all but disappeared from most of the continent outside protected areas.',
    targetId: 'tour-map-swiper',
    navigateTo: 'map',
    autoPaneState: { attribute: 'herbs_fg_kgkm2_Megaherbivores', leftScenario: 'reference', rightScenario: 'current' },
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Changed Herbivore Regimes',
    description:
      'Now click on chart view to get more detail on the types of herbivores and their abundance relative to reference ecosystems before colonialism. Grouping by "Functional group" shows that every wild functional group has declined — except domestic biomass, which has increased dramatically and now dominates the continent\'s herbivore community.',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-herbivore-functional-group-chart',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Ecosystem-Scale Consequences',
    description:
      'Land management decisions never happen in isolation. Over the decades, maximising livestock numbers in an ecosystem has produced undesirable consequences elsewhere. Click the dial button for a multi-panel view of how the current herbivore regime has altered ecosystem functioning.',
    targetId: 'tour-view-modes',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-go-quad-dial-africa',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Reading the Dials',
    description:
      'Total herbivore biomass is far lower now than in the past — mostly from the loss of megaherbivores. Grazing biomass, however, is higher than reference, driven by dense livestock herds. As a consequence, current area burned is lower than reference (there isn\'t enough fuel left for fire to carry), while total methane production is much, much higher.',
    navigateTo: 'map',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Soil Carbon',
    description:
      'Let\'s focus in on the NPP pane and swap it for change in Soil Organic Carbon, to see how the shift from wild grazers to livestock has affected the soil itself.',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-swap-npp-soc',
  },
  {
    icon: <FiTarget size={28} />,
    title: 'Intervention',
    description:
      'Imagine there was so much enthusiasm for rewilding Africa that a huge market for indigenous meat flourished, and cattle farmers across Botswana were motivated to switch from livestock to a more balanced herbivore regime. We\'ll use "Set target" to test two different scenarios against each other.',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-go-quad-dial-africa',
  },
  {
    icon: <FiTarget size={28} />,
    title: 'Scenario 1: Same Density, Different Mix',
    description:
      'Click the highlighted Targets button and try this: keep the same total density of herbivores, but replace livestock biomass with indigenous herbivores — farmers don\'t sacrifice production, but the animals farmed are more varied in function and better adapted to the ecosystem. Close the panel once you\'ve set it, and watch how methane, soil carbon and fire respond.',
    targetId: 'demo-edit-targets-btn',
    navigateTo: 'map',
  },
  {
    icon: <FiTarget size={28} />,
    title: 'Scenario 2: Keep the Cattle, Match the Past',
    description:
      'Now reset the targets back to reference and try the alternative: keep the cattle, but alter their biomass to match the biomass of herbivores that used to be there. Open the Targets panel again to set it up, then close it to see the outcome.',
    targetId: 'demo-edit-targets-btn',
    navigateTo: 'map',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Compare and Reflect',
    description:
      'Compare the two scenarios you just explored and assess which is better for: (1) methane emissions, (2) soil carbon storage, and (3) fire regimes. Neither scenario sacrifices production — they simply distribute biomass differently across the herbivore community, with very different ecological consequences.',
    navigateTo: 'map',
  },
  {
    icon: <FiCheckCircle size={28} />,
    title: 'Your Turn to Explore',
    description:
      'There is no single blueprint for rewilding a continent as vast and varied as Africa. Explore different herbivore regimes, uncover their trade-offs across methane, soil carbon and fire, and discover how the Landscape Decision Dashboard can support better decisions for shared landscapes everywhere.',
  },
];

export default function AfricaDemoTour() {
  return (
    <DemoTour
      siteId={AFRICA_SITE_ID}
      startEvent="dt:start-africa-demo"
      steps={DEMO_STEPS}
      loadSiteStep={LOAD_SITE_STEP}
      targetsModalAdvanceSteps={[SCENARIO_1_STEP, SCENARIO_2_STEP]}
    />
  );
}
