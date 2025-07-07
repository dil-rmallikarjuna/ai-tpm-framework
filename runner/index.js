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
const LOCATORS_DIR = path.join(__dirname, '../locators');

const SYSTEM_PROMPT = `You are an expert test automation assistant. Given a natural language test case, return a JSON array of steps for Playwright MCP, MySQL, and API testing. Each step must be an object with an "action" key (e.g., "goto", "fill", "click", "selectOption", "assert", "db_query", "api_request"). For UI steps: "goto" needs "url"; "fill" needs "selector" and "value"; "click" needs "selector"; "selectOption" is for <select> dropdowns and needs "selector" and "value" (the option value to select); "assert" needs "selector" and "exists" (true/false). For API operations, use "api_request" with "method", "url", optional "headers", and optional "body". If a dropdown is already auto-selected or has only one option, skip the selectOption step for that selector. Return only a JSON array of objects, no code or explanations. Example: [{"action":"goto","url":"https://example.com"},{"action":"fill","selector":"#username","value":"user"},{"action":"selectOption","selector":"#country","value":"IN"}]`;

function getTestCases() {
  return fs.readdirSync(TEST_CASES_DIR)
    .filter(f => f.endsWith('.txt'))
    .map(f => ({
      name: f,
      content: fs.readFileSync(path.join(TEST_CASES_DIR, f), 'utf-8')
    }));
}

function getLocatorFileForTest(testCaseName) {
  if (!fs.existsSync(LOCATORS_DIR)) {
    fs.mkdirSync(LOCATORS_DIR, { recursive: true });
  }
  return path.join(LOCATORS_DIR, `${testCaseName.replace(/\.txt$/, '')}.json`);
}

function loadLocatorJson(locatorFile) {
  if (fs.existsSync(locatorFile)) {
    return JSON.parse(fs.readFileSync(locatorFile, 'utf-8'));
  }
  return [];
}

function buildLocatorMap(locatorJson) {
  const locatorMap = {};
  locatorJson.forEach(entry => {
    if (entry.id) locatorMap[entry.id] = `#${entry.id}`;
    if (entry.class) locatorMap[entry.class] = `.${entry.class.split(' ').join('.')}`;
    if (entry.name) locatorMap[entry.name] = `[name="${entry.name}"]`;
    if (entry.xpath) locatorMap[entry.xpath] = entry.xpath;
  });
  return locatorMap;
}

function buildLocatorSummary(locatorJson) {
  if (Array.isArray(locatorJson) && locatorJson.length > 0) {
    const locatorList = locatorJson.map(entry => {
      const obj = {};
      if (entry.id) obj.id = entry.id;
      if (entry.class) obj.class = entry.class;
      if (entry.name) obj.name = entry.name;
      if (entry.placeholder) obj.placeholder = entry.placeholder;
      if (entry.type) obj.type = entry.type;
      if (entry.text) obj.text = entry.text;
      if (entry.xpath) obj.xpath = entry.xpath;
      return obj;
    });
    return `\n\nHere are all available UI element locators for this page:\n${JSON.stringify(locatorList, null, 2)}\nWhen generating steps, for each field or button, use the selector (id, class, name, or xpath) that best matches the field's purpose based on its attributes. Return only a JSON array of steps using the actual selectors (e.g., #username, .input-pass, [name=\"user\"], or xpath).`;
  }
  return '';
}

