#!/bin/bash
# LobsterNode Deployer (Created by Kou)
echo "[LOBSTER] 正在啟動邊緣節點部署程序..."
echo "[LOBSTER] 檢查內網通訊..."
echo "[LOBSTER] 正在綁定 0.0.0.0:19000..."
# 物理鏈路：調用核心 API 服務
python3 /home/sky/.openclaw/workspace/projects/GEMINISIDE_DEV/server/api_gateway.py
