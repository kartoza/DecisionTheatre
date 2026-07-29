import { useCallback, useRef } from 'react';
import {
  FiActivity,
  FiBarChart2,
  FiCheckCircle,
  FiMap,
  FiTarget,
} from 'react-icons/fi';
import DemoTour, { type DemoStep } from './DemoTour';
import { MUNYWANA_SITE_ID } from '../constants/walkthroughSites';

const EXPLORING_TARGETS_STEP = 5;
const GRAZING_EFFECTS_STEP = 14;
const HERBIVORE_INPUTS_STEP = 11;

const DEMO_STEPS: DemoStep[] = [
  {
    icon: <FiMap size={28} />,
    title: 'Munywana Conservancy',
    description:
      'Welcome to the Munywana Conservancy - a 30,000 ha protected landscape in KwaZulu-Natal, South Africa. Use the LDD to explore environmental change, uncover patterns, and investigate potential management options.',
  },
  {
    icon: <FiMap size={28} />,
    title: 'Exploring the Landscape',
    description:
      'Munywana contains a mosaic of habitats, from open Zululand lowveld savanna to coastal woodland. Woody encroachment is a key management challenge. Click Next to begin exploring.',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-single-map-view',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Above-ground Woody Biomass',
    description:
      'Munywana’s vegetation has changed over time. By comparing the ecological reference state with today’s landscape, we can identify where woody encroachment is most pronounced.',
    targetId: 'demo-attribute-selector',
    navigateTo: 'map',
    autoPaneState: { attribute: 'AGBwd_Mgha', leftScenario: 'reference', rightScenario: 'current' },
  },
  {
    icon: <FiMap size={28} />,
    title: 'Compare with the Swiper',
    description:
      'Drag the swiper handle left and right to reveal where woody biomass has changed. The western portion of the conservancy shows the highest biomass, while eastern areas show smaller increases relative to the ecological reference state.',
    targetId: 'tour-map-swiper',
    navigateTo: 'map',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Ecosystem Indicator Dials',
    description:
      'Let’s switch to dial view and compare multiple ecosystem indicators. Notice how many strays away from the ecological reference.',
    targetId: 'tour-view-modes',
    navigateTo: 'map',
  },
  {
    icon: <FiTarget size={28} />,
    title: 'Exploring Management Targets',
    description:
      'With signs of increasing woody encroachment across Munywana, we can begin to explore what happens if we try to shift the system back toward a more open landscape. Reduce the Proportion closed canopy in the Targets section and see how that affects the other ecological indicators',
    targetId: 'demo-edit-targets-btn',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-go-quad-dial',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Trade-offs and Fire',
    description:
      'Reducing the proportion of closed canopy decreases above-ground woody biomass, increases open ecosystems and grass productivity — but it also raises fuel load, potentially increasing the area burned. This is a key ecological trade-off that managers must weigh when planning interventions.',
    navigateTo: 'map',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Beyond Canopy Cover',
    description:
      'To understand this more deeply, we need to look beyond canopy cover alone and examine what is happening on the ground.',
    navigateTo: 'map',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Exploring Chart View',
    description:
      'Altering the proportion of closed canopy only gives a small view into potential management options. We can move to the chart view and explore what is on the ground.',
    navigateTo: 'map',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Tree Biomass Distribution',
    description:
      'The current landscape shows a shift toward larger trees compared to the reference state, consistent with woody encroachment processes observed earlier. Restoring more open conditions may involve reducing large-tree biomass — but this comes with important ecological, financial, and practical trade-offs.',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-tree-biomass-chart',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Local Knowledge Matters',
    description:
      'Reserve managers report herbivore numbers higher than the model estimates. The LDD lets you incorporate local observations. Try adjusting herbivore biomass in the indicators panel to explore how greater grazing pressure influences grass productivity, methane production, and open ecosystem proportion.',
    targetId: 'tour-control-panel',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-go-quad-dial',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Herbivore Biomass Inputs',
    description:
      'The Site Indicators panel opens here. The Herbivores section (highlighted) lists the current model estimates for each herbivore group alongside the ecological reference values. Reserve managers observe numbers roughly 20–30 % higher than the model currently shows — the LDD lets you reflect that local knowledge directly.',
    targetId: 'demo-herbivore-section',
    navigateTo: 'indicators',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Editing Herbivore Biomass',
    description:
      'The first editable herbivore count row is highlighted. Click the pencil icon in the Current State column to edit it — increase the value to better reflect what managers observe on the ground. As you adjust, the model recalculates downstream effects — watch how open ecosystem proportion, grass NPP, and methane production respond to greater grazing pressure.',
    targetId: 'demo-herbivore-editable-row',
    navigateTo: 'indicators',
  },
  {
    icon: <FiTarget size={28} />,
    title: 'Resetting the Target State',
    description:
      'After exploring higher herbivore scenarios, use the highlighted reset button to restore the target (ideal) values back to the ecological reference. This resets the baseline so your next scenario comparison starts from a clean reference state — an important step before running a new analysis.',
    targetId: 'demo-reset-targets',
    navigateTo: 'indicators',
  },
  {
    icon: <FiActivity size={28} />,
    title: 'Grazing Pressure Effects',
    description:
      'The six dials compare reference and current states for key ecosystem indicators. Click the highlighted "Targets" button and try increasing three of the herbivore-related targets to reflect the higher numbers reported by reserve managers — then observe how the dials shift across open ecosystem proportion, grass NPP, and methane production.',
    targetId: 'demo-edit-targets-btn',
    navigateTo: 'map',
    autoUiEvent: 'dt:demo-go-quad-dial',
  },
  {
    icon: <FiBarChart2 size={28} />,
    title: 'Trade-offs from Grazing Pressure',
    description:
      'After adjusting the herbivore targets, the dials reveal the cascading trade-offs: greater grazing pressure tends to reduce the proportion of open ecosystems and grass NPP while raising methane production from grazers. These interconnections illustrate why incorporating local knowledge is essential — observed herbivore numbers that differ from model estimates can substantially alter predicted ecosystem outcomes.',
    navigateTo: 'map',
  },
  {
    icon: <FiCheckCircle size={28} />,
    title: 'Your Turn to Explore',
    description:
      'Ecosystems are complex and management decisions involve trade-offs. The Landscape Decision Dashboard combines scientific models with local knowledge to evaluate potential outcomes of different decisions. Adjust the indicators, test management scenarios, and discover how changes in one part of the ecosystem influence the whole landscape.',
  },
];

export default function MunywanaDemoTour() {
  const previousStepRef = useRef<number | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fire dt:demo-focus-herbivores after the indicators page has had time to
  // mount and load data. autoUiEvent would fire before the component mounts.
  const handleStepChange = useCallback((step: number, visible: boolean) => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    if (step === previousStepRef.current) return;
    previousStepRef.current = step;
    if (step !== HERBIVORE_INPUTS_STEP || !visible) return;
    pendingTimerRef.current = setTimeout(() => {
      window.dispatchEvent(new Event('dt:demo-focus-herbivores'));
    }, 600);
  }, []);

  return (
    <DemoTour
      siteId={MUNYWANA_SITE_ID}
      startEvent="dt:start-munywana-demo"
      steps={DEMO_STEPS}
      targetsModalAdvanceSteps={[EXPLORING_TARGETS_STEP, GRAZING_EFFECTS_STEP]}
      onStepChange={handleStepChange}
    />
  );
}
