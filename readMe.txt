aws sso login --profile your-profile-name

AI-Test-Framework: AI-Powered Unified Automation Framework
========================================================

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

AWS SSO Configuration
---------------------
1. Install AWS CLI:
   brew install awscli
2. Configure AWS SSO profile:
   aws configure sso
   # Use the following when prompted:
   # SSO start URL: "Get this details from your org"
   # SSO region: Get this details from your org
   # SSO account ID: Get this details from your org
   # SSO role name: Get this details from your org
   # CLI default client Region: Get this details from your org
   # CLI default output format: json
   # SSO session name: Get this details from your org
3. Login to SSO:
   aws sso login --profile your-profile-name


Usage
-----
- Add your test cases as `.txt` files in `test_cases/`.
- To run all test cases:
    cd runner
    npm start
- To run a specific test case:
    npm start -- your_test_case.txt
- View HTML/JSON reports in `reports/`.

Extending
---------
- Add new actions by updating the system prompt and `runTestCase` in `runner/index.js`.
- Add new utility modules for other databases or services as needed.

Note
----
This is still a basic prototype which can do UI, DB, and API testing all in one, but a lot can be improved. If anyone wants to contribute, please do!
