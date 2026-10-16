// Usage: node tools/extract-landmarks.mjs <video under repo> <out.json> [start] [end] [fps] [model]
// Needs a local server on :8765 serving the repo root, and playwright-core.
import { writeFileSync } from 'node:fs';

const PW = process.env.PLAYWRIGHT_CORE ?? 'file:///D:/Salmancz/figma-export-tool/node_modules/playwright-core/index.mjs';
const { chromium } = await import(PW);

const [video, outFile, start = '0', end = '9999', fps = '60', model = 'full'] = process.argv.slice(2);
const url = `http://localhost:8765/tools/extract-landmarks.html?video=../${video}&start=${start}&end=${end}&fps=${fps}&model=${model}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__result || window.__error, null, { timeout: 0, polling: 1000 });
const err = await page.evaluate(() => window.__error);
if (err) {
  console.error(err);
  process.exit(1);
}
const result = await page.evaluate(() => window.__result);
writeFileSync(outFile, JSON.stringify(result));
const found = result.frames.filter((f) => f.lm).length;
console.log(`${result.frames.length} frames, pose found in ${found}, ${result.width}x${result.height}, model ${result.model}`);
await browser.close();
