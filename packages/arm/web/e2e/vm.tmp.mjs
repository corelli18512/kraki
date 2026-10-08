// node e2e/vm.tmp.mjs '<steps json>' — drive Kraki for Windows in the VM over CDP (127.0.0.1:9223)
// steps: ["shot","name"] ["click","selector"] ["wait",ms] ["eval","js"] ["waitFor","selector",ms] ["press","key"] ["fill","selector","text"]
import { chromium } from '@playwright/test';
const steps = JSON.parse(process.argv[2]);
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = b.contexts()[0].pages().find((p) => p.url().startsWith('app://')) ?? b.contexts()[0].pages()[0];
for (const [op, a, c] of steps) {
  try {
    if (op === 'shot') await page.screenshot({ path: `/tmp/vm/${a}.png` });
    else if (op === 'click') await page.click(a, { timeout: c ?? 10000 });
    else if (op === 'wait') await page.waitForTimeout(a);
    else if (op === 'waitFor') await page.waitForSelector(a, { timeout: c ?? 30000 });
    else if (op === 'press') await page.keyboard.press(a);
    else if (op === 'fill') await page.fill(a, c);
    else if (op === 'eval') console.log(JSON.stringify(await page.evaluate(a)));
  } catch (e) { console.log('STEP FAIL', op, a, String(e.message).split('\n')[0]); }
}
await b.close().catch(() => {});
process.exit(0);
