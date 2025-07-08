from dotenv import load_dotenv
load_dotenv()
import os
import sys
import json
import boto3
from botocore.exceptions import BotoCoreError, ClientError

def ask_claude(prompt):
    aws_region = os.getenv('AWS_REGION')
    model_id = os.getenv('MODEL_ID')
    if not aws_region or not model_id:
        raise ValueError('AWS_REGION and MODEL_ID must be set in environment variables')

    bedrock = boto3.client('bedrock-runtime', region_name=aws_region)
    try:
        response = bedrock.invoke_model(
            modelId=model_id,
            body=json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "messages": [
                    {"role": "user", "content": prompt}
                ],
                "max_tokens": 1024,
                "temperature": 0.2
            }),
            accept='application/json',
            contentType='application/json'
        )
        result = json.loads(response['body'].read())
        # Print raw Claude response for debugging
        print(f"RAW_CLAUDE_RESPONSE: {result}", file=sys.stderr)
        # For Claude Messages API, the output is in result['content'][0]['text']
        if 'content' in result and isinstance(result['content'], list) and 'text' in result['content'][0]:
            return result['content'][0]['text']
        return result
    except (BotoCoreError, ClientError) as e:
        return {"error": str(e)}

def main():
    try:
        prompt = sys.stdin.read()
        result = ask_claude(prompt)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main() 