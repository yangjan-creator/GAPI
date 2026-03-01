/**
 * GAPI 對話數據封裝模組
 * 將 content.js 提取的對話數據轉換為符合 API_SPEC.md 格式
 * 
 * 用法:
 *   const apiData = formatConversationForAPI(messages, conversationId);
 *   const apiMessage = formatMessageForAPI(rawMessage, conversationId);
 */

// 將對話消息陣列轉換為 API 格式
function formatConversationForAPI(messages, conversationId, conversationTitle = null) {
  if (!messages || !Array.isArray(messages)) {
    return {
      id: conversationId || null,
      title: conversationTitle || null,
      messages: [],
      created_at: Date.now(),
      updated_at: Date.now()
    };
  }

  // 轉換每條消息為 API 格式
  const formattedMessages = messages.map(msg => formatMessageForAPI(msg, conversationId));

  // 找到最早的時間戳作為創建時間
  const timestamps = formattedMessages.map(m => m.timestamp).filter(t => t > 0);
  const created_at = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
  const updated_at = timestamps.length > 0 ? Math.max(...timestamps) : Date.now();

  return {
    id: conversationId || null,
    title: conversationTitle || null,
    messages: formattedMessages,
    created_at: created_at,
    updated_at: updated_at
  };
}

// 將單條消息轉換為 API 格式
function formatMessageForAPI(rawMessage, conversationId) {
  if (!rawMessage) {
    return null;
  }

  // 處理附件（圖片）
  let attachments = [];
  if (rawMessage.images && Array.isArray(rawMessage.images)) {
    attachments = rawMessage.images
      .filter(img => img && img.url)
      .map(img => {
        // 如果有下載URL使用下載URL，否則使用原始URL
        return img.downloadUrl || img.originalUrl || img.url;
      });
  }

  // 構建符合 API_SPEC.md 格式的消息對象
  const apiMessage = {
    id: rawMessage.id || generateMessageId(),
    conversation_id: conversationId || rawMessage.chatId || null,
    role: normalizeRole(rawMessage.role),
    content: rawMessage.text || rawMessage.content || '',
    timestamp: rawMessage.timestamp || Date.now(),
    metadata: {}
  };

  // 添加附件
  if (attachments.length > 0) {
    apiMessage.attachments = attachments;
  }

  // 添加元數據
  if (rawMessage.extractedAt) {
    apiMessage.metadata.extracted_at = rawMessage.extractedAt;
  }

  if (rawMessage.codeBlocks && rawMessage.codeBlocks.length > 0) {
    apiMessage.metadata.code_blocks = rawMessage.codeBlocks.map(block => ({
      type: block.type || 'code',
      language: block.language || null,
      text: block.text
    }));
  }

  return apiMessage;
}

// 標準化角色名稱
function normalizeRole(role) {
  if (!role) return 'user';
  
  const roleMap = {
    'user': 'user',
    'human': 'user',
    'model': 'model',
    'assistant': 'model',
    'ai': 'model',
    'gemini': 'model',
    'system': 'system'
  };
  
  const normalizedRole = role.toLowerCase().trim();
  return roleMap[normalizedRole] || 'user';
}

// 生成消息 ID
function generateMessageId() {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// WebSocket 訊息格式封裝

// 封裝 conversation_sync 請求
function formatConversationSyncRequest(conversationId, lastMessageTs = null) {
  return {
    type: 'conversation_sync',
    payload: {
      conversation_id: conversationId,
      last_message_ts: lastMessageTs || Date.now()
    }
  };
}

// 封裝 conversation_data 回應
function formatConversationDataResponse(conversationId, messages, conversationTitle = null) {
  const formattedMessages = messages.map(msg => formatMessageForAPI(msg, conversationId));
  
  return {
    type: 'conversation_data',
    payload: {
      conversation_id: conversationId,
      title: conversationTitle,
      messages: formattedMessages
    }
  };
}

// 封裝 message_send 請求
function formatMessageSendRequest(conversationId, content, attachments = []) {
  return {
    type: 'message_send',
    payload: {
      conversation_id: conversationId,
      content: content,
      attachments: attachments
    }
  };
}

// 封裝 message_sent 回應
function formatMessageSentResponse(messageId, status = 'ok', errorMessage = null) {
  const response = {
    type: 'message_sent',
    payload: {
      message_id: messageId,
      status: status
    }
  };
  
  if (errorMessage) {
    response.payload.error_message = errorMessage;
  }
  
  return response;
}

// 封裝 event_push 事件
function formatEventPush(event, conversationId, message) {
  return {
    type: 'event_push',
    payload: {
      event: event,
      conversation_id: conversationId,
      message: formatMessageForAPI(message, conversationId)
    }
  };
}

// HTTP API 格式封裝

// GET /v1/conversations 回應格式
function formatConversationsListResponse(conversations) {
  return {
    conversations: conversations.map(conv => ({
      id: conv.id,
      title: conv.title,
      created_at: conv.created_at,
      updated_at: conv.updated_at
    }))
  };
}

// GET /v1/conversations/{conversation_id} 回應格式
function formatConversationDetailResponse(conversationId, messages, conversationTitle = null) {
  return formatConversationForAPI(messages, conversationId, conversationTitle);
}

// POST /v1/conversations 請求/回應格式
function formatCreateConversationRequest(title = null) {
  return {
    title: title
  };
}

function formatCreateConversationResponse(conversationId, title, createdAt = Date.now()) {
  return {
    id: conversationId,
    title: title,
    created_at: createdAt
  };
}

// POST /v1/messages 請求格式
function formatPostMessageRequest(conversationId, content, attachments = []) {
  return {
    conversation_id: conversationId,
    content: content,
    attachments: attachments
  };
}

// POST /v1/messages 回應格式
function formatPostMessageResponse(messageId, status = 'queued') {
  return {
    message_id: messageId,
    status: status
  };
}

// 匯出模組（支持 CommonJS 和 ES Modules）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatConversationForAPI,
    formatMessageForAPI,
    normalizeRole,
    generateMessageId,
    formatConversationSyncRequest,
    formatConversationDataResponse,
    formatMessageSendRequest,
    formatMessageSentResponse,
    formatEventPush,
    formatConversationsListResponse,
    formatConversationDetailResponse,
    formatCreateConversationRequest,
    formatCreateConversationResponse,
    formatPostMessageRequest,
    formatPostMessageResponse
  };
} else if (typeof window !== 'undefined') {
  window.GAPIFormatter = {
    formatConversationForAPI,
    formatMessageForAPI,
    normalizeRole,
    generateMessageId,
    formatConversationSyncRequest,
    formatConversationDataResponse,
    formatMessageSendRequest,
    formatMessageSentResponse,
    formatEventPush,
    formatConversationsListResponse,
    formatConversationDetailResponse,
    formatCreateConversationRequest,
    formatCreateConversationResponse,
    formatPostMessageRequest,
    formatPostMessageResponse
  };
}
