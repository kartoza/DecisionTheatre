import { chromium } from 'playwright';

const shotDir = '/tmp/claude-1000/-home-voogt-Desktop-work-projects-DecisionTheatre/d72a1cb6-7246-4060-aec9-2e48cc335ace/scratchpad';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (err) => console.log('[pageerror]', err.message));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const closeBtn = page.locator('text=Close').first();
if (await closeBtn.isVisible().catch(() => false)) {
  await closeBtn.click();
  await page.waitForTimeout(500);
}

const cta = page.locator('text=Explore Conservation Futures').first();
await cta.click();
await page.waitForTimeout(1500);

// Click "Next" through the tour steps: 0 Munywana Conservancy -> 1 Exploring
// the Landscape (site load) -> ... -> 9 Tree Biomass Distribution.
for (let i = 0; i < 9; i++) {
  const nextBtn = page.locator('button:has-text("Next")').first();
  await nextBtn.waitFor({ state: 'visible', timeout: 20000 });
  await nextBtn.click();
  await page.waitForTimeout(2000);
  console.log(`clicked Next #${i + 1}`);
}

await page.waitForTimeout(3000);
await page.screenshot({ path: `${shotDir}/tree-biomass-step-full.png`, fullPage: true });

const individualFactorText = await page.locator('text=INDIVIDUAL FACTOR').first().locator('xpath=../..').innerText().catch((e) => 'NOT FOUND: ' + e.message);
console.log('--- INDIVIDUAL FACTOR block ---');
console.log(individualFactorText);

const groupingVarText = await page.locator('text=GROUPING VARIABLE').first().locator('xpath=../..').innerText().catch((e) => 'NOT FOUND: ' + e.message);
console.log('--- GROUPING VARIABLE block ---');
console.log(groupingVarText);

await browser.close();