async function extractLocatorsFromPage(page, locatorFile) {
  const script = `
    (() => {
      function getXPath(element) {
        if (element.id) {
          return '//*[@id=\"' + element.id + '\"]';
        }
        if (element === document.body) {
          return '/html/body';
        }
        let ix = 0;
        const siblings = element.parentNode ? element.parentNode.childNodes : [];
        for (let i = 0; i < siblings.length; i++) {
          const sibling = siblings[i];
          if (sibling === element) {
            return getXPath(element.parentNode) + '/' + element.tagName.toLowerCase() + '[' + (ix + 1) + ']';
          }
          if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
            ix++;
          }
        }
        return '';
      }
      const elements = Array.from(document.querySelectorAll('input, button, select, textarea, a, label, [id], [class]'));
      const locators = elements.map(e => ({
        tag: e.tagName.toLowerCase(),
        id: e.id || undefined,
        class: typeof e.className === 'string' ? e.className : undefined,
        name: e.name || undefined,
        placeholder: e.placeholder || undefined,
        type: e.type || undefined,
        text: e.innerText ? e.innerText.trim() : undefined,
        xpath: getXPath(e)
      }));
      const seen = new Set();
      const uniqueLocators = locators.filter(l => {
        const key = [l.id, l.class, l.name, l.xpath].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return uniqueLocators;
    })();
  `;
  const locators = await page.evaluate(script);
  fs.writeFileSync(locatorFile, JSON.stringify(locators, null, 2));
}

