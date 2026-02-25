/**
 * NixTestTool Server
 * Receives test steps from the UI, runs them with Playwright,
 * captures screenshots per step, and streams live state via polling.
 *
 * Setup:
 *   npm install express cors playwright
 *   npx playwright install chromium
 *   node server.js
 *
 * Logs are written to: nixtesttool.log
 */

const express = require('express');
const cors = require('cors');
const { chromium, firefox, webkit } = require('playwright');
const path = require('path');
const fs = require('fs');

// ─── Logger ────────────────────────────────────────────────────────────────

const LOG_FILE = path.join(__dirname, 'nixtesttool.log');

function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 23);
}

function writeLog(line) {
  fs.appendFileSync(LOG_FILE, `[${timestamp()}] ${line}\n`);
}

function logSection(char = '─', width = 60) {
  writeLog(char.repeat(width));
}

// ─── In-memory run state (for live polling) ────────────────────────────────

const runs = {};

function newRun(runId, totalSteps) {
  runs[runId] = {
    status: 'running',
    currentStep: 0,
    totalSteps,
    log: [],
    liveScreenshot: null,
    stepScreenshots: [],
  };
  return runs[runId];
}

// ─── App setup ─────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ─── Live poll endpoint ─────────────────────────────────────────────────────

app.get('/run-status/:runId', (req, res) => {
  const run = runs[req.params.runId];
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

// ─── Run test endpoint ──────────────────────────────────────────────────────

app.post('/run-test', async (req, res) => {
  const { testName = 'Test', browser: browserName = 'chromium', steps = [] } = req.body;
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const run = newRun(runId, steps.length);
  const start = Date.now();

  // Respond immediately with runId so UI can start polling
  res.json({ runId });

  const browsers = { chromium, firefox, webkit };
  const launchFn = browsers[browserName] || chromium;
  let browser, context, page;

  logSection();
  writeLog(`TEST RUN STARTED  [${runId}]`);
  writeLog(`Name:    ${testName}`);
  writeLog(`Browser: ${browserName}`);
  writeLog(`Steps:   ${steps.length}`);
  logSection('─');

  function log(msg) {
    run.log.push(msg);
    writeLog(msg);
  }

  async function captureScreenshot(label, status) {
    try {
      const buffer = await page.screenshot({ type: 'jpeg', quality: 75 });
      const b64 = buffer.toString('base64');
      run.liveScreenshot = b64;
      run.stepScreenshots.push({ label, status, screenshot: b64 });
    } catch (_) {
      // Screenshot can fail mid-navigation — skip silently
    }
  }

  try {
    log(`→ Launching ${browserName}...`);
    browser = await launchFn.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNum = `[${i + 1}/${steps.length}]`;
      run.currentStep = i + 1;

      let stepLabel = '';
      if (step.type === 'url')    stepLabel = `Go to ${step.url}`;
      if (step.type === 'click')  stepLabel = `Click "${step.target}"`;
      if (step.type === 'fill')   stepLabel = `Fill "${step.label}"`;
      if (step.type === 'assert') stepLabel = `Assert "${step.text}" visible`;

      try {
        if (step.type === 'url') {
          log(`${stepNum} Going to ${step.url}`);
          await page.goto(step.url, { timeout: 15000 });
          log(`✔ Navigated to ${step.url}`);
        } else if (step.type === 'click') {
          log(`${stepNum} Clicking "${step.target}"`);
          await page.getByRole('button', { name: step.target }).click({ timeout: 10000 });
          log(`✔ Clicked "${step.target}"`);
        } else if (step.type === 'fill') {
          log(`${stepNum} Filling "${step.label}"`);
          await page.getByLabel(step.label).fill(step.value, { timeout: 10000 });
          log(`✔ Filled "${step.label}"`);
        } else if (step.type === 'assert') {
          log(`${stepNum} Asserting "${step.text}" is visible`);
          await page.getByText(step.text).waitFor({ state: 'visible', timeout: 10000 });
          log(`✔ "${step.text}" is visible`);
        }

        await captureScreenshot(stepLabel, 'pass');

      } catch (stepErr) {
        const shortMsg = stepErr.message.split('\n')[0];
        log(`✖ Step ${i + 1} failed: ${shortMsg}`);
        writeLog(`STACK TRACE:`);
        (stepErr.stack || stepErr.message).split('\n').forEach(l => writeLog(`  ${l}`));
        await captureScreenshot(stepLabel, 'fail');
        throw stepErr;
      }
    }

    const duration = Date.now() - start;
    log(`✔ All ${steps.length} steps passed.`);
    logSection('─');
    writeLog(`RESULT: PASSED | Duration: ${duration}ms`);
    logSection();
    writeLog('');

    run.status = 'passed';
    run.duration = duration;
    run.browser = browserName;

  } catch (err) {
    const duration = Date.now() - start;
    log(`Error: ${err.message.split('\n')[0]}`);
    logSection('─');
    writeLog(`RESULT: FAILED | Duration: ${duration}ms`);
    logSection();
    writeLog('');

    run.status = 'failed';
    run.duration = duration;
    run.browser = browserName;

  } finally {
    if (browser) await browser.close();
    setTimeout(() => { delete runs[runId]; }, 10 * 60 * 1000);
  }
});

// ─── Start server ───────────────────────────────────────────────────────────

const PORT = 3000;
app.listen(PORT, () => {
  const msg = `NixTestTool server started on http://localhost:${PORT}`;
  writeLog(msg);
  writeLog('');
  console.log(`\n✔ ${msg}`);
  console.log(`  Logging to: ${LOG_FILE}`);
  console.log(`  Open http://localhost:${PORT} in your browser\n`);
});
