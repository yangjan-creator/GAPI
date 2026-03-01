#!/bin/bash
# 影 🌊 專用：Agent-to-Cursor 指令橋接
TASK=$1
echo "[$(date)] 向 Cursor 發送任務: $TASK" >> /home/sky/.openclaw/workspace/projects/GEMINISIDE_DEV/server/cursor_log.txt
# 模擬發送 (正式版本將調用 cursor 命令列)
