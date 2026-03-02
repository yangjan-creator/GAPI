#!/usr/bin/env python3
"""GAPI Integration Test - Full Flow Test"""

import requests
import json
import sys

BASE_URL = "http://localhost:18799"

def test_full_flow():
    print("=== GAPI Full Flow Test ===\n")
    
    # 1. Get Pages
    print("1. Get Pages...")
    r = requests.get(f"{BASE_URL}/v1/pages")
    print(f"   Status: {r.status_code}")
    pages = r.json()
    print(f"   Pages: {pages.get('meta', {}).get('total', 0)}")
    
    # 2. Get Conversations
    print("\n2. Get Conversations...")
    r = requests.get(f"{BASE_URL}/v1/conversations?site=gemini")
    print(f"   Status: {r.status_code}")
    convs = r.json()
    print(f"   Conversations: {len(convs.get('conversations', []))}")
    
    if convs.get('conversations'):
        conv_id = convs['conversations'][0]['id']
        print(f"   First conv: {conv_id}")
        
        # 3. Get Messages
        print("\n3. Get Messages...")
        r = requests.get(f"{BASE_URL}/v1/conversations/{conv_id}")
        print(f"   Status: {r.status_code}")
        
        # 4. Send Message
        print("\n4. Send Message...")
        msg_data = {
            "conversation_id": conv_id,
            "content": "Test message from API integration test!"
        }
        r = requests.post(f"{BASE_URL}/v1/messages", json=msg_data)
        print(f"   Status: {r.status_code}")
        result = r.json()
        print(f"   Result: {result}")
        
        if 'message_id' in result:
            print("\n✅ All tests passed!")
            return True
        else:
            print(f"\n❌ Failed: {result}")
            return False
    else:
        print("\n❌ No conversations found")
        return False

if __name__ == "__main__":
    success = test_full_flow()
    sys.exit(0 if success else 1)
