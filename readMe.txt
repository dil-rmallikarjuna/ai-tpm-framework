aws sso login --profile dil-3pm-dev

AI-TPM: AI-Powered Unified Automation Framework
===============================================

Overview
--------
This framework enables end-to-end automation of UI, Database, and API test cases using natural language instructions. It leverages:
- Claude LLM via AWS Bedrock for prompt-to-steps conversion
- Playwright MCP for UI automation
- MySQL MCP for database validation
- Axios MCP for API testing
- Node.js orchestrator and Python LLM bridge

Features
--------
- Write test cases in plain English (`test_cases/*.txt`)
- Supports UI, DB, and API steps in a single test
- Headless execution (CI/CD ready)
- HTML/JSON reports with step-by-step screenshots
- Extensible for new action types

Directory Structure
-------------------
llm_bridge/      # Python LLM bridge
runner/          # Node.js orchestrator
reports/         # Test run reports and screenshots
test_cases/      # Your natural language test cases

Setup
-----
1. Install Node.js dependencies:
   cd runner
   npm install
2. Set up Python venv and install requirements:
   cd ../llm_bridge
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
3. Configure `.env` with AWS and DB credentials at project root.

Usage
-----
- Add your test cases as `.txt` files in `test_cases/`.
- To run all test cases:
    cd runner
    npm start
- To run a specific test case:
    npm start -- your_test_case.txt
- View HTML/JSON reports in `reports/`.

Supported Actions
-----------------
- goto        # Navigate to a URL
- fill        # Fill a form field
- click       # Click a button or element
- assert      # Assert element visibility/existence
- db_query    # Run a SQL query on MySQL
- api_request # Make an HTTP request (GET, POST, etc.)

Extending
---------
- Add new actions by updating the system prompt and `runTestCase` in `runner/index.js`.
- Add new utility modules for other databases or services as needed.
