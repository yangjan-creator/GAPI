export type UserProfile = string;

export type ConversationMeta = {
  convKey?: string;
  chatId: string;
  userProfile: string;
  title: string;
  url: string;
  lastUpdated?: number;
  createdAt?: number;
};

export type ChatMessage = {
  role: 'user' | 'model' | 'assistant' | 'unknown' | string;
  text: string;
  timestamp?: number;
  hash?: string;
  id?: string | null;
  images?: Array<{ id?: string; url?: string; alt?: string; originalUrl?: string; downloadUrl?: string }>;
  codeBlocks?: Array<{ type?: string; text?: string; language?: string | null }>;
};

type ChromeRuntime = {
  runtime: {
    sendMessage: (
      extensionId: string,
      message: any,
      optionsOrCallback?: any,
      maybeCallback?: (response: any) => void
    ) => void;
    connect?: (extensionId: string, connectInfo?: { name?: string }) => {
      name?: string;
      postMessage: (msg: any) => void;
      disconnect: () => void;
      onMessage: { addListener: (fn: (msg: any) => void) => void };
      onDisconnect: { addListener: (fn: () => void) => void };
    };
    lastError?: { message?: string };
  };
};

function getChrome(): ChromeRuntime | null {
  // In pages allowed by externally_connectable, Chrome exposes chrome.runtime
  // when an extension is listening.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyWin = window as any;
  if (anyWin?.chrome?.runtime?.sendMessage) return anyWin.chrome as ChromeRuntime;
  return null;
}

export class ExtensionApi {
  constructor(private extensionId: string) {}

  async send<T = any>(message: any): Promise<T> {
    const chromeObj = getChrome();
    if (!chromeObj) {
      throw new Error('chrome.runtime 不存在（確認你在 Chrome、extension 已安裝，且本頁網址在 externally_connectable 白名單）');
    }

    return new Promise<T>((resolve, reject) => {
      const cb = (resp: any) => {
        const errMsg = chromeObj.runtime?.lastError?.message;
        if (errMsg) reject(new Error(errMsg));
        else resolve(resp as T);
      };

      try {
        // Chrome signature variants: sendMessage(extensionId, message, callback)
        chromeObj.runtime.sendMessage(this.extensionId, message, cb);
      } catch (e: any) {
        reject(e);
      }
    });
  }

  listProfiles() {
    return this.send<{ success: boolean; profiles: UserProfile[]; error?: string }>({ action: 'ADMIN_LIST_PROFILES' });
  }

  listConversations(userProfile: string) {
    return this.send<{ success: boolean; conversations: ConversationMeta[]; error?: string }>({
      action: 'ADMIN_LIST_CONVERSATIONS',
      data: { userProfile }
    });
  }

  getConversationMessages(userProfile: string, chatId: string) {
    return this.send<{ success: boolean; messages: ChatMessage[]; error?: string }>({
      action: 'ADMIN_GET_CONVERSATION_MESSAGES',
      data: { userProfile, chatId }
    });
  }

  sendMessageToChat(userProfile: string, chatId: string, messageText: string) {
    return this.send<{ success: boolean; error?: string }>({
      action: 'ADMIN_SEND_MESSAGE_TO_CHAT',
      data: { userProfile, chatId, messageText }
    });
  }

  uploadBegin(userProfile: string, chatId: string, prefix: string, filename: string, mime: string) {
    return this.send<{ success: boolean; uploadId?: string; error?: string }>({
      action: 'ADMIN_UPLOAD_BEGIN',
      data: { userProfile, chatId, prefix, filename, mime }
    });
  }

  uploadChunk(uploadId: string, chunk: string) {
    return this.send<{ success: boolean; error?: string }>({
      action: 'ADMIN_UPLOAD_CHUNK',
      data: { uploadId, chunk }
    });
  }

  uploadCommit(uploadId: string, messageText: string) {
    return this.send<{ success: boolean; error?: string }>({
      action: 'ADMIN_UPLOAD_COMMIT',
      data: { uploadId, messageText }
    });
  }

  uploadAbort(uploadId: string) {
    return this.send<{ success: boolean; error?: string }>({
      action: 'ADMIN_UPLOAD_ABORT',
      data: { uploadId }
    });
  }

  getDownloadBaseFolder() {
    return this.send<{ success: boolean; downloadBaseFolder: string; error?: string }>({
      action: 'ADMIN_GET_DOWNLOAD_BASE_FOLDER'
    });
  }

  setDownloadBaseFolder(downloadBaseFolder: string) {
    return this.send<{ success: boolean; downloadBaseFolder: string; error?: string }>({
      action: 'ADMIN_SET_DOWNLOAD_BASE_FOLDER',
      data: { downloadBaseFolder }
    });
  }

  listOpenTabs() {
    return this.send<{ success: boolean; tabs: any[]; error?: string }>({ action: 'ADMIN_LIST_OPEN_TABS' });
  }

  focusTab(tabId: number) {
    return this.send<{ success: boolean; error?: string }>({ action: 'ADMIN_FOCUS_TAB', data: { tabId } });
  }

  connectAdminEvents(onEvent: (ev: any) => void) {
    const chromeObj = getChrome();
    if (!chromeObj?.runtime?.connect) {
      throw new Error('chrome.runtime.connect 不可用（需要 background.js 的 onConnectExternal）');
    }
    const port = chromeObj.runtime.connect(this.extensionId, { name: 'gemini-admin' });
    port.onMessage.addListener((msg: any) => onEvent(msg));
    port.onDisconnect.addListener(() => onEvent({ type: 'disconnected' }));
    try {
      port.postMessage({ type: 'ping' });
    } catch {
      // ignore
    }
    return {
      disconnect: () => {
        try {
          port.disconnect();
        } catch {
          // ignore
        }
      }
    };
  }
}

