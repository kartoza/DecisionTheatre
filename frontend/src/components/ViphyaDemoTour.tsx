import {
  FiActivity,
  FiBarChart2,
  FiCheckCircle,
  FiMap,
  FiTarget,
} from 'react-icons/fi';
import DemoTour, { type DemoStep } from './DemoTour';

const VIPHYA_SITE_ID = '165bcb54-71aa-49de-8e80-bb3142f16eb7';
const LOAD_SITE_STEP = 1;
const RESTORATION_PATHWAY_STEP = 5;

const DEMO_STEPS: DemoStep[] = [
  {
    icon: <FiMap size={28} />,
    title: 'Setting the Scene',
    description:
      'The Viphya Complex in northern Malawi forms part of one of southern Africa\'s largest remaining miombo woodland landscapes. These woodlands support rich biodiversity while providing fuelwood, charcoal, timber and other resources that many local communities depend on. Over recent decades, agricultural expansion, wood harvesting and plantation forestry have altered parts of the landscape, raising concerns about woodland degradation and forest loss. The Landscape Decision Dashboard lets us compare the current landscape with its ecological reference state and explore the trade-offs between carbon storage, biodiversity and ecosystem resilience.',
  },
  {
    icon: <FiMap size={28} />,
    title: 'Welcome to the Viphya Complex Forest Reserve',
    description:
      'The Viphya Plateau in northern Malawi is dominated by miombo woodland — an ecosystem of widely spaced trees, a grassy understory and frequent natural fires. Alongside native woodland that supports communities relying on woodland resources for fuelwood, grazing and livelihoods, the landscape also contains extensive pine plantations. This mix of natural and managed forests makes the Viphya Complex an ideal place to explore how different management decisions influence ecosystem health.',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-single-map-view',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Reference vs Current',
    description:
      'The current landscape shows an increase in above-ground woody biomass compared with the ecological reference state. However, more woody biomass does not necessarily indicate a healthier woodland. Tree gains may result from plantation expansion or changing land management, rather than the recovery of native miombo ecosystems.',
    targetId: 'demo-attribute-selector',
    navigateTo: 'map',
    autoPaneState: { attribute: 'AGBwd_Mgha', leftScenario: 'reference', rightScenario: 'current' },
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Closer Look',
    description:
      'Explore the Site indicators and notice that Biomass Burned has decreased substantially compared with the reference state. Fire is a natural part of miombo woodlands, helping maintain their characteristic woodland structure. Reduced burning may reflect changes in land management that increase woody biomass but can also alter ecosystem functioning over time.',
    navigateTo: 'indicators',
  },
  {
    icon: <FiTarget size={28} />,
    title: 'Tough Decisions',
    description:
      'Managing the Viphya Complex means balancing multiple objectives. Commercial forestry supports local economies, while native miombo woodlands provide biodiversity, carbon storage and natural resources for surrounding communities. Different priorities can lead to very different ecological outcomes.',
    navigateTo: 'map',
  },
  {
    icon: <FiTarget size={28} />,
    title: 'Miombo Woodland Restoration',
    description:
      'Let\'s compare some potential management plans. If we adjust the target towards the ecological reference state, the woodland becomes more open, resembling native miombo. Biomass burned also increases, reflecting the important role of fire in maintaining these ecosystems.',
    targetId: 'demo-edit-targets-btn',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-go-quad-dial',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Increasing Tree Cover',
    description:
      'Now try the opposite: increasing woody biomass shifts the landscape further from its reference condition. Biomass burned declines, illustrating how changes in vegetation structure and fire regimes are linked. While expanding plantations may provide economic benefits through timber production and employment, it may also reduce the ecological characteristics that define native miombo woodland.',
  },
  {
    icon: <FiCheckCircle size={28} />,
    title: 'Final Message',
    description:
      'The Viphya Complex shows that restoration is about more than planting trees. Healthy miombo woodlands depend on the right balance of vegetation, fire and ecological processes. By exploring different management pathways, the Landscape Decision Dashboard helps reveal the trade-offs between biodiversity, carbon storage, livelihoods and ecosystem health.',
  },
];

export default function ViphyaDemoTour() {
  return (
    <DemoTour
      siteId={VIPHYA_SITE_ID}
      startEvent="dt:start-viphya-demo"
      steps={DEMO_STEPS}
      loadSiteStep={LOAD_SITE_STEP}
      targetsModalAdvanceSteps={[RESTORATION_PATHWAY_STEP]}
    />
  );
}
