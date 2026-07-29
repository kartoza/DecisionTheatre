import {
  FiActivity,
  FiBarChart2,
  FiCheckCircle,
  FiMap,
  FiTarget,
} from 'react-icons/fi';
import DemoTour, { type DemoStep } from './DemoTour';
import { SHAI_HILLS_SITE_ID } from '../constants/walkthroughSites';

const LOAD_SITE_STEP = 1;
const FOREST_PATHWAY_STEP = 5;

const DEMO_STEPS: DemoStep[] = [
  {
    icon: <FiMap size={28} />,
    title: 'Setting the Scene',
    description:
      'Savannas are Ghana\'s largest ecosystem, yet restoration policies often assume that more trees always mean healthier landscapes. This case study explores how different management goals can lead to very different outcomes in savanna ecosystems.',
  },
  {
    icon: <FiMap size={28} />,
    title: 'Welcome to Shai Hills',
    description:
      'Welcome to Shai Hills — a 51 km² coastal savanna near Accra: open grass plains with wooded hills. Its value is that openness and the species that depend on it. Use the LDD to test what different futures would deliver.',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-single-map-view',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Reference vs Current',
    description:
      'Comparing the ecological reference with current conditions reveals that woody cover has shifted to the eastern region over time. Although increasing tree cover is often viewed as restoration, in savannas it can reduce grass productivity, alter biodiversity, and change ecosystem functioning.',
    targetId: 'demo-attribute-selector',
    navigateTo: 'map',
    autoPaneState: { attribute: 'AGBwd_Mgha', leftScenario: 'reference', rightScenario: 'current' },
  },
  {
    icon: <FiMap size={28} />,
    title: 'Compare with the Swiper',
    description:
      'Drag the swiper handle left and right to reveal where woody cover has increased across Shai Hills, most notably toward the eastern hills.',
    targetId: 'tour-map-swiper',
    navigateTo: 'map',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Ecosystem Indicator Dials',
    description:
      'Switch to dial view to compare multiple ecosystem indicators at once, and see how far the current landscape strays from its ecological reference.',
    targetId: 'tour-view-modes',
    navigateTo: 'map',
  },
  {
    icon: <FiTarget size={28} />,
    title: 'Forest-Focused Pathway',
    description:
      'Policy and management goals don’t always align with ecosystem needs. Try a forest-focused restoration pathway — increase the Proportion closed canopy in the Targets section. It increases woody cover, but may also reduce the open savanna and the ecological processes that define this ecosystem.',
    targetId: 'demo-edit-targets-btn',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-go-quad-dial',
  },
  {
    icon: <FiTarget size={28} />,
    title: 'Open Savanna Pathway',
    description:
      'Now try the opposite: reduce the Proportion closed canopy instead. Maintaining an open savanna supports grass production and natural processes such as fire, moving Shai Hills closer to its ecological reference state.',
    navigateTo: 'map',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Fire and Ecosystem Processes',
    description:
      'In savannas, changes in woody cover influence many ecological processes. Reducing woody cover can increase grass productivity, providing more fuel for fire. Rather than simply being a disturbance, fire is a natural process that helps maintain many healthy savanna ecosystems. The LDD allows us to explore these interconnected relationships and the trade-offs they create.',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-go-quad-dial',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Local Knowledge',
    description:
      'Models reveal patterns, but local knowledge provides the context needed for good decisions. Together they help ensure that restoration and policy reflect the needs of the ecosystem, not just broad assumptions.',
    targetId: 'tour-control-panel',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-go-quad-dial',
  },
  {
    icon: <FiCheckCircle size={28} />,
    title: 'Your Turn to Explore',
    description:
      'There is no single blueprint for restoring every landscape. Explore different management pathways, uncover their trade-offs, and discover how evidence can support better decisions for Shai Hills and other savanna ecosystems.',
  },
];

export default function ShaiHillsDemoTour() {
  return (
    <DemoTour
      siteId={SHAI_HILLS_SITE_ID}
      startEvent="dt:start-shaihills-demo"
      steps={DEMO_STEPS}
      loadSiteStep={LOAD_SITE_STEP}
      targetsModalAdvanceSteps={[FOREST_PATHWAY_STEP]}
    />
  );
}
