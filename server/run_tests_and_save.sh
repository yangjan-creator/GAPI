#!/usr/bin/env bash
# 在 GAPI/server 目錄執行，將 pytest 結果寫入專案根目錄
set -e
cd "$(dirname "$0")"
OUT="../TEST_RUN_RESULT.txt"

# 若有 venv 則啟用，否則用目前 Python
if [ -d "venv" ] && [ -f "venv/bin/activate" ]; then
  source venv/bin/activate
elif [ -d ".venv" ] && [ -f ".venv/bin/activate" ]; then
  source .venv/bin/activate
fi

pip install -q -r test-requirements.txt 2>/dev/null || true
python -m pytest tests/ -v --tb=short --ignore=tests/test_performance.py 2>&1 | tee "$OUT"
