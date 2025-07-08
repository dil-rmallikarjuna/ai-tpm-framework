const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config();
const { chromium } = require('playwright');
const { runQuery } = require('./mysqlUtil');
const axios = require('axios');

const TEST_CASES_DIR = path.join(__dirname, '../test_cases');
const REPORTS_DIR = path.join(__dirname, '../reports');
const LLM_BRIDGE = path.join(__dirname, '../llm_bridge/ask_claude.py');
const LOCATORS_DIR = path.join(__dirname, '../Locators');

const SYSTEM_PROMPT = `You are an expert test automation assistant. Given a natural language test case, return a JSON array of steps for Playwright MCP, MySQL, and API testing. Supported actions are: goto, fill, click, assert, db_query, api_request. For API operations, use the api_request action with 'method', 'url', optional 'headers', and optional 'body' fields. Do not return code, only structured JSON steps.`;

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR);
}

function getTestCases() {
  return fs.readdirSync(TEST_CASES_DIR)
    .filter(f => f.endsWith('.txt'))
    .map(f => ({
      name: f,
      content: fs.readFileSync(path.join(TEST_CASES_DIR, f), 'utf-8')
    }));
}

function getAllLocators() {
  // Load all JSON files in the Locators directory
  const locatorFiles = fs.readdirSync(LOCATORS_DIR).filter(f => f.endsWith('.json'));
  let allLocators = [];
  for (const file of locatorFiles) {
    const locators = JSON.parse(fs.readFileSync(path.join(LOCATORS_DIR, file), 'utf-8'));
    allLocators = allLocators.concat(locators);
  }
  return allLocators;
}

function buildLocatorSummary(locatorJson) {
  if (Array.isArray(locatorJson) && locatorJson.length > 0) {
    return `\n\nHere are all available UI element locators for this application (as JSON):\n${JSON.stringify(locatorJson, null, 2)}\nFor each step, use the selector (id, class, name, or xpath) from the provided locator JSON that best matches the field’s purpose. Only use selectors present in the locator JSON. Do not invent or describe selectors; use the actual selector string (e.g., #loginID, [name=\"username\"], .btn-primary, or an xpath).`;
  }
  return '';
}

function buildLocatorMap(locatorJson) {
  const map = {};
  locatorJson.forEach(entry => {
    if (entry.id) map[entry.id] = `#${entry.id}`;
    if (entry.class) map[entry.class] = `.${entry.class.split(' ').join('.')}`;
    if (entry.name) map[entry.name] = `[name="${entry.name}"]`;
    if (entry.xpath) map[entry.xpath] = entry.xpath;
  });
  return map;
}

function callLLM(prompt, locatorJson) {
  const locatorSummary = buildLocatorSummary(locatorJson);
  const fullPrompt = `${SYSTEM_PROMPT}\n\nTest case: ${prompt}${locatorSummary}\nReturn only the JSON array.`;
  const result = spawnSync('python3', [LLM_BRIDGE], {
    input: fullPrompt,
    encoding: 'utf-8',
    env: process.env
  });
  if (result.error) throw result.error;

  let output = result.stdout.trim();
  console.log('LLM raw stdout:', output);
  if (result.stderr) {
    console.log('LLM raw stderr:', result.stderr.trim());
  }
  let parsed;
  try {
    parsed = JSON.parse(output);
    let attempts = 0;
    while (typeof parsed === 'string' && attempts < 3) {
      parsed = JSON.parse(parsed);
      attempts++;
    }
    return parsed;
  } catch (e) {
    throw new Error('LLM output not valid JSON: ' + output);
  }
}

