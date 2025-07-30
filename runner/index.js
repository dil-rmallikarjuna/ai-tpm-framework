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

const SYSTEM_PROMPT = `You are an expert test automation assistant. Given a natural language test case, return a JSON array of steps for Playwright MCP, MySQL, and API testing.

INSTRUCTIONS:
- For each step, use the selector (id, class, name, xpath, or css) from the provided locator JSONs that best matches the field's purpose.
- Only use selectors present in the locator JSONs and that are relevant to the described step.
- Match selectors by id, class, name, text, or locator value as appropriate.
- If a step refers to a specific page (e.g., login, dashboard), use the corresponding locator file (e.g., Locators/login.json, Locators/dashboard.json).
- Do NOT invent, describe, or use any other format for selectors.
- Use the exact selector string (e.g., #username, [name=\"password\"], .btn-primary, or an xpath).
- If you cannot find a selector for a step, SKIP that step.
- Your output MUST be a JSON array of objects, each with an 'action' property.
- Keep the output concise and do not include unnecessary selectors.

STRICT EXAMPLE:
[
  { "action": "goto", "url": "https://example.com" },
  { "action": "fill", "selector": "#username", "value": "user@example.com" },
  { "action": "fill", "selector": "#password", "value": "password123" },
  { "action": "click", "selector": "#submit-btn" },
  { "action": "assert", "selector": ".dashboard-welcome", "text": "Welcome to Dashboard" }
]
`;

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
    return `\n\nHere are all available UI element locators for this application (as JSON):\n${JSON.stringify(locatorJson, null, 2)}\n\nINSTRUCTIONS:\n- For each step, use the selector (id, class, name, or xpath) from the provided locator JSON that best matches the field's purpose.\n- Only use selectors present in the locator JSON.\n- Do NOT invent, describe, or use any other format for selectors.\n- Use the exact selector string (e.g., #username, [name=\"password\"], .btn-primary, or an xpath).\n- If you cannot find a selector for a step, SKIP that step.\n- Your output MUST be a JSON array of objects, each with an 'action' property.\n\nSTRICT EXAMPLE:\n[\n  { "action": "goto", "url": "https://example.com" },\n  { "action": "fill", "selector": "#username", "value": "user@example.com" },\n  { "action": "fill", "selector": "#password", "value": "password123" },\n  { "action": "click", "selector": "#submit-btn" },\n  { "action": "assert", "selector": ".dashboard-welcome", "text": "Welcome to Dashboard" }\n]\n`;
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

function getRelevantLocators(locatorJson, testCaseContent) {
  // Only include locators whose id, class, name, text, or locator is mentioned in the test case
  return locatorJson.filter(entry => {
    if (entry.id && testCaseContent.includes(entry.id)) return true;
    if (entry.class && testCaseContent.includes(entry.class)) return true;
    if (entry.name && testCaseContent.includes(entry.name)) return true;
    if (entry.text && testCaseContent.includes(entry.text)) return true;
    if (entry.locator && testCaseContent.includes(entry.locator)) return true;
    return false;
  });
}

function callLLM(prompt, locatorJson) {
  // Filter locators to only those relevant to the test case
  const relevantLocators = getRelevantLocators(locatorJson, prompt);
  const locatorSummary = buildLocatorSummary(relevantLocators);
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
      if (!step.action) {
        console.error(`Step ${i + 1} is missing an 'action' property:`, step);
        continue; // or break, or throw, depending on your preference
      }
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
            await page.waitForLoadState('load');
            break;
          case 'fill':
            await page.fill(step.selector, step.value);
            break;
          case 'click':
            if (step.text) {
              // Find all elements with the selector
              const elements = await page.$$(step.selector);
              let found = false;
              for (const el of elements) {
                const elText = await el.textContent();
                if (elText && elText.trim().toLowerCase() === step.text.trim().toLowerCase()) {
                  // Wait for navigation if the click triggers it
                  const [navigation] = await Promise.all([
                    page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => {}),
                    el.click()
                  ]);
                  found = true;
                  break;
                }
              }
              if (!found) throw new Error(`Element with selector ${step.selector} and text "${step.text}" not found`);
            } else {
              // Wait for navigation if the click triggers it
              const [navigation] = await Promise.all([
                page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => {}),
                page.click(step.selector)
              ]);
            }
            await page.waitForLoadState('load');
            break;
          case 'assert':
            if (step.text) {
              const el = await page.waitForSelector(step.selector, { state: 'visible', timeout: 30000 });
              const content = await el.textContent();
              if (!content.includes(step.text)) {
                throw new Error(`Text "${step.text}" not found in element ${step.selector}`);
              }
            } else if (step.exists === true) {
              await page.waitForSelector(step.selector, { state: 'visible', timeout: 30000 });
            } else if (step.exists === false) {
              await page.waitForSelector(step.selector, { state: 'hidden', timeout: 30000 });
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
  const results = [];
  for (const tc of testCases) {
    console.log(`Running test case: ${tc.name}`);
    let steps, result;
    try {
      const allLocators = getAllLocators();
      steps = callLLM(tc.content, allLocators);
      console.log('LLM steps output:', steps);
      if (!Array.isArray(steps)) {
        throw new Error('LLM did not return a JSON array of steps. Output: ' + JSON.stringify(steps));
      }
      steps = steps.filter(step => step && typeof step === 'object' && step.action);
      steps = steps.map(normalizeStep);
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

async function extractLocatorsFromDOM(page) {
  return await page.evaluate(() => {
    const locators = [];
    document.querySelectorAll('*').forEach(el => {
      if (el.id) locators.push({ id: el.id });
      if (el.className && typeof el.className === 'string') locators.push({ class: el.className });
      if (el.name) locators.push({ name: el.name });
      // Add more as needed (e.g., placeholder, type, text, xpath)
    });
    return locators;
  });
}

function normalizeStep(step) {
  if (step.action) return step;
  // Try to infer action from key
  const keys = Object.keys(step);
  if (keys.length === 1 && ['goto', 'fill', 'click', 'assert'].includes(keys[0])) {
    const action = keys[0];
    const rest = step[action];
    if (action === 'goto') return { action, url: rest };
    if (action === 'fill') return { action, selector: keys[0], value: step.value };
    if (action === 'click') return { action, selector: step[action], text: step.text };
    if (action === 'assert') return { action, selector: step[action], text: step.text };
  }
  return step;
}

main();