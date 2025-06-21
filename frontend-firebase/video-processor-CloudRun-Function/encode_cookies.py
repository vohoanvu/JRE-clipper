#!/usr/bin/env python3
"""
Helper script to encode YouTube cookies for Cloud Run environment variables.
This script will take your cookies.txt file and encode it for deployment.
"""

import base64
import os

def encode_cookies_file(cookie_file_path):
    """
    Read cookies file and encode it for environment variable
    """
    try:
        with open(cookie_file_path, 'r') as f:
            cookie_content = f.read()
        
        # Base64 encode the content
        encoded_cookies = base64.b64encode(cookie_content.encode('utf-8')).decode('utf-8')
        
        print("✅ Successfully encoded cookies file!")
        print(f"📁 Source file: {cookie_file_path}")
        print(f"📏 Original size: {len(cookie_content)} characters")
        print(f"📏 Encoded size: {len(encoded_cookies)} characters")
        print()
        print("🔧 CLOUD RUN ENVIRONMENT VARIABLE:")
        print("Variable Name: YOUTUBE_COOKIES")
        print("Variable Value:")
        print("-" * 50)
        print(encoded_cookies)
        print("-" * 50)
        print()
        print("📋 DEPLOYMENT COMMANDS:")
        print()
        print("For Cloud Run deployment, use:")
        print(f'gcloud run deploy video-processor \\')
        print(f'  --source . \\')
        print(f'  --platform managed \\')
        print(f'  --region us-central1 \\')
        print(f'  --set-env-vars="YOUTUBE_COOKIES={encoded_cookies[:50]}..." \\')
        print(f'  --memory 2Gi \\')
        print(f'  --timeout 3600')
        print()
        print("⚠️  SECURITY REMINDER:")
        print("• Keep this encoded value secure - it contains your YouTube login session")
        print("• Don't commit this value to version control")
        print("• Cookies expire periodically and will need to be refreshed")
        print("• Use Google Secret Manager for production deployments")
        
        return encoded_cookies
        
    except FileNotFoundError:
        print(f"❌ Error: Could not find cookies file at {cookie_file_path}")
        return None
    except Exception as e:
        print(f"❌ Error encoding cookies: {e}")
        return None

def save_deployment_script(encoded_cookies):
    """
    Save a deployment script with the encoded cookies
    """
    script_content = f'''#!/bin/bash
# YouTube Cookies Deployment Script
# Generated automatically - DO NOT commit to version control

echo "Deploying Cloud Run Function with YouTube cookies..."

gcloud run deploy video-processor \\
  --source . \\
  --platform managed \\
  --region us-central1 \\
  --set-env-vars="YOUTUBE_COOKIES={encoded_cookies}" \\
  --memory 2Gi \\
  --timeout 3600 \\
  --allow-unauthenticated

echo "Deployment complete!"
'''
    
    with open('deploy_with_cookies.sh', 'w') as f:
        f.write(script_content)
    
    # Make executable
    os.chmod('deploy_with_cookies.sh', 0o755)
    
    print("📝 Created deployment script: deploy_with_cookies.sh")
    print("   Run with: ./deploy_with_cookies.sh")

if __name__ == "__main__":
    # Look for cookies.txt in current directory
    cookie_file = "cookies.txt"
    
    if not os.path.exists(cookie_file):
        print("Looking for cookies.txt file...")
        print("Please make sure your exported YouTube cookies are saved as 'cookies.txt'")
        print("Or specify the path:")
        cookie_file = input("Enter path to cookies file: ").strip()
    
    if os.path.exists(cookie_file):
        encoded = encode_cookies_file(cookie_file)
        if encoded:
            save_deployment_script(encoded)
    else:
        print(f"❌ Could not find cookies file: {cookie_file}")