async function runTestCase(testCase, steps, locatorJson) {
  const locatorMap = buildLocatorMap(locatorJson);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  let pass = true;
  let error = null;
  const stepResults = [];
  // Create a unique screenshots directory for this test run
  const screenshotsDir = path.join(REPORTS_DIR, 'screenshots', `${Date.now()}_${testCase.name.replace(/\W/g, '')}`);
  fs.mkdirSync(screenshotsDir, { recursive: true });

  try {
    for (const [i, step] of steps.entries()) {
      // Map logical selector to actual selector if needed
      if (step.selector && locatorMap[step.selector]) {
        step.selector = locatorMap[step.selector];
      }
      let stepResult = { step: i + 1, action: step.action, status: 'pending' };
      try {
        console.log(`Executing step ${i + 1}:`, step);
        switch (step.action) {
          case 'goto':
            await page.goto(step.url);
            break;
          case 'fill':
            await page.fill(step.selector, step.value);
            break;
          case 'click':
            await page.click(step.selector);
            break;
          case 'assert':
            if (step.exists === true) {
              await page.waitForSelector(step.selector, { state: 'visible', timeout: 5000 });
            } else if (step.exists === false) {
              await page.waitForSelector(step.selector, { state: 'hidden', timeout: 5000 });
            }
            break;
          case 'db_query':
            const dbResult = await runQuery(step.query, step.database);
            stepResult.dbResult = dbResult;
            break;
          case 'api_request':
            try {
              const response = await axios({
                method: step.method || 'get',
                url: step.url,
                headers: step.headers || {},
                data: step.body || undefined,
                validateStatus: () => true // Don't throw on non-2xx
              });
              stepResult.apiResponse = {
                status: response.status,
                data: response.data
              };
            } catch (apiErr) {
              stepResult.status = 'fail';
              stepResult.error = apiErr.message;
            }
            break;
          default:
            throw new Error(`Unknown action: ${step.action}`);
        }
        stepResult.status = 'pass';
      } catch (stepErr) {
        stepResult.status = 'fail';
        stepResult.error = stepErr.message;
        pass = false;
      }
      // Take screenshot after each step
      const screenshotPath = path.join(screenshotsDir, `step${i + 1}.png`);
      await page.screenshot({ path: screenshotPath });
      stepResult.screenshot = path.relative(REPORTS_DIR, screenshotPath);
      stepResults.push(stepResult);
      if (stepResult.status === 'fail') break; // Stop on first failure
    }
  } catch (err) {
    error = err.message;
  } finally {
    await browser.close();
  }
  return { pass, steps: stepResults, error };
}

async function main() {
  const filter = process.argv[2];
  let testCases = getTestCases();
  if (filter) {
    testCases = testCases.filter(tc => tc.name === filter);
    if (testCases.length === 0) {
      console.log(`No test case found with name: ${filter}`);
      return;
    }
  }
  const allLocators = getAllLocators();
  const results = [];
  for (const tc of testCases) {
    console.log(`Running test case: ${tc.name}`);
    let steps, result;
    try {
      steps = callLLM(tc.content, allLocators);
      console.log('LLM steps output:', steps);
      if (!Array.isArray(steps)) {
        throw new Error('LLM did not return a JSON array of steps. Output: ' + JSON.stringify(steps));
      }
      result = await runTestCase(tc, steps, allLocators);
    } catch (err) {
      result = { pass: false, steps: null, error: err.message };
    }
    results.push({ name: tc.name, ...result });
  }
  // Generate report
  const reportPath = path.join(REPORTS_DIR, `report_${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`Report generated: ${reportPath}`);

  const htmlReportPath = path.join(REPORTS_DIR, `report_${Date.now()}.html`);
  generateHtmlReport(results, htmlReportPath);
  console.log(`HTML report generated: ${htmlReportPath}`);
}

function generateHtmlReport(results, htmlReportPath) {
  let html = `
    <html>
    <head>
      <title>Test Automation Report</title>
      <style>
        body { font-family: Arial, sans-serif; }
        .testcase { margin-bottom: 40px; }
        .step { margin-bottom: 20px; }
        .pass { color: green; }
        .fail { color: red; }
        img { max-width: 400px; border: 1px solid #ccc; }
      </style>
    </head>
    <body>
      <h1>Test Automation Report</h1>
      <p>Generated: ${new Date().toLocaleString()}</p>
  `;

  for (const test of results) {
    html += `<div class="testcase">
      <h2>${test.name} - <span class="${test.pass ? 'pass' : 'fail'}">${test.pass ? 'PASS' : 'FAIL'}</span></h2>
      ${test.error ? `<p class="fail">Error: ${test.error}</p>` : ''}
      <ol>
    `;
    if (Array.isArray(test.steps)) {
      for (const step of test.steps) {
        html += `<li class="step">
          <strong>Action:</strong> ${step.action} <br/>
          <strong>Status:</strong> <span class="${step.status}">${step.status.toUpperCase()}</span><br/>
          ${step.error ? `<strong>Error:</strong> ${step.error}<br/>` : ''}
          ${step.screenshot ? `<img src="${step.screenshot.replace(/\\/g, '/')}" alt="Step Screenshot"/><br/>` : ''}
        </li>`;
      }
    }
    html += `</ol></div>`;
  }

  html += `</body></html>`;
  fs.writeFileSync(htmlReportPath, html);
}

main(); 