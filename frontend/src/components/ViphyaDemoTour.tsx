import {
  FiActivity,
  FiCheckCircle,
  FiMap,
  FiTarget,
  FiUsers,
} from 'react-icons/fi';
import DemoTour, { type DemoStep } from './DemoTour';
import { VIPHYA_SITE_ID } from '../constants/walkthroughSites';

const LOAD_SITE_STEP = 1;
const EXPLORING_INTERVENTIONS_STEP = 3;
const FIRE_TRADE_OFF_STEP = 5;

const DEMO_STEPS: DemoStep[] = [
  {
    icon: <FiMap size={28} />,
    title: 'Setting the Scene',
    description:
      'Malawi is part of southern Africa\'s largest remaining miombo woodland landscapes. However, agricultural expansion, wood harvesting and plantation forestry have degraded parts of the landscape. Use the LDD to explore potential ways of creating shared landscapes that benefit both people and nature.',
  },
  {
    icon: <FiMap size={28} />,
    title: 'Welcome to the Mzimba District',
    description:
      'The Mzimba district contains areas of miombo woodland, characterised by widely spaced trees, a grassy understory and frequent fires. Over time, wood harvesting and land clearing for agriculture and development have altered the structure and functioning of these woodlands and decreased the overall woody cover. Drag the swiper to compare the reference and current states.',
    targetId: 'tour-map-swiper',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-single-map-view',
  },
  {
    icon: <FiUsers size={28} />,
    title: 'Local Interventions',
    description:
      'A local non-profit organisation, Global Faith and Hope Organisation, are implementing biodiversity programs in the Mzimba district. Their goal is to use community structures to help protect local species so that people and the environment can co-exist. However, funding these projects is not always an easy task. Using a tool like the LDD can help organisations like these create evidence-backed proposals and management plans.',
    navigateTo: 'map',
  },
  {
    icon: <FiTarget size={28} />,
    title: 'Exploring Interventions',
    description:
      'Let\'s test what increasing the woody cover will do to the Mzimba district. Edit the "Tree cover fraction" in the Targets section.',
    targetId: 'demo-edit-targets-btn',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-go-quad-flat',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Trade-offs',
    description:
      'As tree cover increases, the percentage of area burned, methane production, changes in soil organic carbon and grass standing biomass all decrease. While lower methane production may benefit the region, reduced grass standing biomass means less forage is available for livestock. This highlights an important trade-off that local communities and land managers need to consider.',
    navigateTo: 'map',
  },
  {
    icon: <FiTarget size={28} />,
    title: 'Fire Trade-off',
    description:
      'Fire is an important part of miombo woodlands, but increasing woody cover reduces fire. To maintain fire in the region, try reducing early-season fires in the Targets section and test to see if this is a management plan that local communities can consider.',
    targetId: 'demo-edit-targets-btn',
    navigateTo: 'map',
  },
  {
    icon: <FiCheckCircle size={28} />,
    title: 'Your Turn to Explore',
    description:
      'There are many pathways to creating landscapes that benefit both people and nature. Use the LDD to explore other ways this landscape could better meet the needs of both.',
  },
];

export default function ViphyaDemoTour() {
  return (
    <DemoTour
      siteId={VIPHYA_SITE_ID}
      startEvent="dt:start-viphya-demo"
      steps={DEMO_STEPS}
      loadSiteStep={LOAD_SITE_STEP}
      targetsModalAdvanceSteps={[EXPLORING_INTERVENTIONS_STEP, FIRE_TRADE_OFF_STEP]}
    />
  );
}