async function extractLocatorsForTestCase(testCase) {
  const urlMatch = testCase.content.match(/https?:\/\/[^\s"]+/);
  const testUrl = urlMatch ? urlMatch[0] : null;
  if (!testUrl) {
    throw new Error('No URL found in test case: ' + testCase.name);
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(testUrl, { timeout: 60000 });
    const locatorFile = getLocatorFileForTest(testCase.name);
    await extractLocatorsFromPage(page, locatorFile);
  } finally {
    await browser.close();
  }
}

function callLLM(prompt, locatorJson) {
  let locatorSummary = buildLocatorSummary(locatorJson);
  const fullPrompt = `${SYSTEM_PROMPT}\n\nTest URL: ${testUrl}\nCurrent page goal: ${prompt}${locatorSummary}`;
  const result = spawnSync('python3', [LLM_BRIDGE], {
    input: fullPrompt,
    encoding: 'utf-8',
    env: process.env
  });
  if (result.error) throw result.error;

  let output = result.stdout.trim();
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
    const failuresDir = path.join(REPORTS_DIR, 'llm_failures');
    if (!fs.existsSync(failuresDir)) {
      fs.mkdirSync(failuresDir, { recursive: true });
    }
    const failFile = path.join(failuresDir, `fail_${Date.now()}.txt`);
    fs.writeFileSync(failFile, `Prompt:\n${fullPrompt}\n\nRaw Output:\n${output}\n\nError:\n${e.stack}`);
    throw new Error('LLM output not valid JSON. See ' + failFile + ' for details. Raw output: ' + output);
  }
}

async function runTestCaseStepByStep(testCase) {
  const urlMatch = testCase.content.match(/https?:\/\/[^"]+/);
  const testUrl = urlMatch ? urlMatch[0] : null;
  const usernameMatch = testCase.content.match(/username\s+"?([^\s"\n]+)"?/i);
  const passwordMatch = testCase.content.match(/password\s+"?([^\s"\n]+)"?/i);
  const username = usernameMatch ? usernameMatch[1].replace(/^"|"$/g, '') : '';
  const password = passwordMatch ? passwordMatch[1].replace(/^"|"$/g, '') : '';
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  let pass = true;
  let error = null;
  const stepResults = [];
  const screenshotsDir = path.join(REPORTS_DIR, 'screenshots', `${Date.now()}_${testCase.name.replace(/\W/g, '')}`);
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const tempLocatorFile = path.join(LOCATORS_DIR, `temp_${Date.now()}_${testCase.name.replace(/\W/g, '')}.json`);

  // Split the test case into high-level goals (one per line, ignoring empty lines)
  const goals = testCase.content.split(/\n/).map(s => s.trim()).filter(Boolean);

  try {
    for (let i = 0; i < goals.length; i++) {
      const goal = goals[i];
      await extractLocatorsFromPage(page, tempLocatorFile);
      const locatorJson = loadLocatorJson(tempLocatorFile);
      const locatorSummary = buildLocatorSummary(locatorJson);
      const prompt = `${SYSTEM_PROMPT}\n\nTest URL: ${testUrl}\nUsername: ${username}\nPassword: ${password}\nCurrent page goal: ${goal}${locatorSummary}\nAlways use the exact username and password above for any login step. Only generate one action for each goal.`;
      const result = spawnSync('python3', [LLM_BRIDGE], {
        input: prompt,
        encoding: 'utf-8',
        env: process.env
      });
      if (result.error) throw result.error;
      let output = result.stdout.trim();
      let step;
      try {
        step = JSON.parse(output);
        let attempts = 0;
        while (typeof step === 'string' && attempts < 3) {
          step = JSON.parse(step);
          attempts++;
        }
      } catch (e) {
        throw new Error('LLM output not valid JSON for goal: ' + goal + '. Output: ' + output);
      }
      // Log the LLM step for this goal
      console.log('LLM step for goal:', goal, step);
      // Only execute one action per goal (if array, take the first action)
      const s = Array.isArray(step) ? step[0] : step;
      let stepResult = { step: stepResults.length + 1, action: s.action, status: 'pending' };
      try {
        const locatorMap = buildLocatorMap(locatorJson);
        if (s.selector && locatorMap[s.selector]) {
          s.selector = locatorMap[s.selector];
        }
        switch (s.action) {
          case 'goto':
            await page.goto(s.url);
            break;
          case 'fill':
            await page.fill(s.selector, s.value);
            break;
          case 'click':
            await page.waitForSelector(s.selector, { state: 'visible', timeout: 60000 });
            const el = await page.$(s.selector);
            if (el) {
              await el.waitForElementState('enabled', { timeout: 60000 });
              await el.scrollIntoViewIfNeeded();
              await el.click();
            } else {
              throw new Error('Element not found for selector: ' + s.selector);
            }
            break;
          case 'selectOption':
            await page.selectOption(s.selector, s.value);
            break;
          case 'assert':
            if (s.exists === true) {
              await page.waitForSelector(s.selector, { state: 'visible', timeout: 60000 });
            } else if (s.exists === false) {
              await page.waitForSelector(s.selector, { state: 'hidden', timeout: 60000 });
            }
            break;
          case 'db_query':
            const dbResult = await runQuery(s.query, s.database);
            stepResult.dbResult = dbResult;
            break;
          case 'api_request':
            try {
              const response = await axios({
                method: s.method || 'get',
                url: s.url,
                headers: s.headers || {},
                data: s.body || undefined,
                validateStatus: () => true
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
            throw new Error(`Unknown action: ${s.action}`);
        }
        stepResult.status = 'pass';
      } catch (stepErr) {
        stepResult.status = 'fail';
        stepResult.error = stepErr.message;
      }
      const screenshotPath = path.join(screenshotsDir, `step${stepResults.length + 1}.png`);
      await page.screenshot({ path: screenshotPath });
      stepResult.screenshot = path.relative(REPORTS_DIR, screenshotPath);
      stepResults.push(stepResult);
      if (stepResult.status === 'fail') break;
      await new Promise(res => setTimeout(res, 1000));
      await page.waitForLoadState('load');
    }
  } catch (err) {
    pass = false;
    error = err.message;
  } finally {
    await browser.close();
    if (fs.existsSync(tempLocatorFile)) {
      fs.unlinkSync(tempLocatorFile);
    }
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
    const locatorFile = getLocatorFileForTest(tc.name);
    try {
      await extractLocatorsForTestCase(tc);
    } catch (err) {
      results.push({ name: tc.name, pass: false, steps: null, error: 'Failed to extract locators: ' + err.message });
      continue;
    }
    let steps, result;
    try {
      result = await runTestCaseStepByStep(tc);
    } catch (err) {
      result = { pass: false, steps: null, error: err.message };
    }
    results.push({ name: tc.name, ...result });
    if (fs.existsSync(locatorFile)) {
      fs.unlinkSync(locatorFile);
    }
  }
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