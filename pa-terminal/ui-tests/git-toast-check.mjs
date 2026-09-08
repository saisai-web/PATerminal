import { chromium } from 'playwright';
import gitActions from './18-git-actions.mjs';
import { check, results, BASE_URL } from './context.mjs';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  await gitActions({ browser: { newPage: (opts) => browser.newPage({ locale: 'ja-JP', ...opts }) }, check, BASE_URL });
  const page = await browser.newPage({ locale: 'ja-JP' });
  await page.goto(BASE_URL);
  await page.waitForSelector('.pane');
  await page.clock.install();
  const show = (text, kind) => page.evaluate(async ({text, kind}) => {
    const { showGitMsg } = await import('/src/features/git/git-actions.ts');
    showGitMsg(text, kind);
  }, {text, kind});
  await page.locator('.xterm-helper-textarea').first().focus();
  await show('Switched to branch develop', 'ok');
  check('completion is visible without stealing terminal focus', await page.locator('#git-toast').isVisible() && await page.locator('.xterm-helper-textarea').first().evaluate(el => el === document.activeElement));
  check('completion shows result', (await page.locator('#git-toast').innerText()).includes('develop'));
  await page.clock.fastForward(8100);
  check('success dismisses automatically', await page.locator('#git-toast').isHidden());
  await show('first line\nCONFLICT in file.ts', 'err');
  await page.clock.fastForward(61000);
  check('failure stays visible with full details', await page.locator('#git-toast').isVisible() && (await page.locator('.git-toast-detail').innerText()).includes('\nCONFLICT'));
  await page.locator('#git-toast > button').click();
  check('close dismisses the toast', await page.locator('#git-toast').isHidden());
  await show('done', 'ok');
  await show('working', 'busy');
  check('next operation clears stale completion', await page.locator('#git-toast').isHidden());
  await show('done', 'ok');
  await page.locator('#git-toast').hover();
  await page.clock.fastForward(9000);
  check('hover keeps success readable', await page.locator('#git-toast').isVisible());
  await page.mouse.move(0, 0);
  await page.clock.fastForward(8100);
  check('success dismiss resumes after hover', await page.locator('#git-toast').isHidden());
  await page.setViewportSize({width: 360, height: 640});
  await show('long detail '.repeat(200), 'err');
  const rect = await page.locator('#git-toast').boundingBox();
  check('toast fits a narrow viewport', rect.x >= 0 && rect.x + rect.width <= 360 && rect.y >= 0);
} finally {
  await browser.close();
}
if (results.some(r => !r.ok)) process.exitCode = 1;
