// Cloudflare R2 Storage Client
// 用於將對話紀錄上傳到 R2 並從 R2 查詢

(function initR2Client() {
  'use strict';

  // R2 配置（從 chrome.storage.local 讀取）
  let r2Config = null;

  // 載入 R2 配置
  async function loadR2Config() {
    try {
      const result = await chrome.storage.local.get(['r2Config']);
      r2Config = result.r2Config || null;
      return r2Config;
    } catch (error) {
      console.error('[R2] 載入配置失敗:', error);
      return null;
    }
  }

  // 保存 R2 配置
  async function saveR2Config(config) {
    try {
      await chrome.storage.local.set({ r2Config: config });
      r2Config = config;
      return true;
    } catch (error) {
      console.error('[R2] 保存配置失敗:', error);
      return false;
    }
  }

  // 生成 AWS S3 兼容的簽名（用於 R2）
  function generateSignature(method, path, headers, secretAccessKey) {
    // R2 使用 AWS S3 兼容的簽名算法
    const crypto = self.crypto || window.crypto;
    
    // 簡化版本：使用 fetch 的 credentials 或直接使用預簽名 URL
    // 注意：在 Service Worker 中，我們需要使用 S3 API 兼容的方式
    return null; // 將使用預簽名 URL 或直接配置
  }

  // 構建 R2 URL
  function buildR2Url(bucket, key, endpoint) {
    if (endpoint) {
      // 使用自定義端點
      return `${endpoint}/${key}`;
    }
    // 使用 Cloudflare R2 默認端點
    return `https://${bucket}.r2.cloudflarestorage.com/${key}`;
  }

  // 上傳文件到 R2
  async function uploadToR2(key, data, contentType = 'application/json') {
    try {
      if (!r2Config) {
        await loadR2Config();
      }
      
      if (!r2Config || !r2Config.accountId || !r2Config.accessKeyId || !r2Config.secretAccessKey || !r2Config.bucket) {
        throw new Error('R2 配置不完整，請先設定 R2 憑證');
      }

      const endpoint = r2Config.endpoint || `https://${r2Config.accountId}.r2.cloudflarestorage.com`;
      const url = buildR2Url(r2Config.bucket, key, r2Config.endpoint);
      
      // 將數據轉換為 Blob（如果是對象）
      let blob;
      if (typeof data === 'string') {
        blob = new Blob([data], { type: contentType });
      } else if (data instanceof Blob) {
        blob = data;
      } else {
        blob = new Blob([JSON.stringify(data, null, 2)], { type: contentType });
      }

      // 使用 AWS S3 兼容的 API 上傳
      // 注意：R2 使用 S3 兼容的 API，但需要正確的簽名
      // 這裡使用 fetch 配合 AWS Signature Version 4
      const timestamp = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '');
      const date = timestamp.substr(0, 8);
      
      // 簡化實現：使用預簽名 URL 或直接使用 R2 API
      // 實際生產環境應該使用 AWS SDK 或實現完整的簽名算法
      
      // 計算 payload hash
      const payloadHash = await sha256(await blob.arrayBuffer());
      
      // 生成簽名
      const authorization = await generateAwsSignature('PUT', key, timestamp, r2Config.secretAccessKey, payloadHash);
      
      // 使用 fetch 上傳（需要正確的認證頭）
      const host = r2Config.endpoint 
        ? new URL(r2Config.endpoint).host 
        : `${r2Config.bucket}.r2.cloudflarestorage.com`;
      
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Authorization': authorization,
          'x-amz-date': timestamp,
          'x-amz-content-sha256': payloadHash,
          'Host': host
        },
        body: blob
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`R2 上傳失敗: ${response.status} ${response.statusText} - ${errorText}`);
      }

      console.log(`[R2] ✓ 上傳成功: ${key}`);
      return { success: true, key, url };
    } catch (error) {
      console.error('[R2] 上傳失敗:', error);
      throw error;
    }
  }

  // 從 R2 下載文件
  async function downloadFromR2(key) {
    try {
      if (!r2Config) {
        await loadR2Config();
      }
      
      if (!r2Config || !r2Config.accountId || !r2Config.accessKeyId || !r2Config.secretAccessKey || !r2Config.bucket) {
        throw new Error('R2 配置不完整，請先設定 R2 憑證');
      }

      const endpoint = r2Config.endpoint || `https://${r2Config.accountId}.r2.cloudflarestorage.com`;
      const url = buildR2Url(r2Config.bucket, key, r2Config.endpoint);
      
      const timestamp = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '');
      
      // 生成簽名（GET 請求不需要 payload hash）
      const authorization = await generateAwsSignature('GET', key, timestamp, r2Config.secretAccessKey, null);
      
      const host = r2Config.endpoint 
        ? new URL(r2Config.endpoint).host 
        : `${r2Config.bucket}.r2.cloudflarestorage.com`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': authorization,
          'x-amz-date': timestamp,
          'Host': host
        }
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null; // 文件不存在
        }
        const errorText = await response.text();
        throw new Error(`R2 下載失敗: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      console.log(`[R2] ✓ 下載成功: ${key}`);
      return data;
    } catch (error) {
      console.error('[R2] 下載失敗:', error);
      throw error;
    }
  }

  // 列出 R2 中的文件（前綴匹配）
  async function listR2Objects(prefix, maxKeys = 1000) {
    try {
      if (!r2Config) {
        await loadR2Config();
      }
      
      if (!r2Config || !r2Config.accountId || !r2Config.accessKeyId || !r2Config.secretAccessKey || !r2Config.bucket) {
        throw new Error('R2 配置不完整，請先設定 R2 憑證');
      }

      // R2 的 ListObjectsV2 API 使用 bucket 作為路徑
      // URL 格式: https://{accountId}.r2.cloudflarestorage.com/{bucket}?list-type=2&prefix=...
      const endpoint = r2Config.endpoint || `https://${r2Config.accountId}.r2.cloudflarestorage.com`;
      const queryString = `list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=${maxKeys}`;
      const url = `${endpoint}/${r2Config.bucket}?${queryString}`;
      
      const timestamp = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '');
      
      // 生成簽名（包含查詢參數）
      // canonical URI 應該是 /{bucket}，查詢參數在 canonical query string 中
      const canonicalUri = `/${r2Config.bucket}`;
      const canonicalQueryString = queryString;
      const listKey = `${canonicalUri}?${canonicalQueryString}`;
      const authorization = await generateAwsSignature('GET', listKey, timestamp, r2Config.secretAccessKey, null);
      
      const host = r2Config.endpoint 
        ? new URL(r2Config.endpoint).host 
        : `${r2Config.accountId}.r2.cloudflarestorage.com`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': authorization,
          'x-amz-date': timestamp,
          'Host': host
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`R2 列表失敗: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const xmlText = await response.text();
      // 解析 XML 響應（簡化版本，實際應該使用 XML 解析器）
      const objects = [];
      const keyMatches = xmlText.matchAll(/<Key>(.*?)<\/Key>/g);
      for (const match of keyMatches) {
        objects.push(match[1]);
      }

      console.log(`[R2] ✓ 列出 ${objects.length} 個對象 (前綴: ${prefix})`);
      return objects;
    } catch (error) {
      console.error('[R2] 列表失敗:', error);
      throw error;
    }
  }

  // 生成 AWS Signature Version 4
  // 參考：https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-auth-using-authorization-header.html
  async function generateAwsSignature(method, key, timestamp, secretAccessKey, payloadHash = null, region = 'auto') {
    try {
      const date = timestamp.substr(0, 8);
      const service = 's3';
      const algorithm = 'AWS4-HMAC-SHA256';
      
      // 構建 host
      const host = r2Config.endpoint 
        ? new URL(r2Config.endpoint).host 
        : `${r2Config.bucket}.r2.cloudflarestorage.com`;
      
      // Step 1: Create canonical request
      // 處理 key 可能包含查詢參數的情況
      let canonicalUri, canonicalQueryString;
      if (key.includes('?')) {
        const parts = key.split('?');
        canonicalUri = parts[0].startsWith('/') ? parts[0] : '/' + parts[0];
        canonicalQueryString = parts.slice(1).join('?'); // 處理多個 ? 的情況
      } else {
        canonicalUri = key.startsWith('/') ? key : '/' + key;
        canonicalQueryString = '';
      }
      const canonicalHeaders = `host:${host}\nx-amz-date:${timestamp}\n`;
      const signedHeaders = 'host;x-amz-date';
      
      // 如果沒有提供 payload hash，計算空字符串的 hash（對於 GET 請求）
      if (!payloadHash) {
        payloadHash = await sha256('');
      }
      
      const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
      
      // Step 2: Create string to sign
      const credentialScope = `${date}/${region}/${service}/aws4_request`;
      const canonicalRequestHash = await sha256(canonicalRequest);
      const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${canonicalRequestHash}`;
      
      // Step 3: Calculate signature
      const kDate = await hmacSha256Bytes(secretAccessKey, date);
      const kRegion = await hmacSha256Bytes(kDate, region);
      const kService = await hmacSha256Bytes(kRegion, service);
      const kSigning = await hmacSha256Bytes(kService, 'aws4_request');
      const signatureBytes = await hmacSha256Bytes(kSigning, stringToSign);
      const signature = Array.from(signatureBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      
      // Step 4: Create authorization header
      const authorization = `${algorithm} Credential=${r2Config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
      
      return authorization;
    } catch (error) {
      console.error('[R2] 生成簽名失敗:', error);
      throw new Error('無法生成 AWS 簽名: ' + error.message);
    }
  }

  // HMAC-SHA256 (返回 Uint8Array)
  async function hmacSha256Bytes(key, message) {
    // 確保 TextEncoder 可用（在 Service Worker 中）
    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : {
      encode: (str) => {
        const utf8 = [];
        for (let i = 0; i < str.length; i++) {
          let charcode = str.charCodeAt(i);
          if (charcode < 0x80) utf8.push(charcode);
          else if (charcode < 0x800) {
            utf8.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
          } else if (charcode < 0xd800 || charcode >= 0xe000) {
            utf8.push(0xe0 | (charcode >> 12), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
          } else {
            i++;
            charcode = 0x10000 + (((charcode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
            utf8.push(0xf0 | (charcode >> 18), 0x80 | ((charcode >> 12) & 0x3f), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
          }
        }
        return new Uint8Array(utf8);
      }
    };
    
    const keyData = typeof key === 'string' ? encoder.encode(key) : key;
    const messageData = typeof message === 'string' ? encoder.encode(message) : message;
    
    // 確保 crypto.subtle 可用
    if (!crypto || !crypto.subtle) {
      throw new Error('crypto.subtle is not available in this environment');
    }
    
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    return new Uint8Array(signature);
  }

  // SHA256 哈希（返回十六進制字符串）
  async function sha256(data) {
    // 確保 crypto.subtle 可用
    if (!crypto || !crypto.subtle) {
      throw new Error('crypto.subtle is not available in this environment');
    }
    
    let buffer;
    if (data instanceof ArrayBuffer) {
      buffer = data;
    } else if (data instanceof Uint8Array) {
      buffer = data.buffer;
    } else if (typeof data === 'string') {
      // 確保 TextEncoder 可用
      const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : {
        encode: (str) => {
          const utf8 = [];
          for (let i = 0; i < str.length; i++) {
            let charcode = str.charCodeAt(i);
            if (charcode < 0x80) utf8.push(charcode);
            else if (charcode < 0x800) {
              utf8.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
            } else if (charcode < 0xd800 || charcode >= 0xe000) {
              utf8.push(0xe0 | (charcode >> 12), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
            } else {
              i++;
              charcode = 0x10000 + (((charcode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
              utf8.push(0xf0 | (charcode >> 18), 0x80 | ((charcode >> 12) & 0x3f), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
            }
          }
          return new Uint8Array(utf8);
        }
      };
      buffer = encoder.encode(data).buffer;
    } else {
      throw new Error('不支持的數據類型');
    }
    
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // 上傳對話到 R2
  async function uploadConversation(chatId, userProfile, conversationData) {
    try {
      const profile = userProfile || 'default';
      const key = `conversations/${profile}/${chatId}.json`;
      
      const data = {
        chatId,
        userProfile: profile,
        ...conversationData,
        uploadedAt: Date.now(),
        version: '1.0'
      };
      
      return await uploadToR2(key, data);
    } catch (error) {
      console.error('[R2] 上傳對話失敗:', error);
      throw error;
    }
  }

  // 從 R2 下載對話
  async function downloadConversation(chatId, userProfile) {
    try {
      const profile = userProfile || 'default';
      const key = `conversations/${profile}/${chatId}.json`;
      return await downloadFromR2(key);
    } catch (error) {
      console.error('[R2] 下載對話失敗:', error);
      throw error;
    }
  }

  // 列出所有對話（從 R2）
  async function listConversations(userProfile) {
    try {
      const profile = userProfile || 'default';
      const prefix = `conversations/${profile}/`;
      const keys = await listR2Objects(prefix);
      
      // 過濾出 .json 文件並提取 chatId
      const conversations = [];
      for (const key of keys) {
        if (key.endsWith('.json') && !key.endsWith('index.json')) {
          const chatId = key.replace(prefix, '').replace('.json', '');
          try {
            const data = await downloadConversation(chatId, profile);
            if (data) {
              conversations.push({
                chatId,
                userProfile: profile,
                title: data.title || '未命名對話',
                url: data.url || `https://gemini.google.com/app/${chatId}`,
                lastUpdated: data.lastUpdated || data.uploadedAt || Date.now(),
                messageCount: data.messages ? data.messages.length : 0
              });
            }
          } catch (err) {
            console.warn(`[R2] 跳過無效對話: ${chatId}`, err);
          }
        }
      }
      
      return conversations.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
    } catch (error) {
      console.error('[R2] 列出對話失敗:', error);
      throw error;
    }
  }

  // 上傳對話索引（用於快速查詢）
  async function uploadConversationIndex(userProfile, conversations) {
    try {
      const profile = userProfile || 'default';
      const key = `conversations/${profile}/index.json`;
      
      const index = {
        userProfile: profile,
        conversations: conversations.map(c => ({
          chatId: c.chatId,
          title: c.title || '未命名對話',
          url: c.url,
          lastUpdated: c.lastUpdated || Date.now(),
          messageCount: c.messageCount || 0
        })),
        updatedAt: Date.now()
      };
      
      return await uploadToR2(key, index);
    } catch (error) {
      console.error('[R2] 上傳索引失敗:', error);
      throw error;
    }
  }

  // 從 R2 下載對話索引
  async function downloadConversationIndex(userProfile) {
    try {
      const profile = userProfile || 'default';
      const key = `conversations/${profile}/index.json`;
      return await downloadFromR2(key);
    } catch (error) {
      if (error.message && error.message.includes('404')) {
        return null; // 索引不存在
      }
      throw error;
    }
  }

  // 批量上傳所有對話
  async function uploadAllConversations(userProfile) {
    try {
      if (!self.GeminiLocalDB) {
        throw new Error('GeminiLocalDB not available');
      }

      const profile = userProfile || 'default';
      const conversations = await self.GeminiLocalDB.listConversations(profile);
      
      const results = {
        total: conversations.length,
        success: 0,
        failed: 0,
        errors: []
      };

      for (const conv of conversations) {
        try {
          const messages = await self.GeminiLocalDB.getConversationMessages({
            chatId: conv.chatId,
            userProfile: profile
          });
          
          await uploadConversation(conv.chatId, profile, {
            title: conv.title,
            url: conv.url,
            lastUpdated: conv.lastUpdated,
            createdAt: conv.createdAt,
            messages: messages || []
          });
          
          results.success++;
          console.log(`[R2] ✓ 上傳對話: ${conv.chatId} (${results.success}/${results.total})`);
        } catch (error) {
          results.failed++;
          results.errors.push({
            chatId: conv.chatId,
            error: error.message || String(error)
          });
          console.error(`[R2] ✗ 上傳對話失敗: ${conv.chatId}`, error);
        }
      }

      // 上傳索引
      try {
        await uploadConversationIndex(profile, conversations);
        console.log('[R2] ✓ 上傳對話索引');
      } catch (error) {
        console.error('[R2] ✗ 上傳索引失敗:', error);
      }

      return results;
    } catch (error) {
      console.error('[R2] 批量上傳失敗:', error);
      throw error;
    }
  }

  // 從 R2 同步對話到本地（下載並導入）
  async function syncConversationsFromR2(userProfile, chatIds = null) {
    try {
      const profile = userProfile || 'default';
      
      // 如果指定了 chatIds，只下載這些對話；否則下載所有
      let conversationsToSync = [];
      
      if (chatIds && Array.isArray(chatIds) && chatIds.length > 0) {
        conversationsToSync = chatIds;
      } else {
        const index = await downloadConversationIndex(profile);
        if (index && index.conversations) {
          conversationsToSync = index.conversations.map(c => c.chatId);
        } else {
          // 如果沒有索引，嘗試列出所有文件
          const prefix = `conversations/${profile}/`;
          const keys = await listR2Objects(prefix);
          conversationsToSync = keys
            .filter(k => k.endsWith('.json') && !k.endsWith('index.json'))
            .map(k => k.replace(prefix, '').replace('.json', ''));
        }
      }

      const results = {
        total: conversationsToSync.length,
        success: 0,
        failed: 0,
        errors: []
      };

      if (!self.GeminiLocalDB) {
        throw new Error('GeminiLocalDB not available');
      }

      for (const chatId of conversationsToSync) {
        try {
          const data = await downloadConversation(chatId, profile);
          if (!data) {
            results.failed++;
            results.errors.push({ chatId, error: '對話不存在' });
            continue;
          }

          // 導入到本地 DB
          if (data.messages && Array.isArray(data.messages) && data.messages.length > 0) {
            await self.GeminiLocalDB.addOrMergeMessages({
              chatId,
              userProfile: profile,
              messages: data.messages
            });
          }

          // 更新對話元數據
          await self.GeminiLocalDB.upsertConversationMeta({
            chatId,
            userProfile: profile,
            title: data.title || '未命名對話',
            url: data.url || `https://gemini.google.com/app/${chatId}`,
            lastUpdated: data.lastUpdated || data.uploadedAt || Date.now()
          });

          results.success++;
          console.log(`[R2] ✓ 同步對話: ${chatId} (${results.success}/${results.total})`);
        } catch (error) {
          results.failed++;
          results.errors.push({
            chatId,
            error: error.message || String(error)
          });
          console.error(`[R2] ✗ 同步對話失敗: ${chatId}`, error);
        }
      }

      return results;
    } catch (error) {
      console.error('[R2] 同步失敗:', error);
      throw error;
    }
  }

  // 驗證 R2 配置
  async function testR2Connection() {
    try {
      if (!r2Config) {
        await loadR2Config();
      }
      
      if (!r2Config || !r2Config.accountId || !r2Config.accessKeyId || !r2Config.secretAccessKey || !r2Config.bucket) {
        return { success: false, error: 'R2 配置不完整' };
      }

      // 嘗試列出 bucket（使用空前綴，限制 1 個結果）
      await listR2Objects('', 1);
      return { success: true, message: 'R2 連接成功' };
    } catch (error) {
      return { success: false, error: error.message || String(error) };
    }
  }

  // 暴露 API
  self.R2Client = {
    loadConfig: loadR2Config,
    saveConfig: saveR2Config,
    uploadConversation,
    downloadConversation,
    listConversations,
    uploadConversationIndex,
    downloadConversationIndex,
    uploadAllConversations,
    syncConversationsFromR2,
    testConnection: testR2Connection,
    uploadToR2,
    downloadFromR2,
    listR2Objects
  };
})();
