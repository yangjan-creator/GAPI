// Side Panel JavaScript
// 處理分類管理和對話列表顯示

document.addEventListener('DOMContentLoaded', () => {
  // DOM 元素
  const profileSelector = document.getElementById('profileSelector');
  const newChatBtn = document.getElementById('newChatBtn');
  const pauseMonitoringBtn = document.getElementById('pauseMonitoringBtn');
  const addCategoryBtn = document.getElementById('addCategoryBtn');
  const autoSuggestBtn = document.getElementById('autoSuggestBtn');
  const searchInput = document.getElementById('searchInput');
  const categoriesSection = document.getElementById('categoriesSection');
  const modalOverlay = document.getElementById('modalOverlay');
  const categoryInput = document.getElementById('categoryInput');
  const confirmBtn = document.getElementById('confirmBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const toast = document.getElementById('toast');
  
  // 對話記錄相關元素
  const sendMessageInput = document.getElementById('sendMessageInput');
  const sendMessageBtn = document.getElementById('sendMessageBtn');
  const sendMessageFileInput = document.getElementById('sendMessageFileInput');
  const sendMessageAttachBtn = document.getElementById('sendMessageAttachBtn');
  const sendMessageAttachment = document.getElementById('sendMessageAttachment');
  const sendMessageAttachmentName = document.getElementById('sendMessageAttachmentName');
  const sendMessageAttachmentRemove = document.getElementById('sendMessageAttachmentRemove');
  const conversationHistoryHeader = document.getElementById('conversationHistoryHeader');
  const conversationHistoryToggle = document.getElementById('conversationHistoryToggle');
  const conversationHistoryContent = document.getElementById('conversationHistoryContent');
  const conversationMessages = document.getElementById('conversationMessages');
  const backupBtn = document.getElementById('backupBtn');

  // 對話列表相關元素
  const conversationListSection = document.getElementById('conversationListSection');
  const conversationListHeader = document.getElementById('conversationListHeader');
  const conversationListToggle = document.getElementById('conversationListToggle');
  const conversationListContent = document.getElementById('conversationListContent');
  const conversationListItems = document.getElementById('conversationListItems');
  const refreshConversationsBtn = document.getElementById('refreshConversationsBtn');

  // 圖片記錄相關元素
  const imagesRecordHeader = document.getElementById('imagesRecordHeader');
  const imagesRecordToggle = document.getElementById('imagesRecordToggle');
  const imagesRecordContent = document.getElementById('imagesRecordContent');
  const imagesRecordList = document.getElementById('imagesRecordList');
  const refreshImagesBtn = document.getElementById('refreshImagesBtn');

  // 下載按鈕測試相關元素
  const downloadButtonsTestSection = document.getElementById('downloadButtonsTestSection');
  const downloadButtonsTestHeader = document.getElementById('downloadButtonsTestHeader');
  const downloadButtonsTestToggle = document.getElementById('downloadButtonsTestToggle');
  const downloadButtonsTestContent = document.getElementById('downloadButtonsTestContent');
  const downloadButtonsTestList = document.getElementById('downloadButtonsTestList');
  const downloadButtonsCount = document.getElementById('downloadButtonsCount');
  const refreshDownloadButtonsBtn = document.getElementById('refreshDownloadButtonsBtn');

  // 操作日誌監控相關元素
  const operationLogsSection = document.getElementById('operationLogsSection');
  const operationLogsHeader = document.getElementById('operationLogsHeader');
  const operationLogsToggle = document.getElementById('operationLogsToggle');
  const operationLogsContent = document.getElementById('operationLogsContent');
  const operationLogsList = document.getElementById('operationLogsList');
  const operationLogsStats = document.getElementById('operationLogsStats');
  const logsTotalCount = document.getElementById('logsTotalCount');
  const logsLatestTime = document.getElementById('logsLatestTime');
  const exportLogsBtn = document.getElementById('exportLogsBtn');
  const refreshLogsBtn = document.getElementById('refreshLogsBtn');

  // 點擊監聽記錄相關元素
  const clickMonitorSection = document.getElementById('clickMonitorSection');
  const clickMonitorHeader = document.getElementById('clickMonitorHeader');
  const clickMonitorToggle = document.getElementById('clickMonitorToggle');
  const clickMonitorContent = document.getElementById('clickMonitorContent');
  const clickMonitorList = document.getElementById('clickMonitorList');
  const clickMonitorCount = document.getElementById('clickMonitorCount');
  const clickMonitorLatestTime = document.getElementById('clickMonitorLatestTime');
  const refreshClickMonitorBtn = document.getElementById('refreshClickMonitorBtn');
  const clearClickMonitorBtn = document.getElementById('clearClickMonitorBtn');
  const exportClickMonitorBtn = document.getElementById('exportClickMonitorBtn');

  // R2 儲存相關元素
  const r2StorageSection = document.getElementById('r2StorageSection');
  const r2StorageHeader = document.getElementById('r2StorageHeader');
  const r2StorageToggle = document.getElementById('r2StorageToggle');
  const r2StorageContent = document.getElementById('r2StorageContent');
  const r2AccountId = document.getElementById('r2AccountId');
  const r2AccessKeyId = document.getElementById('r2AccessKeyId');
  const r2SecretAccessKey = document.getElementById('r2SecretAccessKey');
  const r2Bucket = document.getElementById('r2Bucket');
  const r2Endpoint = document.getElementById('r2Endpoint');
  const r2SaveConfigBtn = document.getElementById('r2SaveConfigBtn');
  const r2LoadConfigBtn = document.getElementById('r2LoadConfigBtn');
  const r2TestConnectionBtn = document.getElementById('r2TestConnectionBtn');
  const r2ConfigStatus = document.getElementById('r2ConfigStatus');
  const r2UploadCurrentBtn = document.getElementById('r2UploadCurrentBtn');
  const r2UploadAllBtn = document.getElementById('r2UploadAllBtn');
  const r2ListBtn = document.getElementById('r2ListBtn');
  const r2SyncBtn = document.getElementById('r2SyncBtn');
  const r2ResultsList = document.getElementById('r2ResultsList');

  // GAPI Server 配置相關元素
  const gapiServerSection = document.getElementById('gapiServerSection');
  const gapiServerHeader = document.getElementById('gapiServerHeader');
  const gapiServerToggle = document.getElementById('gapiServerToggle');
  const gapiServerContent = document.getElementById('gapiServerContent');
  const gapiServerHostInput = document.getElementById('gapiServerHostInput');
  const gapiServerSaveBtn = document.getElementById('gapiServerSaveBtn');
  const gapiServerTestBtn = document.getElementById('gapiServerTestBtn');
  const gapiServerConfigStatus = document.getElementById('gapiServerConfigStatus');
  const gapiServerStatus = document.getElementById('gapiServerStatus');

  // 狀態
  let currentChatId = null;
  let currentTitle = null;
  let currentUrl = null;
  let currentUserProfile = 'default'; // 當前用戶檔案
  let availableProfiles = ['default']; // 可用的用戶檔案列表
  let categories = {};
  let categoryOrder = []; // 分類順序（保持固定的顯示順序）
  let conversations = {};
  let searchQuery = '';
  let expandedCategories = {}; // 記錄哪些分類是展開的（按用戶檔案）
  let testSectionExpanded = false; // 測試區域是否展開
  let conversationHistoryExpanded = false; // 對話記錄區域是否展開
  let imagesRecordExpanded = false; // 圖片記錄區域是否展開
  let downloadButtonsTestExpanded = false; // 下載按鈕測試區域是否展開
  let operationLogsExpanded = false; // 操作日誌監控區域是否展開
  let clickMonitorExpanded = false; // 點擊監聽記錄區域是否展開
  let r2StorageExpanded = false; // R2 儲存區域是否展開
  let gapiServerExpanded = false; // GAPI Server 配置區域是否展開
  let currentConversationMessages = []; // 當前對話的消息列表
  let pendingAttachmentFile = null; // File
  let operationLogsRefreshInterval = null; // 操作日誌自動刷新定時器
  let downloadButtonsRefreshInterval = null; // 下載按鈕測試自動刷新定時器

  // 初始化
  init();

  async function init() {
    console.log('[Side Panel] 開始初始化...');
    
    // 先檢查當前標籤頁是否是 Gemini 頁面
    const isGeminiPage = await checkIfCurrentTabIsGemini();
    if (!isGeminiPage) {
      // 不在 Gemini 頁面，嘗試自動關閉 Side Panel
      console.log('[Side Panel] ⚠️ 不在 Gemini 頁面，嘗試自動關閉...');
      await tryCloseSidePanel();
      return; // 停止初始化
    }
    
    // 載入用戶檔案列表
    await loadAvailableProfiles();
    
    // 嘗試從當前 Gemini 標籤頁獲取用戶檔案
    await detectCurrentUserProfile();
    
    // 載入數據
    await loadData();
    console.log('[Side Panel] 數據載入完成 (用戶檔案:', currentUserProfile, ')');
    
    // 載入展開狀態
    await loadExpandedState();
    
    // 載入對話列表
    await loadConversationList();
    
    // 設置事件監聽
    await setupEventListeners();
    console.log('[Side Panel] 事件監聽設置完成');

    // 監聽消息
    setupMessageListeners();
    console.log('[Side Panel] 消息監聽設置完成');

    // 監聽存儲變化（作為備用方案，當消息未收到時）
    setupStorageListeners();
    console.log('[Side Panel] 存儲監聽設置完成');
    
    // 設置定期檢查 runtime 有效性
    setupRuntimeHealthCheck();
    console.log('[Side Panel] Runtime 健康檢查設置完成');
    
    // 設置定期檢查當前標籤頁是否是 Gemini 頁面
    setupGeminiPageCheck();
    console.log('[Side Panel] Gemini 頁面檢查設置完成');

    // 監聽 Gemini 分頁 URL / 切換，確保能即時抓到 chatId（避免只在初始化時抓一次）
    setupActiveConversationWatcher();
    
    // 更新 UI（包括用戶檔案選擇器）
    updateProfileSelector();
    updateCategoriesList();
    console.log('[Side Panel] 分類列表更新完成');
    
    // 更新測試區域顯示（根據保存的展開狀態）
    updateTestSectionDisplay();
    
    // 載入對話記錄展開狀態
    await loadConversationHistoryExpandedState();
    
    // 更新對話記錄顯示（如果對話記錄區域已展開，則載入消息）
    if (conversationHistoryExpanded && currentChatId) {
      await loadConversationMessages();
    }

    // 初始化對話列表（默認展開）
    if (conversationListContent && conversationListToggle) {
      conversationListContent.style.display = 'block';
      conversationListToggle.textContent = '▼';
      conversationListToggle.classList.add('expanded');
    }

    // 初始化對話列表（默認展開）
    if (conversationListContent && conversationListToggle) {
      conversationListContent.style.display = 'block';
      conversationListToggle.textContent = '▼';
      conversationListToggle.classList.add('expanded');
    }

    // 載入圖片記錄展開狀態
    await loadImagesRecordExpandedState();
    await loadOperationLogsExpandedState();
    await loadDownloadButtonsTestExpandedState();
    await loadClickMonitorExpandedState();
    await loadR2StorageExpandedState();
    await loadGapiServerExpandedState();

    // 載入 GAPI Server 配置
    await loadGapiServerConfig();

    // 載入所有圖片記錄
    await loadAllImagesRecord();

    // 載入 R2 配置
    await loadR2Config();
    
    // 嘗試獲取當前對話信息並更新測試字段
    await updateTestFieldsFromCurrentTab();
    
    // 載入對話消息（同時更新測試窗格）
    await loadConversationMessages();
    
    // 也為測試窗格載入消息
    await loadConversationMessagesForTest();
    
    // 設置定期刷新對話消息（每 3 秒，當有當前對話時）
    setInterval(async () => {
      if (currentChatId) {
        // 如果對話記錄區域已展開，刷新完整記錄
        if (conversationHistoryExpanded) {
          await loadConversationMessages();
        }
        // 無論如何都更新測試窗格（顯示最新消息）
        await loadConversationMessagesForTest();
      }
    }, 10000); // 從 3 秒改為 10 秒（降低頻率）
    
    // 標記為已初始化
    isInitialized = true;
    
    console.log('[Side Panel] 初始化完成');
  }

  // 監聽目前 Gemini 分頁的 URL 變化/切換
  // - 目的：當你在 Gemini 中「開新對話 / 切換對話」後，sidepanel 能自動刷新 chatId/標題/對話記錄
  function setupActiveConversationWatcher() {
    let lastTabId = null;
    let lastUrl = null;
    let lastRunAt = 0;

    const refresh = async () => {
      const now = Date.now();
      if (now - lastRunAt < 350) return; // throttle
      lastRunAt = now;

      try {
        const tab = await getGeminiTabInCurrentWindow();
        if (!tab || !tab.url || !tab.url.includes('gemini.google.com')) return;

        if (tab.id !== lastTabId || tab.url !== lastUrl || !currentChatId) {
          lastTabId = tab.id;
          lastUrl = tab.url;
          await updateTestFieldsFromCurrentTab();

          // 如果已取得 chatId，順便刷新訊息（不會重新抓頁面，只讀本地 DB）
          if (currentChatId) {
            await loadConversationMessagesForTest();
            if (conversationHistoryExpanded) {
              await loadConversationMessages();
            }
          }
        }
      } catch (e) {
        // ignore
      }
    };

    try {
      chrome.tabs.onActivated.addListener(() => {
        refresh();
      });
      chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
        if (changeInfo.url || changeInfo.status === 'complete') {
          // 只關心 Gemini 分頁的 URL 變化
          if (tab && tab.url && tab.url.includes('gemini.google.com')) {
            refresh();
          }
        }
      });
    } catch (e) {
      // ignore
    }

    // 輕量輪詢：只在 currentChatId 為空時才補抓
    setInterval(() => {
      if (!currentChatId) {
        refresh();
      }
    }, 2000);
  }

  // 嘗試取得「當前視窗」中的 Gemini 分頁
  // - 優先：目前 active tab 若為 Gemini
  // - 其次：同視窗中任一 Gemini tab
  async function getGeminiTabInCurrentWindow() {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && typeof activeTab.url === 'string' && activeTab.url.includes('gemini.google.com')) {
        return activeTab;
      }
      const geminiTabs = await chrome.tabs.query({ currentWindow: true, url: 'https://gemini.google.com/*' });
      if (Array.isArray(geminiTabs) && geminiTabs.length > 0) {
        return geminiTabs[0];
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // 檢查當前標籤頁是否是 Gemini 頁面
  async function checkIfCurrentTabIsGemini() {
    try {
      const tab = await getGeminiTabInCurrentWindow();
      return !!(tab && typeof tab.url === 'string' && tab.url.includes('gemini.google.com'));
    } catch (error) {
      console.error('[Side Panel] 檢查當前標籤頁時發生錯誤:', error);
      return false;
    }
  }

  // 嘗試關閉 Side Panel
  async function tryCloseSidePanel() {
    try {
      // 方法 1: 嘗試通過消息通知 background 關閉
      try {
        await chrome.runtime.sendMessage({ action: 'closeSidePanel' });
        console.log('[Side Panel] 已發送關閉 Side Panel 的請求');
      } catch (error) {
        console.log('[Side Panel] 無法發送關閉消息:', error.message);
      }
      
      // 方法 2: 嘗試使用 window.close()（可能不工作，但嘗試一下）
      setTimeout(() => {
        try {
          window.close();
          console.log('[Side Panel] 嘗試使用 window.close()');
        } catch (error) {
          console.log('[Side Panel] window.close() 失敗:', error.message);
        }
      }, 100);
      
      // 方法 3: 如果無法關閉，至少隱藏所有內容
      showNonGeminiPageMessage();
    } catch (error) {
      console.error('[Side Panel] 嘗試關閉 Side Panel 時發生錯誤:', error);
      // 如果所有方法都失敗，至少顯示提示信息
      showNonGeminiPageMessage();
    }
  }

  // 顯示非 Gemini 頁面的提示信息
  function showNonGeminiPageMessage() {
    const nonGeminiMessage = document.getElementById('nonGeminiMessage');
    const testSection = document.getElementById('testSection');
    const headerSection = document.querySelector('.header');
    const profileSelectorSection = document.querySelector('.profile-selector-section');
    const actionsSection = document.querySelector('.actions-section');
    const searchSection = document.querySelector('.search-section');
    const categoriesSection = document.querySelector('.categories-section');
    
    if (nonGeminiMessage) {
      nonGeminiMessage.style.display = 'block';
    }
    
    // 隱藏其他內容
    if (testSection) testSection.style.display = 'none';
    if (headerSection) headerSection.style.display = 'none';
    if (profileSelectorSection) profileSelectorSection.style.display = 'none';
    if (actionsSection) actionsSection.style.display = 'none';
    if (searchSection) searchSection.style.display = 'none';
    if (categoriesSection) categoriesSection.style.display = 'none';
    
    console.log('[Side Panel] ⚠️ 當前不在 Gemini 頁面，顯示提示信息');
  }

  // 隱藏非 Gemini 頁面的提示信息（顯示正常內容）
  function hideNonGeminiPageMessage() {
    const nonGeminiMessage = document.getElementById('nonGeminiMessage');
    const testSection = document.getElementById('testSection');
    const headerSection = document.querySelector('.header');
    const profileSelectorSection = document.querySelector('.profile-selector-section');
    const actionsSection = document.querySelector('.actions-section');
    const searchSection = document.querySelector('.search-section');
    const categoriesSection = document.querySelector('.categories-section');
    
    if (nonGeminiMessage) {
      nonGeminiMessage.style.display = 'none';
    }
    
    // 顯示正常內容
    if (testSection) testSection.style.display = 'block';
    if (headerSection) headerSection.style.display = 'flex';
    if (profileSelectorSection) profileSelectorSection.style.display = 'flex';
    if (actionsSection) actionsSection.style.display = 'block';
    if (searchSection) searchSection.style.display = 'block';
    if (categoriesSection) categoriesSection.style.display = 'block';
    
    console.log('[Side Panel] ✓ 當前在 Gemini 頁面，顯示正常內容');
  }

  // 標記是否已經初始化
  let isInitialized = false;

  // 設置定期檢查當前標籤頁是否是 Gemini 頁面
  function setupGeminiPageCheck() {
    setInterval(async () => {
      try {
        const isGeminiPage = await checkIfCurrentTabIsGemini();
        const nonGeminiMessage = document.getElementById('nonGeminiMessage');
        const isMessageVisible = nonGeminiMessage && nonGeminiMessage.style.display !== 'none';
        
        if (!isGeminiPage) {
          // 不在 Gemini 頁面，嘗試自動關閉
          if (!isMessageVisible) {
            console.log('[Side Panel] ⚠️ 檢測到不在 Gemini 頁面，嘗試自動關閉...');
            await tryCloseSidePanel();
          }
        } else {
          // 在 Gemini 頁面，隱藏提示信息（如果之前顯示過）
          if (isMessageVisible) {
            hideNonGeminiPageMessage();
            // 如果之前因為不在 Gemini 頁面而沒有初始化，現在重新初始化
            if (!isInitialized || !categories || Object.keys(categories).length === 0) {
              console.log('[Side Panel] 重新初始化（從非 Gemini 頁面切換回來）...');
              // 只重新載入數據，不完全重新初始化（避免重複設置監聽器等）
              await loadAvailableProfiles();
              await detectCurrentUserProfile();
              await loadData();
              await loadExpandedState();
              updateProfileSelector();
              updateCategoriesList();
              await updateTestFieldsFromCurrentTab();
              isInitialized = true;
              console.log('[Side Panel] ✓ 重新初始化完成');
            }
          }
        }
      } catch (error) {
        console.error('[Side Panel] 檢查 Gemini 頁面時發生錯誤:', error);
      }
    }, 2000); // 每 2 秒檢查一次
  }

  // 設置事件監聽
  async function setupEventListeners() {
    // 用戶檔案選擇器
    if (profileSelector) {
      profileSelector.addEventListener('change', async (e) => {
        const selectedProfile = e.target.value;
        if (selectedProfile !== currentUserProfile) {
          await switchUserProfile(selectedProfile);
        }
      });
    }
    
    // 新開對話按鈕
    newChatBtn.addEventListener('click', async () => {
      await openNewChat();
    });
    
    // 暫停/恢復監控按鈕
    if (pauseMonitoringBtn) {
      // 載入暫停狀態
      await loadPauseState();
      
      pauseMonitoringBtn.addEventListener('click', async () => {
        await toggleMonitoringPause();
      });
    }
    
    // 測試區域展開/收起
    const testSectionHeader = document.getElementById('testSectionHeader');
    if (testSectionHeader) {
      testSectionHeader.addEventListener('click', () => {
        toggleTestSection();
      });
    }
    
    // 對話記錄區域展開/收起
    if (conversationHistoryHeader) {
      conversationHistoryHeader.addEventListener('click', () => {
        toggleConversationHistory();
      });
    }
    
    // 發送消息按鈕
    if (sendMessageBtn) {
      sendMessageBtn.addEventListener('click', async () => {
        await sendMessage();
      });
    }

    // 上傳圖片按鈕
    if (sendMessageAttachBtn && sendMessageFileInput) {
      sendMessageAttachBtn.addEventListener('click', () => {
        try {
          sendMessageFileInput.click();
        } catch (e) {
          // ignore
        }
      });
    }

    // 選擇圖片
    if (sendMessageFileInput) {
      sendMessageFileInput.addEventListener('change', () => {
        const file = sendMessageFileInput.files && sendMessageFileInput.files[0] ? sendMessageFileInput.files[0] : null;
        pendingAttachmentFile = file;
        if (file && sendMessageAttachment && sendMessageAttachmentName) {
          sendMessageAttachmentName.textContent = file.name;
          sendMessageAttachment.style.display = 'flex';
        } else if (sendMessageAttachment) {
          sendMessageAttachment.style.display = 'none';
        }
      });
    }

    // 移除圖片
    if (sendMessageAttachmentRemove) {
      sendMessageAttachmentRemove.addEventListener('click', () => {
        pendingAttachmentFile = null;
        if (sendMessageFileInput) sendMessageFileInput.value = '';
        if (sendMessageAttachment) sendMessageAttachment.style.display = 'none';
      });
    }
    
    // 發送消息輸入框（按 Enter 發送，Shift+Enter 換行）
    if (sendMessageInput) {
      sendMessageInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          await sendMessage();
        }
      });
    }
    
    // 備份按鈕
    if (backupBtn) {
      backupBtn.addEventListener('click', async (e) => {
        e.stopPropagation(); // 阻止觸發父元素的點擊事件
        await backupConversationMessages();
      });
    }

    // 對話列表區域展開/收起
    if (conversationListHeader) {
      conversationListHeader.addEventListener('click', () => {
        toggleConversationList();
      });
    }

    // 刷新對話列表按鈕
    if (refreshConversationsBtn) {
      refreshConversationsBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await loadConversationList();
      });
    }

    // 圖片記錄區域展開/收起
    if (imagesRecordHeader) {
      imagesRecordHeader.addEventListener('click', () => {
        toggleImagesRecord();
      });
    }

    // 刷新圖片記錄按鈕
    if (refreshImagesBtn) {
      refreshImagesBtn.addEventListener('click', async (e) => {
        e.stopPropagation(); // 阻止觸發父元素的點擊事件
        await loadAllImagesRecord();
      });
    }

    // 下載按鈕測試區域展開/收起
    if (downloadButtonsTestHeader) {
      downloadButtonsTestHeader.addEventListener('click', () => {
        toggleDownloadButtonsTest();
      });
    }
    
    // 刷新下載按鈕列表按鈕
    if (refreshDownloadButtonsBtn) {
      refreshDownloadButtonsBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // 阻止觸發父元素的點擊事件
        loadDownloadButtons();
      });
    }
    
    // 模擬點擊按鈕
    const simulateClickBtn = document.getElementById('simulateClickBtn');
    if (simulateClickBtn) {
      simulateClickBtn.addEventListener('click', async (e) => {
        e.stopPropagation(); // 阻止觸發父元素的點擊事件
        
        // 先獲取當前按鈕列表
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
          if (tabs.length === 0) {
            showToast('無法獲取當前標籤頁', 2000);
            return;
          }

          // 獲取按鈕列表
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'GET_DOWNLOAD_BUTTONS'
          }, async (response) => {
            if (chrome.runtime.lastError) {
              console.error('[Side Panel] [模擬點擊] 獲取按鈕列表失敗:', chrome.runtime.lastError.message);
              showToast('獲取按鈕列表失敗: ' + chrome.runtime.lastError.message, 3000);
              return;
            }

            if (!response || !response.buttons || response.buttons.length === 0) {
              showToast('未找到按鈕，嘗試自動搜尋並點擊...', 2000);
              chrome.tabs.sendMessage(tabs[0].id, {
                action: 'CLICK_BEST_DOWNLOAD_BUTTON'
              }, (clickResponse) => {
                if (chrome.runtime.lastError) {
                  console.error('[Side Panel] [模擬點擊] 點擊失敗:', chrome.runtime.lastError.message);
                  showToast('模擬點擊失敗: ' + chrome.runtime.lastError.message, 3000);
                  return;
                }

                if (clickResponse && clickResponse.status === 'ok') {
                  console.log('[Side Panel] [模擬點擊] ✓ 點擊成功（自動搜尋）');
                  showToast('已自動點擊下載按鈕', 2000);
                  setTimeout(() => {
                    loadDownloadButtons();
                  }, 1000);
                } else {
                  console.error('[Side Panel] [模擬點擊] 點擊失敗:', clickResponse);
                  showToast('模擬點擊失敗: ' + (clickResponse?.error || clickResponse?.message || '未知錯誤'), 3000);
                }
              });
              return;
            }

            // 模擬點擊第一個按鈕（索引 0）
            const buttonIndex = 0;
            showToast(`正在模擬點擊按鈕 #${buttonIndex + 1}...`, 2000);
            
            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'CLICK_DOWNLOAD_BUTTON',
              buttonIndex: buttonIndex
            }, (clickResponse) => {
              if (chrome.runtime.lastError) {
                console.error('[Side Panel] [模擬點擊] 點擊失敗:', chrome.runtime.lastError.message);
                showToast('模擬點擊失敗: ' + chrome.runtime.lastError.message, 3000);
                return;
              }

              if (clickResponse && clickResponse.status === 'ok') {
                console.log('[Side Panel] [模擬點擊] ✓ 點擊成功');
                showToast(`按鈕 #${buttonIndex + 1} 模擬點擊成功`, 2000);
                // 刷新列表
                setTimeout(() => {
                  loadDownloadButtons();
                }, 1000);
              } else {
                console.error('[Side Panel] [模擬點擊] 點擊失敗:', clickResponse);
                showToast('模擬點擊失敗: ' + (clickResponse?.error || clickResponse?.message || '未知錯誤'), 3000);
              }
            });
          });
        });
      });
    }

    // 操作日誌監控區域展開/收起
    if (operationLogsHeader) {
      operationLogsHeader.addEventListener('click', () => {
        toggleOperationLogs();
      });
    }
    
    // 刷新操作日誌按鈕
    if (refreshLogsBtn) {
      refreshLogsBtn.addEventListener('click', async (e) => {
        e.stopPropagation(); // 阻止觸發父元素的點擊事件
        await loadOperationLogs();
      });
    }

    // 點擊監聽記錄區域展開/收起
    if (clickMonitorHeader) {
      clickMonitorHeader.addEventListener('click', () => {
        toggleClickMonitor();
      });
    }
    
    // 刷新點擊監聽記錄按鈕
    if (refreshClickMonitorBtn) {
      refreshClickMonitorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        loadClickMonitorRecords();
      });
    }
    
    // 導出點擊監聽記錄按鈕
    if (exportClickMonitorBtn) {
      exportClickMonitorBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await exportClickMonitorRecords();
      });
    }
    
    // 清除點擊監聽記錄按鈕
    if (clearClickMonitorBtn) {
      clearClickMonitorBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm('確定要清除所有點擊監聽記錄嗎？')) {
          const userProfile = currentUserProfile || 'default';
          
          // 清除 background.js 中的記錄
          chrome.runtime.sendMessage({
            action: 'CLEAR_CLICK_MONITOR_RECORDS',
            userProfile: userProfile
          }, () => {
            // 清除 content.js 中的記錄
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, {
                  action: 'CLEAR_CLICK_MONITOR_RECORDS'
                }, () => {
                  loadClickMonitorRecords();
                  showToast('已清除所有記錄', 2000);
                });
              } else {
                loadClickMonitorRecords();
                showToast('已清除所有記錄', 2000);
              }
            });
          });
        }
      });
    }

    // GAPI Server 配置區域展開/收起
    if (gapiServerHeader) {
      gapiServerHeader.addEventListener('click', () => {
        toggleGapiServerSection();
      });
    }

    // GAPI Server 儲存按鈕
    if (gapiServerSaveBtn) {
      gapiServerSaveBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await saveGapiServerConfig();
      });
    }

    // GAPI Server 測試連線按鈕
    if (gapiServerTestBtn) {
      gapiServerTestBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await testGapiServerConnection();
      });
    }

    // R2 儲存區域展開/收起
    if (r2StorageHeader) {
      r2StorageHeader.addEventListener('click', () => {
        toggleR2Storage();
      });
    }

    // R2 配置按鈕
    if (r2SaveConfigBtn) {
      r2SaveConfigBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await saveR2Config();
      });
    }

    if (r2LoadConfigBtn) {
      r2LoadConfigBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await loadR2Config();
      });
    }

    if (r2TestConnectionBtn) {
      r2TestConnectionBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await testR2Connection();
      });
    }

    // R2 操作按鈕
    if (r2UploadCurrentBtn) {
      r2UploadCurrentBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await uploadCurrentConversationToR2();
      });
    }

    if (r2UploadAllBtn) {
      r2UploadAllBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await uploadAllConversationsToR2();
      });
    }

    if (r2ListBtn) {
      r2ListBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await listR2Conversations();
      });
    }

    if (r2SyncBtn) {
      r2SyncBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await syncConversationsFromR2();
      });
    }

    // 導出操作日誌按鈕
    if (exportLogsBtn) {
      exportLogsBtn.addEventListener('click', async (e) => {
        e.stopPropagation(); // 阻止觸發父元素的點擊事件
        await exportOperationLogs();
      });
    }
    
    // 打開 Gemini 按鈕（當不在 Gemini 頁面時顯示）
    const openGeminiBtn = document.getElementById('openGeminiBtn');
    if (openGeminiBtn) {
      openGeminiBtn.addEventListener('click', async () => {
        await openNewChat();
      });
    }

    // 新增分類按鈕
    addCategoryBtn.addEventListener('click', () => {
      showAddCategoryModal();
    });

    // 自動建議分類按鈕
    autoSuggestBtn.addEventListener('click', async () => {
      await getCurrentConversationAndSuggest();
    });

    // 搜索輸入框
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      updateCategoriesList();
    });

    // 模態框按鈕
    confirmBtn.addEventListener('click', async () => {
      const categoryName = categoryInput.value.trim();
      if (categoryName) {
        await addCategory(categoryName);
        categoryInput.value = '';
        hideAddCategoryModal();
      }
    });

    cancelBtn.addEventListener('click', () => {
      categoryInput.value = '';
      hideAddCategoryModal();
    });

    // 點擊模態框外部關閉
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) {
        hideAddCategoryModal();
      }
    });

    // Enter 鍵確認
    categoryInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        confirmBtn.click();
      }
    });
  }

  // 打開新對話
  async function openNewChat() {
    const geminiUrl = 'https://gemini.google.com/';
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (currentTab && currentTab.url && currentTab.url.includes('gemini.google.com')) {
      // 如果當前標籤頁是 Gemini 網頁，在當前標籤頁打開新對話
      await chrome.tabs.update(currentTab.id, { url: geminiUrl });
    } else {
      // 查找是否有其他 Gemini 標籤頁
      const geminiTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
      if (geminiTabs.length > 0) {
        // 使用第一個 Gemini 標籤頁
        await chrome.tabs.update(geminiTabs[0].id, { url: geminiUrl, active: true });
        await chrome.windows.update(geminiTabs[0].windowId, { focused: true });
      } else {
        // 沒有 Gemini 標籤頁，創建新的
        await chrome.tabs.create({ url: geminiUrl });
      }
    }
  }

  // 獲取當前對話並建議分類
  async function getCurrentConversationAndSuggest() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('gemini.google.com')) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
          if (response && response.status === 'ok' && response.chatId) {
            currentChatId = response.chatId;
            currentTitle = response.title || null;
            await suggestCategory();
          } else {
            showToast('請先打開一個對話');
          }
        } catch (error) {
          showToast('請先打開一個對話');
        }
      } else {
        showToast('請在 Gemini 網頁上使用');
      }
    } catch (error) {
      console.error('獲取當前對話時發生錯誤:', error);
      showToast('獲取對話失敗');
    }
  }

  // 檢測當前用戶檔案
  async function detectCurrentUserProfile() {
    try {
      const tab = await getGeminiTabInCurrentWindow();
      if (tab && tab.url && tab.url.includes('gemini.google.com')) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { action: 'getUserProfile' });
          if (response && response.userProfile) {
            const detectedProfile = response.userProfile;
            if (detectedProfile !== currentUserProfile) {
              console.log('[Side Panel] 檢測到當前用戶檔案:', detectedProfile, '(當前:', currentUserProfile, ')');
              // 如果檔案改變，切換檔案
              await switchUserProfile(detectedProfile);
            } else {
              currentUserProfile = detectedProfile;
              console.log('[Side Panel] 檢測到當前用戶檔案:', currentUserProfile);
              // 更新測試字段
              updateTestFields();
            }
            
            // 如果這是一個新檔案，添加到列表
            if (!availableProfiles.includes(currentUserProfile)) {
              availableProfiles.push(currentUserProfile);
              await saveAvailableProfiles();
            }
          }
        } catch (error) {
          console.log('[Side Panel] 無法從 content script 獲取用戶檔案，使用默認檔案:', error?.message || error);
          showToast('無法連線到 Gemini 分頁（請重新整理 Gemini 頁面）');
          // 仍然更新測試字段
          updateTestFields();
        }
      }
    } catch (error) {
      console.error('[Side Panel] 檢測用戶檔案時發生錯誤:', error);
    }
  }

  // 載入可用的用戶檔案列表
  async function loadAvailableProfiles() {
    try {
      const result = await chrome.storage.local.get(['availableProfiles']);
      if (result.availableProfiles && Array.isArray(result.availableProfiles)) {
        availableProfiles = result.availableProfiles;
      }
    } catch (error) {
      console.error('[Side Panel] 載入用戶檔案列表時發生錯誤:', error);
    }
  }

  // 保存可用的用戶檔案列表
  async function saveAvailableProfiles() {
    try {
      await chrome.storage.local.set({ availableProfiles: availableProfiles });
    } catch (error) {
      console.error('[Side Panel] 保存用戶檔案列表時發生錯誤:', error);
    }
  }

  // 載入數據（按用戶檔案）
  async function loadData() {
    try {
      const categoriesKey = `categories_${currentUserProfile}`;
      const conversationsKey = `conversations_${currentUserProfile}`;
      const conversationStatesKey = `conversationStates_${currentUserProfile}`;
      const categoryOrderKey = `categoryOrder_${currentUserProfile}`;
      
      const result = await chrome.storage.local.get([categoriesKey, conversationsKey, conversationStatesKey, categoryOrderKey]);
      categories = result[categoriesKey] || {};
      conversations = result[conversationsKey] || {};
      categoryOrder = result[categoryOrderKey] || [];
      
      // 清理重複項：確保每個分類中的 chatId 唯一
      let hasDuplicates = false;
      for (const [catName, chatIds] of Object.entries(categories)) {
        if (Array.isArray(chatIds)) {
          const uniqueChatIds = [...new Set(chatIds)];
          if (uniqueChatIds.length !== chatIds.length) {
            console.log(`[Side Panel] 清理分類「${catName}」中的重複對話 (${chatIds.length} -> ${uniqueChatIds.length})`);
            categories[catName] = uniqueChatIds;
            hasDuplicates = true;
          }
        }
      }
      
      // 如果有清理重複項，保存數據
      if (hasDuplicates) {
        await saveData();
      }
      
      // 如果 categoryOrder 為空或過時，從現有分類重新生成
      if (categoryOrder.length === 0 || Object.keys(categories).length !== categoryOrder.length) {
        const existingCategories = Object.keys(categories);
        // 保留現有順序中存在的分類，然後添加新的分類（按字母順序）
        const existingInOrder = categoryOrder.filter(cat => existingCategories.includes(cat));
        const newCategories = existingCategories.filter(cat => !categoryOrder.includes(cat)).sort((a, b) => a.localeCompare(b, 'zh-TW'));
        categoryOrder = [...existingInOrder, ...newCategories];
        await saveCategoryOrder();
      }
      
      // 合併 conversationStates 到 conversations
      if (result[conversationStatesKey]) {
        Object.entries(result[conversationStatesKey]).forEach(([chatId, data]) => {
          if (!conversations[chatId]) {
            conversations[chatId] = data;
          } else {
            // 更新現有對話信息
            conversations[chatId] = { ...conversations[chatId], ...data };
          }
        });
      }
    } catch (error) {
      console.error('[Side Panel] 載入數據時發生錯誤:', error);
    }
  }

  // 載入展開狀態（按用戶檔案）
  async function loadExpandedState() {
    try {
      const expandedKey = `expandedCategories_${currentUserProfile}`;
      const result = await chrome.storage.local.get([expandedKey]);
      expandedCategories = result[expandedKey] || {};
      
      // 載入測試區域展開狀態
      const testExpandedKey = `testSectionExpanded_${currentUserProfile}`;
      const testResult = await chrome.storage.local.get([testExpandedKey]);
      testSectionExpanded = testResult[testExpandedKey] !== undefined ? testResult[testExpandedKey] : false;
      
      // 更新測試區域顯示
      updateTestSectionDisplay();
    } catch (error) {
      console.error('[Side Panel] 載入展開狀態時發生錯誤:', error);
    }
  }

  // 保存展開狀態（按用戶檔案）
  async function saveExpandedState() {
    try {
      const expandedKey = `expandedCategories_${currentUserProfile}`;
      await chrome.storage.local.set({ [expandedKey]: expandedCategories });
      
      // 保存測試區域展開狀態
      const testExpandedKey = `testSectionExpanded_${currentUserProfile}`;
      await chrome.storage.local.set({ [testExpandedKey]: testSectionExpanded });
    } catch (error) {
      console.error('[Side Panel] 保存展開狀態時發生錯誤:', error);
    }
  }
  
  // 切換測試區域展開/收起
  function toggleTestSection() {
    testSectionExpanded = !testSectionExpanded;
    updateTestSectionDisplay();
    saveExpandedState();
  }
  
  // 更新測試區域顯示
  function updateTestSectionDisplay() {
    const testSectionToggle = document.getElementById('testSectionToggle');
    const testInfo = document.getElementById('testInfo');
    
    if (testSectionToggle) {
      if (testSectionExpanded) {
        testSectionToggle.textContent = '▼';
        testSectionToggle.classList.add('expanded');
      } else {
        testSectionToggle.textContent = '▶';
        testSectionToggle.classList.remove('expanded');
      }
    }
    
    if (testInfo) {
      if (testSectionExpanded) {
        testInfo.classList.add('expanded');
      } else {
        testInfo.classList.remove('expanded');
      }
    }
  }

  // 保存分類順序（按用戶檔案）
  async function saveCategoryOrder() {
    try {
      const categoryOrderKey = `categoryOrder_${currentUserProfile}`;
      await chrome.storage.local.set({ [categoryOrderKey]: categoryOrder });
    } catch (error) {
      console.error('[Side Panel] 保存分類順序時發生錯誤:', error);
    }
  }

  // 保存數據（按用戶檔案）
  async function saveData() {
    try {
      const categoriesKey = `categories_${currentUserProfile}`;
      const conversationsKey = `conversations_${currentUserProfile}`;
      await chrome.storage.local.set({
        [categoriesKey]: categories,
        [conversationsKey]: conversations
      });
    } catch (error) {
      console.error('[Side Panel] 保存數據時發生錯誤:', error);
    }
  }

  // 更新分類列表（支持展開/折疊，使用固定順序）
  // HTML 轉義函數
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function updateCategoriesList() {
    try {
      // 使用保存的分類順序，過濾掉不存在的分類，並添加新的分類（如果有）
      const existingCategoryNames = Object.keys(categories);
      const orderedCategories = categoryOrder.filter(cat => existingCategoryNames.includes(cat));
      const newCategories = existingCategoryNames.filter(cat => !categoryOrder.includes(cat));
      
      // 如果有變化，更新 categoryOrder
      if (orderedCategories.length !== categoryOrder.length || newCategories.length > 0) {
        // 新分類按字母順序添加到末尾
        if (newCategories.length > 0) {
          newCategories.sort((a, b) => a.localeCompare(b, 'zh-TW'));
          categoryOrder = [...orderedCategories, ...newCategories];
          saveCategoryOrder(); // 保存更新後的順序
        } else if (orderedCategories.length !== categoryOrder.length) {
          // 如果有分類被刪除，更新順序
          categoryOrder = orderedCategories;
          saveCategoryOrder();
        }
      }
      
      const categoryNames = orderedCategories.length > 0 || newCategories.length > 0 
        ? [...orderedCategories, ...newCategories] 
        : [];
      
      if (categoryNames.length === 0) {
        categoriesSection.innerHTML = '<div class="empty-state">尚無分類，請先新增分類</div>';
        return;
      }

      // 預先清理所有分類中的重複項
      let needsSave = false;
      for (const categoryName of categoryNames) {
        const chatIds = categories[categoryName] || [];
        if (Array.isArray(chatIds) && chatIds.length > 0) {
          const uniqueChatIds = [...new Set(chatIds)];
          if (uniqueChatIds.length !== chatIds.length) {
            console.log(`[Side Panel] 發現分類「${categoryName}」中有重複對話 (${chatIds.length} -> ${uniqueChatIds.length})，正在清理...`);
            categories[categoryName] = uniqueChatIds;
            needsSave = true;
          }
        }
      }
      
      // 如果有清理重複項，保存數據
      if (needsSave) {
        saveData(); // 異步保存，不等待
      }
      
      // 渲染所有分類及其對話（按照固定順序）
      categoriesSection.innerHTML = categoryNames.map(categoryName => {
        const chatIds = categories[categoryName] || [];
        
        // 獲取該分類下的所有對話（已經去重）
        let conversationItems = chatIds
          .map(chatId => {
            const conv = conversations[chatId];
            if (!conv) return null;
            return { chatId, ...conv };
          })
          .filter(item => item !== null)
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        // 應用搜索過濾
        if (searchQuery) {
          conversationItems = conversationItems.filter(item => {
            const title = (item.title || '').toLowerCase();
            return title.includes(searchQuery);
          });
        }

        const isExpanded = expandedCategories[categoryName] !== false; // 默認展開
        const shouldShow = !searchQuery || conversationItems.length > 0; // 如果有搜索但沒結果，也顯示分類

        // 如果搜索時沒有匹配的對話，跳過該分類
        if (searchQuery && conversationItems.length === 0) {
          return '';
        }

        // 渲染對話列表（緊湊模式，不顯示時間）
        const conversationsHtml = conversationItems
          .map(item => {
            return `
              <div class="conversation-item" data-chat-id="${item.chatId}" data-url="${item.url || ''}">
                <div class="conversation-item-content" data-chat-id="${item.chatId}">
                  <div class="conversation-item-title">${item.title || '未命名對話'}</div>
                </div>
                <button class="btn-assign-category" data-chat-id="${item.chatId}" title="分配分類">⋯</button>
              </div>
            `;
          })
          .join('');

        // 檢查當前對話是否已在該分類中
        const isCurrentInCategory = currentChatId && chatIds.includes(currentChatId);
        
        return `
          <div class="category-item" data-category="${categoryName}">
            <div class="category-header" data-category="${categoryName}">
              <div class="category-header-left">
                <span class="category-toggle ${isExpanded ? 'expanded' : ''}">▶</span>
                <span class="category-name">${categoryName}</span>
              </div>
              <div class="category-header-right">
                ${currentChatId ? `
                  <button class="btn-add-to-category ${isCurrentInCategory ? 'added' : ''}" 
                          data-category="${categoryName}" 
                          data-chat-id="${currentChatId}"
                          title="${isCurrentInCategory ? '已在該分類中' : '將當前對話加入此分類'}"
                          ${isCurrentInCategory ? 'disabled' : ''}>
                    ${isCurrentInCategory ? '✓' : '+'}
                  </button>
                ` : ''}
                <span class="category-count">${chatIds.length}</span>
              </div>
            </div>
            <div class="category-conversations ${isExpanded ? 'expanded' : ''}">
              <div class="category-conversations-list">
                ${conversationItems.length > 0 ? conversationsHtml : '<div class="empty-state">此分類尚無對話</div>'}
              </div>
            </div>
          </div>
        `;
      }).filter(html => html).join('');

      // 添加分類展開/折疊事件（點擊左側區域，不包括按鈕區域）
      categoriesSection.querySelectorAll('.category-header').forEach(header => {
        // 整個標題區域可以點擊展開/折疊，但右側按鈕區域除外
        header.addEventListener('click', (e) => {
          // 如果點擊的是按鈕區域，不觸發展開/折疊
          if (e.target.closest('.btn-add-to-category') || e.target.closest('.category-header-right')) {
            return;
          }
          const categoryName = header.dataset.category;
          toggleCategory(categoryName);
        });
      });
      
      // 添加"加入分類"按鈕事件
      categoriesSection.querySelectorAll('.btn-add-to-category').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation(); // 阻止觸發分類展開/折疊
          const categoryName = btn.dataset.category;
          const chatId = btn.dataset.chatId || currentChatId;
          if (chatId && categoryName) {
            await addConversationToCategory(chatId, categoryName);
            updateCategoriesList();
            showToast(`已將對話加入「${categoryName}」`);
          }
        });
      });

      // 添加對話點擊事件
      categoriesSection.querySelectorAll('.conversation-item').forEach(item => {
        const content = item.querySelector('.conversation-item-content');
        const assignBtn = item.querySelector('.btn-assign-category');
        
        // 點擊對話內容跳轉
        if (content) {
          content.addEventListener('click', async (e) => {
            try {
              e.stopPropagation(); // 阻止觸發分類展開/折疊
              const url = item.dataset.url;
              const chatId = item.dataset.chatId;
              
              // 檢查數據是否有效
              if (!url && !chatId) {
                console.error('[Side Panel] 對話項缺少 URL 和 Chat ID');
                showToast('無法打開對話：缺少信息');
                return;
              }
              
              await openConversation(url, chatId);
            } catch (error) {
              console.error('[Side Panel] 點擊對話時發生錯誤:', error);
              const errorMessage = error.message || error.toString();
              
              // 檢查是否是擴展上下文失效
              if (errorMessage.includes('Extension context invalidated') || 
                  errorMessage.includes('message port closed') ||
                  !isRuntimeValid()) {
                console.warn('[Side Panel] ⚠️ 擴展上下文失效，嘗試恢復...');
                const recovered = await recoverExtensionConnection();
                if (!recovered) {
                  showToast('擴展上下文失效，請刷新頁面');
                } else {
                  // 恢復後重試
                  try {
                    await openConversation(item.dataset.url, item.dataset.chatId);
                  } catch (retryError) {
                    showToast('打開對話失敗，請重試');
                  }
                }
              } else {
                showToast('打開對話失敗: ' + errorMessage);
              }
            }
          });
        }
        
        // 點擊分配按鈕顯示分類選擇
        if (assignBtn) {
          assignBtn.addEventListener('click', async (e) => {
            try {
              e.stopPropagation(); // 阻止觸發分類展開/折疊和其他事件
              const chatId = assignBtn.dataset.chatId;
              
              if (!chatId) {
                console.error('[Side Panel] 分配按鈕缺少 Chat ID');
                return;
              }
              
              await showAssignCategoryMenu(chatId, assignBtn);
            } catch (error) {
              console.error('[Side Panel] 顯示分類菜單時發生錯誤:', error);
              const errorMessage = error.message || error.toString();
              
              // 檢查是否是擴展上下文失效
              if (errorMessage.includes('Extension context invalidated') || 
                  errorMessage.includes('message port closed') ||
                  !isRuntimeValid()) {
                console.warn('[Side Panel] ⚠️ 擴展上下文失效，嘗試恢復...');
                await recoverExtensionConnection();
              }
            }
          });
        }
      });

    } catch (error) {
      console.error('[Side Panel] 更新分類列表時發生錯誤:', error);
      categoriesSection.innerHTML = '<div class="empty-state">載入失敗</div>';
    }
  }

  // 切換分類展開/折疊
  async function toggleCategory(categoryName) {
    const wasExpanded = expandedCategories[categoryName] !== false;
    expandedCategories[categoryName] = !expandedCategories[categoryName];
    saveExpandedState();
    
    // 如果正在展開分類，驗證該分類下所有對話的標題
    if (!wasExpanded && expandedCategories[categoryName]) {
      await verifyCategoryConversationTitles(categoryName);
    }
    
    updateCategoriesList();
  }

  // 驗證分類下所有對話的標題（展開分類時調用）
  async function verifyCategoryConversationTitles(categoryName) {
    try {
      const chatIds = categories[categoryName] || [];
      if (chatIds.length === 0) {
        return;
      }

      console.log(`[Side Panel] 開始驗證分類「${categoryName}」下的 ${chatIds.length} 個對話標題...`);

      // 獲取當前 Gemini 標籤頁
      const geminiTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
      if (geminiTabs.length === 0) {
        console.log('[Side Panel] 沒有找到 Gemini 標籤頁，跳過驗證');
        return;
      }

      // 使用第一個 Gemini 標籤頁進行驗證
      const tab = geminiTabs[0];
      
      try {
        // 向 content.js 發送批量驗證請求
        const response = await chrome.tabs.sendMessage(tab.id, {
          action: 'verifyConversationTitles',
          chatIds: chatIds
        });

        if (response && response.results) {
          const updatedChatIds = [];
          
          // 檢查每個對話的標題是否一致
          for (const chatId of chatIds) {
            const storedTitle = conversations[chatId]?.title || '';
            const currentTitle = response.results[chatId] || null;
            
            if (currentTitle && currentTitle !== storedTitle && currentTitle.trim().length > 0) {
              // 標題不一致，更新存儲
              console.log(`[Side Panel] 發現對話 ${chatId} 標題不一致: "${storedTitle}" -> "${currentTitle}"`);
              
              // 更新本地 conversations 對象
              if (!conversations[chatId]) {
                conversations[chatId] = {};
              }
              conversations[chatId].title = currentTitle;
              conversations[chatId].chatId = chatId;
              conversations[chatId].lastUpdated = Date.now();
              if (!conversations[chatId].timestamp) {
                conversations[chatId].timestamp = Date.now();
              }
              
              updatedChatIds.push(chatId);
            }
          }
          
          // 如果有更新，批量保存
          if (updatedChatIds.length > 0) {
            // 檢查 runtime 是否有效
            if (!isRuntimeValid()) {
              console.warn('[Side Panel] ⚠️ Runtime 無效，跳過更新標題');
              return;
            }
            
            // 通過 background.js 更新存儲（以 ID 作為索引）
            for (const chatId of updatedChatIds) {
              try {
                await chrome.runtime.sendMessage({
                  action: 'updateConversationTitle',
                  data: {
                    chatId: chatId,
                    title: conversations[chatId].title,
                    userProfile: currentUserProfile
                  }
                });
              } catch (error) {
                const errorMessage = error.message || error.toString();
                if (errorMessage.includes('Extension context invalidated') || 
                    errorMessage.includes('message port closed')) {
                  console.warn('[Side Panel] ⚠️ 擴展上下文失效，停止更新標題');
                  await recoverExtensionConnection();
                  return;
                }
                console.error('[Side Panel] 更新標題時發生錯誤:', error);
              }
            }
            
            // 保存更新後的 conversations
            const conversationsKey = `conversations_${currentUserProfile}`;
            await chrome.storage.local.set({ [conversationsKey]: conversations });
            console.log(`[Side Panel] 已更新 ${updatedChatIds.length} 個對話標題`);
            if (updatedChatIds.length > 0) {
              showToast(`已更新 ${updatedChatIds.length} 個對話標題`);
            }
            
            // 同時更新 conversationStates（確保後台以 ID 作為索引的存儲也更新）
            const conversationStatesKey = `conversationStates_${currentUserProfile}`;
            const statesResult = await chrome.storage.local.get([conversationStatesKey]);
            const states = statesResult[conversationStatesKey] || {};
            
            for (const chatId of updatedChatIds) {
              states[chatId] = {
                chatId: chatId,
                title: conversations[chatId].title,
                url: conversations[chatId].url || `https://gemini.google.com/app/${chatId}`,
                lastUpdated: Date.now(),
                timestamp: conversations[chatId].timestamp || Date.now(),
                userProfile: currentUserProfile
              };
            }
            
            await chrome.storage.local.set({ [conversationStatesKey]: states });
            console.log('[Side Panel] 已同步更新 conversationStates 存儲（以 ID 作為索引）');
            
            // 刷新分類列表以顯示更新後的標題
            updateCategoriesList();
          } else {
            console.log('[Side Panel] 所有對話標題都是最新的');
          }
        }
      } catch (error) {
        console.error('[Side Panel] 驗證對話標題時發生錯誤:', error);
        // 如果 content.js 未注入，靜默失敗（這是正常的，如果頁面剛加載）
      }
    } catch (error) {
      console.error('[Side Panel] 驗證分類對話標題時發生錯誤:', error);
    }
  }

  // 檢查 runtime 是否有效
  function isRuntimeValid() {
    try {
      return chrome.runtime && chrome.runtime.id !== undefined;
    } catch (e) {
      return false;
    }
  }

  // 恢復擴展連接（當檢測到上下文失效時）
  async function recoverExtensionConnection() {
    try {
      console.log('[Side Panel] 🔄 嘗試恢復擴展連接...');
      
      // 檢查 runtime 是否恢復
      if (isRuntimeValid()) {
        console.log('[Side Panel] ✓ Runtime 已恢復，重新初始化...');
        
        // 重新獲取當前對話信息
        await updateTestFieldsFromCurrentTab();
        
        // 重新載入數據
        await loadData();
        await loadExpandedState();
        
        // 更新 UI
        updateCategoriesList();
        updateTestFields();
        
        console.log('[Side Panel] ✓ 擴展連接已恢復');
        showToast('擴展連接已恢復');
        return true;
      } else {
        console.warn('[Side Panel] ⚠️ Runtime 仍未恢復，請刷新頁面');
        showToast('擴展上下文失效，請刷新頁面');
        return false;
      }
    } catch (error) {
      console.error('[Side Panel] ❌ 恢復擴展連接時發生錯誤:', error);
      return false;
    }
  }

  // 打開對話（在原標籤頁）
  async function openConversation(url, chatId) {
    const targetUrl = url || (chatId ? `https://gemini.google.com/app/${chatId}` : null);
    
    if (!targetUrl) {
      console.error('[Side Panel] 無法打開對話：缺少 URL 或 Chat ID');
      showToast('無法打開對話：缺少信息');
      return;
    }

    try {
      // 檢查 runtime 是否有效
      if (!isRuntimeValid()) {
        console.warn('[Side Panel] ⚠️ Runtime 無效，嘗試恢復...');
        const recovered = await recoverExtensionConnection();
        if (!recovered) {
          showToast('擴展上下文失效，請刷新頁面');
          return;
        }
      }

      // 獲取當前活動標籤頁
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      // 嘗試找到已存在的標籤頁（匹配該對話）
      const existingTabs = await chrome.tabs.query({ url: targetUrl });
      
      if (existingTabs.length > 0) {
        // 切換到現有標籤頁
        await chrome.tabs.update(existingTabs[0].id, { active: true });
        await chrome.windows.update(existingTabs[0].windowId, { focused: true });
      } else if (currentTab && currentTab.url && currentTab.url.includes('gemini.google.com')) {
        // 如果當前標籤頁是 Gemini 網頁，在當前標籤頁打開對話
        await chrome.tabs.update(currentTab.id, { url: targetUrl });
      } else {
        // 查找是否有其他 Gemini 標籤頁
        const geminiTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
        if (geminiTabs.length > 0) {
          // 使用第一個 Gemini 標籤頁
          await chrome.tabs.update(geminiTabs[0].id, { url: targetUrl, active: true });
          await chrome.windows.update(geminiTabs[0].windowId, { focused: true });
        } else {
          // 沒有 Gemini 標籤頁，在當前標籤頁打開（即使不是 Gemini 網頁）
          await chrome.tabs.update(currentTab.id, { url: targetUrl });
        }
      }
      
      // 等待一小段時間後更新測試字段（讓頁面有時間加載）
      setTimeout(async () => {
        await updateTestFieldsFromCurrentTab();
      }, 1000);
      
    } catch (error) {
      const errorMessage = error.message || error.toString();
      console.error('[Side Panel] 打開對話時發生錯誤:', error);
      
      // 檢查是否是擴展上下文失效
      if (errorMessage.includes('Extension context invalidated') || 
          errorMessage.includes('message port closed') ||
          !isRuntimeValid()) {
        console.warn('[Side Panel] ⚠️ 擴展上下文失效，嘗試恢復...');
        const recovered = await recoverExtensionConnection();
        if (!recovered) {
          showToast('擴展上下文失效，請刷新頁面');
        }
      } else {
        showToast('打開對話失敗: ' + errorMessage);
      }
    }
  }

  // 新增分類
  async function addCategory(categoryName) {
    if (!categoryName || categoryName.trim() === '') {
      return;
    }

    // 檢查分類是否已存在
    if (categories[categoryName]) {
      showToast('該分類已存在');
      return;
    }

    // 創建新分類
    categories[categoryName] = [];
    expandedCategories[categoryName] = true; // 新分類默認展開
    
    // 將新分類添加到順序列表末尾
    if (!categoryOrder.includes(categoryName)) {
      categoryOrder.push(categoryName);
      await saveCategoryOrder();
    }
    
    await saveData();
    await saveExpandedState();
    updateCategoriesList();

    // 如果當前有對話，自動分配到新分類
    if (currentChatId) {
      await assignConversationToCategory(currentChatId, categoryName);
      updateCategoriesList();
    }

    showToast(`已創建分類：${categoryName}`);
  }

  // 將對話添加到分類（支持多對多，不從其他分類移除）
  async function addConversationToCategory(chatId, categoryName) {
    if (!chatId || !categoryName) {
      console.error('[Side Panel] 無法添加到分類：缺少 chatId 或 categoryName');
      return;
    }
    
    // 確保分類存在
    if (!categories[categoryName]) {
      categories[categoryName] = [];
    }
    
    // 確保數組中沒有重複項（以防萬一）
    const uniqueChatIds = [...new Set(categories[categoryName])];
    categories[categoryName] = uniqueChatIds;
    
    // 如果對話不在該分類中，添加進去（允許一個對話在多個分類中）
    if (!categories[categoryName].includes(chatId)) {
      categories[categoryName].push(chatId);
      // 確保該分類是展開的
      expandedCategories[categoryName] = true;
      await saveData();
      await saveExpandedState();
      console.log(`[Side Panel] 已將對話 ${chatId} 添加到分類 ${categoryName}`);
    } else {
      console.log(`[Side Panel] 對話 ${chatId} 已在分類 ${categoryName} 中`);
    }
  }

  // 從分類中移除對話（但保留在其他分類中）
  async function removeConversationFromCategory(chatId, categoryName) {
    if (!chatId || !categoryName) {
      console.error('[Side Panel] 無法從分類移除：缺少 chatId 或 categoryName');
      return;
    }
    
    if (categories[categoryName]) {
      // 移除所有匹配的 chatId（以防有重複）
      const originalLength = categories[categoryName].length;
      categories[categoryName] = categories[categoryName].filter(id => id !== chatId);
      
      if (categories[categoryName].length !== originalLength) {
        await saveData();
        await saveExpandedState();
        const removedCount = originalLength - categories[categoryName].length;
        console.log(`[Side Panel] 已將對話 ${chatId} 從分類 ${categoryName} 移除 (移除了 ${removedCount} 個重複項)`);
      }
    }
  }

  // 將對話分配到分類（舊方法，保留以兼容，現在改為多對多關係）
  async function assignConversationToCategory(chatId, categoryName) {
    // 如果 categoryName 為空，從所有分類移除
    if (!categoryName || categoryName === '') {
      // 從所有分類中移除該對話
      for (const [catName, chatIds] of Object.entries(categories)) {
        const index = chatIds.indexOf(chatId);
        if (index > -1) {
          chatIds.splice(index, 1);
        }
      }
      await saveData();
      await saveExpandedState();
      return;
    }
    
    // 否則添加到指定分類（不從其他分類移除，支持多對多）
    await addConversationToCategory(chatId, categoryName);
  }

  // 顯示新增分類模態框
  function showAddCategoryModal() {
    modalOverlay.classList.add('show');
    categoryInput.focus();
  }

  // 隱藏新增分類模態框
  function hideAddCategoryModal() {
    modalOverlay.classList.remove('show');
  }

  // 設置消息監聽
  function setupMessageListeners() {
    chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
      try {
        // 檢查 runtime 是否有效
        if (!isRuntimeValid()) {
          console.warn('[Side Panel] ⚠️ Runtime 無效，嘗試恢復...');
          const recovered = await recoverExtensionConnection();
          if (!recovered) {
            sendResponse({ status: 'error', message: 'Extension context invalidated' });
            return true;
          }
        }

        console.log('[Side Panel] 收到消息:', message);
        
        if (message.action === 'conversationStateChanged') {
          const data = message.data;
          console.log('[Side Panel] 處理對話狀態變化:', data);
          
          // 重要：先檢查並切換用戶檔案（如果改變）
          if (data && data.userProfile) {
            if (data.userProfile !== currentUserProfile) {
              console.log('[Side Panel] 🔄 檢測到用戶檔案變化:', currentUserProfile, '->', data.userProfile);
              console.log('[Side Panel] 先切換用戶檔案，再處理對話信息...');
              
              // 切換用戶檔案（這會重新載入該檔案的數據）
              await switchUserProfile(data.userProfile);
              
              console.log('[Side Panel] ✓ 用戶檔案已切換到:', currentUserProfile);
            } else {
              console.log('[Side Panel] ✓ 用戶檔案未改變:', currentUserProfile);
            }
          }
          
          if (data && data.chatId) {
            currentChatId = data.chatId;
            currentTitle = data.title || null;
            currentUrl = data.url || null;
            
            console.log('[Side Panel] 更新對話信息 - ChatId:', currentChatId, 'Title:', currentTitle, 'Profile:', currentUserProfile || 'default');
            
            // 更新測試字段
            updateTestFields();
            
            // 確保對話信息已保存（使用當前用戶檔案）
            if (data.url) {
              try {
                await ensureConversationSaved(currentChatId, currentTitle, data.url);
              } catch (error) {
                console.error('[Side Panel] 保存對話信息時發生錯誤:', error);
              }
            }
            
            // 載入對話消息
            await loadConversationMessages();
            
            // 也為測試窗格載入消息
            await loadConversationMessagesForTest();
            
            // 更新列表（可能對話已被分配到分類）
            try {
              updateCategoriesList();
            } catch (error) {
              console.error('[Side Panel] 更新分類列表時發生錯誤:', error);
            }
          }
          sendResponse({ status: 'ok' });
        } else if (message.action === 'CLICK_MONITOR_UPDATED') {
          // 收到新的點擊監聽記錄
          if (clickMonitorExpanded) {
            loadClickMonitorRecords();
          }
          sendResponse({ status: 'ok' });
        } else if (message.action === 'newMessagesAvailable') {
          // 收到新消息通知，刷新對話記錄
          const data = message.data;
          console.log('[Side Panel] 📨 收到新消息通知:', data);
          
          // 如果新消息是當前對話的，立即刷新
          if (data && data.chatId === currentChatId && data.userProfile === (currentUserProfile || 'default')) {
            console.log('[Side Panel] 刷新對話記錄（新消息:', data.messageCount, '條）');
            await loadConversationMessages();
            await loadConversationMessagesForTest();
          }
          
          sendResponse({ status: 'ok' });
        } else if (message.action === 'IMAGES_DETECTED') {
          // 收到生成圖片檢測消息
          const imageData = message.data || [];
          console.log('[Side Panel] 🖼️ 收到圖片檢測消息，共', imageData.length, '張圖片');
          
          // 確保「圖像生成」分類存在
          await ensureImageGenerationCategory();
          
          // 顯示圖片
          displayGeneratedImages(imageData);
          
          // 刷新所有圖片記錄列表
          await loadAllImagesRecord();
          
          sendResponse({ status: 'ok' });
        }
      } catch (error) {
        const errorMessage = error.message || error.toString();
        console.error('[Side Panel] 處理消息時發生錯誤:', error);
        
        // 檢查是否是擴展上下文失效
        if (errorMessage.includes('Extension context invalidated') || 
            errorMessage.includes('message port closed') ||
            !isRuntimeValid()) {
          console.warn('[Side Panel] ⚠️ 擴展上下文失效，嘗試恢復...');
          await recoverExtensionConnection();
        }
        
        sendResponse({ status: 'error', message: errorMessage });
      }
      return true;
    });
  }

  // 設置定期檢查 runtime 有效性（每 5 秒檢查一次）
  function setupRuntimeHealthCheck() {
    setInterval(async () => {
      if (!isRuntimeValid()) {
        console.warn('[Side Panel] ⚠️ 檢測到 Runtime 無效，嘗試恢復...');
        await recoverExtensionConnection();
      } else {
        // Runtime 有效時，也定期檢查用戶檔案是否有變化（降低頻率）
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab && tab.url && tab.url.includes('gemini.google.com')) {
            try {
              const response = await chrome.tabs.sendMessage(tab.id, { action: 'getUserProfile' });
              if (response && response.userProfile && response.userProfile !== currentUserProfile) {
                console.log('[Side Panel] 🔄 定期檢查發現用戶檔案變化:', currentUserProfile, '->', response.userProfile);
                await switchUserProfile(response.userProfile);
              }
            } catch (error) {
              // content.js 可能未注入或未響應，靜默失敗
            }
          }
        } catch (error) {
          // 忽略錯誤，繼續運行
        }
      }
    }, 30000); // 每 30 秒檢查一次（降低頻率）
  }

  // 更新測試字段（顯示當前檢測到的對話信息）
  function updateTestFields() {
    const testUserProfileEl = document.getElementById('testUserProfile');
    const testChatIdEl = document.getElementById('testChatId');
    const testTitleEl = document.getElementById('testTitle');
    const testUrlEl = document.getElementById('testUrl');
    const testMessageCountEl = document.getElementById('testMessageCount');
    const testMessagesEl = document.getElementById('testMessages');
    
    // 更新用戶檔案顯示
    if (testUserProfileEl) {
      if (currentUserProfile && currentUserProfile !== 'default') {
        testUserProfileEl.textContent = currentUserProfile;
        testUserProfileEl.className = 'test-info-value success';
      } else {
        testUserProfileEl.textContent = '預設檔案 (尚未檢測到)';
        testUserProfileEl.className = 'test-info-value empty';
      }
    }
    
    if (testChatIdEl) {
      if (currentChatId) {
        testChatIdEl.textContent = currentChatId;
        testChatIdEl.className = 'test-info-value success';
      } else {
        testChatIdEl.textContent = '尚未檢測到';
        testChatIdEl.className = 'test-info-value empty';
      }
    }
    
    if (testTitleEl) {
      if (currentTitle) {
        testTitleEl.textContent = currentTitle;
        testTitleEl.className = 'test-info-value success';
      } else {
        testTitleEl.textContent = '尚未檢測到';
        testTitleEl.className = 'test-info-value empty';
      }
    }
    
    if (testUrlEl) {
      if (currentUrl) {
        testUrlEl.textContent = currentUrl;
        testUrlEl.className = 'test-info-value success';
      } else if (currentChatId) {
        testUrlEl.textContent = `https://gemini.google.com/app/${currentChatId}`;
        testUrlEl.className = 'test-info-value';
      } else {
        testUrlEl.textContent = '尚未檢測到';
        testUrlEl.className = 'test-info-value empty';
      }
    }
    
    // 更新消息數量顯示（使用當前對話的消息列表）
    if (testMessageCountEl) {
      if (currentConversationMessages && currentConversationMessages.length > 0) {
        testMessageCountEl.textContent = `${currentConversationMessages.length} 條消息`;
        testMessageCountEl.className = 'test-info-value success';
      } else if (currentChatId) {
        testMessageCountEl.textContent = '0 條消息 (正在載入...)';
        testMessageCountEl.className = 'test-info-value';
      } else {
        testMessageCountEl.textContent = '尚未載入';
        testMessageCountEl.className = 'test-info-value empty';
      }
    }
    
    // 更新對話記錄顯示（顯示最近的對話）
    if (testMessagesEl) {
      if (currentConversationMessages && currentConversationMessages.length > 0) {
        // 按時間戳排序，取最近的 5 條消息
        const sortedMessages = [...currentConversationMessages].sort((a, b) => {
          const timeA = a.timestamp || 0;
          const timeB = b.timestamp || 0;
          return timeB - timeA; // 降序排列（最新的在前）
        });
        
        // 反轉，讓最新的顯示在最後（從舊到新）
        const recentMessages = sortedMessages.slice(-5);
        
        const messagesHtml = recentMessages.map((msg, index) => {
          const role = msg.role || 'unknown';
          const roleLabel = role === 'user' ? '👤 用戶' : (role === 'model' || role === 'assistant') ? '🤖 Gemini' : '❓ 未知';
          const text = msg.text || '';
          const preview = text.length > 80 ? text.substring(0, 80) + '...' : text;
          const timestamp = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('zh-TW', { 
            hour: '2-digit', 
            minute: '2-digit',
            second: '2-digit'
          }) : '';
          
          return `
            <div style="margin-bottom: 0.5rem; padding: 0.5rem; background: ${role === 'user' ? '#dbeafe' : '#dcfce7'}; border-radius: 0.375rem; border-left: 4px solid ${role === 'user' ? '#3b82f6' : '#10b981'};">
              <div style="font-weight: 600; font-size: 0.75rem; margin-bottom: 0.375rem; color: ${role === 'user' ? '#1e3a8a' : '#166534'}; display: flex; justify-content: space-between; align-items: center;">
                <span>${roleLabel}</span>
                ${timestamp ? `<span style="font-weight: 400; font-size: 0.6875rem; color: #64748b;">${timestamp}</span>` : ''}
              </div>
              <div style="font-size: 0.8125rem; color: ${role === 'user' ? '#1e40af' : '#15803d'}; word-break: break-word; white-space: pre-wrap; line-height: 1.5;">${escapeHtml(preview)}</div>
            </div>
          `;
        }).join('');
        
        const moreMessages = currentConversationMessages.length > 5 
          ? `<div style="text-align: center; color: #64748b; font-size: 0.6875rem; margin-top: 0.5rem; padding: 0.375rem; background: #f1f5f9; border-radius: 0.25rem; font-style: italic;">...還有 ${currentConversationMessages.length - 5} 條消息（查看「對話記錄」以查看完整記錄）</div>`
          : '';
        
        testMessagesEl.innerHTML = messagesHtml + moreMessages;
      } else if (currentChatId) {
        testMessagesEl.innerHTML = '<div style="color: #64748b; font-style: italic; text-align: center;">正在載入對話記錄...</div>';
      } else {
        testMessagesEl.innerHTML = '<div style="color: #64748b; font-style: italic; text-align: center;">尚未載入（需要當前對話 ID）</div>';
      }
    }
    
    // 如果有當前對話 ID，嘗試載入消息（如果尚未載入）
    if (currentChatId && (!currentConversationMessages || currentConversationMessages.length === 0)) {
      loadConversationMessagesForTest();
    }
  }
  
  // 載入對話消息（用於對話記錄區域）
  async function loadConversationMessages() {
    if (!currentChatId) {
      console.log('[Side Panel] [載入消息] 沒有當前對話 ID，跳過載入');
      if (conversationMessages) {
        conversationMessages.innerHTML = '<div class="empty-message">沒有當前對話</div>';
      }
      return;
    }

    try {
      console.log('[Side Panel] [載入消息] ========== 開始載入對話記錄 ==========');
      console.log('[Side Panel] [載入消息] ChatId:', currentChatId);
      console.log('[Side Panel] [載入消息] 從 Background 本地 DB 讀取（不重新抓頁面）...');
      const response = await chrome.runtime.sendMessage({
        action: 'getConversationMessages',
        data: {
          chatId: currentChatId,
          userProfile: currentUserProfile || 'default'
        }
      });

      if (chrome.runtime.lastError) {
        console.error('[Side Panel] [載入消息] ❌ 獲取對話消息失敗:', chrome.runtime.lastError.message);
        if (conversationMessages) {
          conversationMessages.innerHTML = '<div class="empty-message">無法載入對話記錄: ' + chrome.runtime.lastError.message + '</div>';
        }
        return;
      }

      console.log('[Side Panel] [載入消息] 收到響應:', response);

      if (response && response.success && response.messages) {
        currentConversationMessages = response.messages;
        displayConversationMessages(response.messages);
        console.log('[Side Panel] [載入消息] ✓ 已載入', response.messages.length, '條消息');
        console.log('[Side Panel] [載入消息] 消息來源:', response.source || 'unknown');
      } else {
        console.warn('[Side Panel] [載入消息] ⚠️ 響應格式異常:', response);
        currentConversationMessages = [];
        if (conversationMessages) {
          conversationMessages.innerHTML = '<div class="empty-message">沒有對話記錄</div>';
        }
      }
    } catch (error) {
      console.error('[Side Panel] [載入消息] ❌ 載入對話消息時發生錯誤:', error);
      console.error('[Side Panel] [載入消息] 錯誤堆疊:', error.stack);
      currentConversationMessages = [];
      if (conversationMessages) {
        conversationMessages.innerHTML = '<div class="empty-message">載入對話記錄時發生錯誤: ' + (error.message || String(error)) + '</div>';
      }
    }
  }

      // 顯示對話消息（用於對話記錄區域）
  function displayConversationMessages(messages) {
    if (!conversationMessages) {
      console.warn('[Side Panel] [顯示消息] conversationMessages 元素不存在');
      return;
    }

    if (!messages || messages.length === 0) {
      conversationMessages.innerHTML = '<div class="empty-message">沒有對話記錄</div>';
      return;
    }

    console.log('[Side Panel] [顯示消息] 開始顯示', messages.length, '條消息');

    // 按時間戳排序（確保順序正確）
    const sortedMessages = [...messages].sort((a, b) => {
      const timeA = a.timestamp || 0;
      const timeB = b.timestamp || 0;
      return timeA - timeB; // 升序排列（最早的在前）
    });
    
    // 統計消息類型
    const userCount = sortedMessages.filter(m => m.role === 'user').length;
    const modelCount = sortedMessages.filter(m => m.role === 'model' || m.role === 'assistant').length;
    console.log('[Side Panel] [顯示消息] 消息統計: 用戶', userCount, '條, 助手', modelCount, '條');

    // 生成 HTML（完整顯示所有消息，確保長文本可以完整顯示）
    const messagesHtml = sortedMessages.map((msg, index) => {
      const role = msg.role || 'unknown';
      const roleLabel = role === 'user' ? '👤 用戶' : role === 'model' || role === 'assistant' ? '🤖 Gemini' : '❓ 未知';
      const text = msg.text || '';
      const timestamp = msg.timestamp ? new Date(msg.timestamp).toLocaleString('zh-TW', { 
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }) : '';
      
      // 根據內容動態調整對話框樣式（根據文本長度和是否有圖片/代碼塊）
      const hasImages = msg.images && msg.images.length > 0;
      const hasCodeBlocks = msg.codeBlocks && msg.codeBlocks.length > 0;
      const textLength = text.length;
      
      // 根據內容決定對話框寬度和樣式
      let messageWidth = '100%';
      let messageMaxWidth = '';
      let messageMargin = '';
      let messagePadding = '0.875rem';
      
      if (textLength < 50 && !hasImages && !hasCodeBlocks) {
        // 短消息：緊湊顯示，不佔滿寬度
        messageWidth = 'auto';
        messageMaxWidth = 'max-width: 70%;';
        messagePadding = '0.5rem 0.75rem';
        messageMargin = role === 'user' ? 'margin-left: auto; margin-right: 0.5rem;' : 'margin-left: 0.5rem; margin-right: auto;';
      } else if (textLength < 200 && !hasImages && !hasCodeBlocks) {
        // 中等消息：適中寬度
        messageWidth = 'auto';
        messageMaxWidth = 'max-width: 85%;';
        messagePadding = '0.625rem 0.875rem';
        messageMargin = role === 'user' ? 'margin-left: auto; margin-right: 0.5rem;' : 'margin-left: 0.5rem; margin-right: auto;';
      } else {
        // 長消息或有圖片/代碼塊：佔滿寬度
        messageWidth = '100%';
        messageMaxWidth = '';
        messageMargin = '';
        messagePadding = '0.875rem';
      }
      
      return `
        <div class="conversation-message ${role === 'user' ? 'user-message' : 'assistant-message'}" style="margin-bottom: 0.875rem; padding: ${messagePadding}; background: ${role === 'user' ? '#dbeafe' : '#dcfce7'}; border-radius: 0.5rem; border-left: 4px solid ${role === 'user' ? '#3b82f6' : '#10b981'}; width: ${messageWidth}; ${messageMaxWidth} ${messageMargin} box-sizing: border-box; overflow: visible; display: inline-block;">
          <div style="font-weight: 600; font-size: 0.8125rem; margin-bottom: 0.5rem; color: ${role === 'user' ? '#1e3a8a' : '#166534'}; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem;">
            <span>${roleLabel} #${index + 1}</span>
            ${timestamp ? `<span style="font-weight: 400; color: #64748b; font-size: 0.75rem; white-space: nowrap;">${timestamp}</span>` : ''}
          </div>
          ${text ? `<div style="font-size: 0.875rem; color: ${role === 'user' ? '#1e40af' : '#15803d'}; word-break: break-word; overflow-wrap: break-word; white-space: pre-wrap; line-height: 1.7; max-width: 100%; overflow: visible; hyphens: auto;">${escapeHtml(text)}</div>` : ''}
          ${msg.images && msg.images.length > 0 ? `
            <div style="margin-top: 0.5rem; padding: 0.5rem; background: rgba(0,0,0,0.02); border-radius: 0.25rem;">
              <div style="font-weight: 600; margin-bottom: 0.5rem; font-size: 0.75rem; color: #64748b;">
                📷 圖片 (${msg.images.length})
                ${msg.images[0] && msg.images[0].source ? `<span style="font-weight: 400; color: #94a3b8; font-size: 0.6875rem;"> (${msg.images[0].source})</span>` : ''}
              </div>
              <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                ${msg.images.map((img, imgIndex) => {
                  const imgId = `msg-img-${index}-${imgIndex}`;
                  const imgStyle = `max-width: 100%; height: auto; border-radius: 0.375rem; margin-bottom: 0.5rem; display: block; box-shadow: 0 2px 8px rgba(0,0,0,0.15); cursor: pointer; transition: transform 0.2s;`;
                  // 優先使用 Base64（避開 CSP），否則使用 URL
                  const displayUrl = img.base64 || img.originalUrl || img.downloadUrl || img.url;
                  
                  // 生成文件名
                  const filename = (img.alt || '圖片').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').substring(0, 50) + '_' + Date.now() + (displayUrl.includes('.jpg') ? '.jpg' : displayUrl.includes('.png') ? '.png' : displayUrl.includes('.webp') ? '.webp' : '.png');
                  
                  // 下載函數（改進版，支持更多圖片格式）
                  // 將 URL 和文件名進行轉義，避免在 onclick 中出錯
                  const safeUrl = displayUrl.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                  const safeFilename = filename.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                  
                  const downloadFunction = `(function() {
                    const url = '${safeUrl}';
                    const filename = '${safeFilename}';
                    
                    // 如果是 base64 圖片，直接下載
                    if (url.startsWith('data:')) {
                      fetch(url).then(r => r.blob()).then(blob => {
                        const downloadUrl = window.URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = downloadUrl;
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 100);
                      }).catch(err => {
                        console.error('Base64 下載失敗:', err);
                      });
                      return;
                    }
                    
                    // 對於 URL 圖片，使用 fetch 下載（支持 CORS）
                    fetch(url, { mode: 'cors' })
                      .then(res => {
                        if (!res.ok) throw new Error('HTTP ' + res.status);
                        return res.blob();
                      })
                      .then(blob => {
                        const downloadUrl = window.URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = downloadUrl;
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 100);
                      })
                      .catch(err => {
                        console.error('下載失敗:', err);
                        // 如果 fetch 失敗（可能是 CORS 問題），嘗試直接打開
                        const a = document.createElement('a');
                        a.href = url;
                        a.target = '_blank';
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                      });
                  })()`;
                  
                  // 如果是 Base64 圖片或 data URL，使用 Base64 顯示
                  if (img.base64 || img.type === 'base64' || (img.url && img.url.startsWith('data:'))) {
                    const base64Url = img.base64 || img.url;
                    return `
                      <div style="position: relative; border: 1px solid #e2e8f0; border-radius: 0.375rem; padding: 0.5rem; background: white;">
                        <img id="${imgId}" 
                             src="${escapeHtml(base64Url)}" 
                             alt="${escapeHtml(img.alt || '圖片')}" 
                             style="${imgStyle}" 
                             onclick="const el = document.getElementById('${imgId}'); el.style.transform = el.style.transform === 'scale(1.5)' ? 'scale(1)' : 'scale(1.5)'; el.style.zIndex = el.style.zIndex === '1000' ? '1' : '1000';"
                             ${img.width ? `width="${img.width}"` : ''} 
                             ${img.height ? `height="${img.height}"` : ''} />
                        <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
                          ${(() => {
                            // 優先使用 Base64，否則使用下載 URL 或原始 URL
                            const actualDownloadUrl = img.base64 || img.downloadUrl || img.originalUrl || img.url;
                            const actualSafeUrl = actualDownloadUrl.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                            const actualSafeFilename = filename;
                            
                            const actualDownloadFunction = `(function() {
                              const url = '${actualSafeUrl}';
                              const filename = '${actualSafeFilename}';
                              
                              if (url.startsWith('data:')) {
                                fetch(url).then(r => r.blob()).then(blob => {
                                  const downloadUrl = window.URL.createObjectURL(blob);
                                  const a = document.createElement('a');
                                  a.href = downloadUrl;
                                  a.download = filename;
                                  document.body.appendChild(a);
                                  a.click();
                                  document.body.removeChild(a);
                                  setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 100);
                                }).catch(err => console.error('下載失敗:', err));
                                return;
                              }
                              
                              fetch(url, { mode: 'cors' })
                                .then(res => res.ok ? res.blob() : Promise.reject(new Error('HTTP ' + res.status)))
                                .then(blob => {
                                  const downloadUrl = window.URL.createObjectURL(blob);
                                  const a = document.createElement('a');
                                  a.href = downloadUrl;
                                  a.download = filename;
                                  document.body.appendChild(a);
                                  a.click();
                                  document.body.removeChild(a);
                                  setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 100);
                                })
                                .catch(err => {
                                  console.error('下載失敗:', err);
                                  const a = document.createElement('a');
                                  a.href = url;
                                  a.target = '_blank';
                                  a.download = filename;
                                  document.body.appendChild(a);
                                  a.click();
                                  document.body.removeChild(a);
                                });
                            })()`;
                            
                            return img.downloadUrl || img.originalUrl ? `
                              <button onclick="${actualDownloadFunction}" style="padding: 0.25rem 0.5rem; background: #3b82f6; color: white; border: none; border-radius: 0.25rem; font-size: 0.75rem; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#2563eb'" onmouseout="this.style.background='#3b82f6'" title="下載原尺寸圖片">
                                💾 下載原圖 ${img.hasDownloadButton ? '✓' : ''}
                              </button>
                            ` : `
                              <button onclick="${actualDownloadFunction}" style="padding: 0.25rem 0.5rem; background: #10b981; color: white; border: none; border-radius: 0.25rem; font-size: 0.75rem; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#059669'" onmouseout="this.style.background='#10b981'">
                                💾 下載圖片
                              </button>
                            `;
                          })()}
                          ${img.url && !img.url.startsWith('data:') ? `
                            <a href="${escapeHtml(img.url)}" target="_blank" style="padding: 0.25rem 0.5rem; background: #f3f4f6; color: #1f2937; border: none; border-radius: 0.25rem; font-size: 0.75rem; text-decoration: none; display: inline-block;">
                              🔗 查看原圖
                            </a>
                          ` : ''}
                        </div>
                        ${img.alt ? `<div style="margin-top: 0.25rem; font-size: 0.6875rem; color: #64748b; font-style: italic;">${escapeHtml(img.alt)}</div>` : ''}
                      </div>
                    `;
                  } else {
                    // 非 Base64 圖片，使用 displayUrl（可能包含 URL）
                    return `
                      <div style="position: relative; border: 1px solid #e2e8f0; border-radius: 0.375rem; padding: 0.5rem; background: white;">
                        <img id="${imgId}" 
                             src="${escapeHtml(displayUrl)}" 
                             alt="${escapeHtml(img.alt || '圖片')}" 
                             style="${imgStyle}" 
                             onclick="const el = document.getElementById('${imgId}'); el.style.transform = el.style.transform === 'scale(1.5)' ? 'scale(1)' : 'scale(1.5)'; el.style.zIndex = el.style.zIndex === '1000' ? '1' : '1000';"
                             onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"
                             ${img.width ? `width="${img.width}"` : ''} 
                             ${img.height ? `height="${img.height}"` : ''} />
                        <div style="display: none; padding: 0.5rem; background: #fee2e2; border-radius: 0.25rem; color: #991b1b; font-size: 0.75rem;">
                          圖片載入失敗: ${escapeHtml((displayUrl || img.url || '').substring(0, 50))}...
                        </div>
                        <div style="margin-top: 0.5rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
                          ${img.downloadUrl || img.originalUrl ? `
                            <button onclick="${downloadFunction}" style="padding: 0.25rem 0.5rem; background: #3b82f6; color: white; border: none; border-radius: 0.25rem; font-size: 0.75rem; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#2563eb'" onmouseout="this.style.background='#3b82f6'">
                              💾 下載原圖 ${img.hasDownloadButton ? '(自動偵測)' : ''}
                            </button>
                          ` : `
                            <button onclick="${downloadFunction.replace(displayUrl, img.url)}" style="padding: 0.25rem 0.5rem; background: #10b981; color: white; border: none; border-radius: 0.25rem; font-size: 0.75rem; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#059669'" onmouseout="this.style.background='#10b981'">
                              💾 下載圖片
                            </button>
                          `}
                          <a href="${displayUrl || img.url}" target="_blank" style="padding: 0.25rem 0.5rem; background: #f3f4f6; color: #1f2937; border: none; border-radius: 0.25rem; font-size: 0.75rem; text-decoration: none; display: inline-block;">
                            🔗 查看原圖
                          </a>
                        </div>
                        ${img.alt ? `<div style="margin-top: 0.25rem; font-size: 0.6875rem; color: #64748b; font-style: italic;">${escapeHtml(img.alt)}</div>` : ''}
                      </div>
                    `;
                  }
                }).join('')}
              </div>
            </div>
          ` : ''}
          ${msg.codeBlocks && msg.codeBlocks.length > 0 ? `
            <div style="margin-top: 0.5rem; padding: 0.5rem; background: rgba(0,0,0,0.05); border-radius: 0.25rem; font-family: monospace; font-size: 0.75rem; overflow-x: auto;">
              <div style="font-weight: 600; margin-bottom: 0.25rem;">代碼塊 (${msg.codeBlocks.length})</div>
              ${msg.codeBlocks.map(block => `<pre style="margin: 0.25rem 0; white-space: pre-wrap; word-break: break-all;">${escapeHtml(block.text || '')}</pre>`).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
    
    // 添加統計信息
    const statsHtml = `<div style="padding: 0.75rem; margin-bottom: 0.75rem; background: #f8fafc; border-radius: 0.5rem; font-size: 0.8125rem; color: #475569; text-align: center;">
      共 ${sortedMessages.length} 條消息（👤 用戶 ${userCount} 條，🤖 Gemini ${modelCount} 條）
    </div>`;

    conversationMessages.innerHTML = statsHtml + messagesHtml;
    console.log('[Side Panel] [顯示消息] ✓ 已顯示', sortedMessages.length, '條消息');
    
    // 滾動到底部（顯示最新消息）
    const contentContainer = document.getElementById('conversationHistoryContent');
    if (contentContainer) {
      // 等待 DOM 更新後再滾動
      setTimeout(() => {
        contentContainer.scrollTop = contentContainer.scrollHeight;
      }, 100);
    }
  }

  // 為測試窗格載入對話消息
  async function loadConversationMessagesForTest() {
    if (!currentChatId) {
      return;
    }

    try {
      console.log('[Side Panel] [測試窗格] 從 Background 本地 DB 讀取對話消息...');
      const response = await chrome.runtime.sendMessage({
        action: 'getConversationMessages',
        data: {
          chatId: currentChatId,
          userProfile: currentUserProfile || 'default'
        }
      });

      if (chrome.runtime.lastError) {
        console.error('[Side Panel] [測試窗格] 獲取對話消息失敗:', chrome.runtime.lastError.message);
        return;
      }

      console.log('[Side Panel] [測試窗格] 收到響應:', response);

      if (response && response.success && response.messages) {
        currentConversationMessages = response.messages;
        // 更新測試字段（包括消息顯示）
        updateTestFields();
        console.log('[Side Panel] [測試窗格] ✓ 已載入', response.messages.length, '條消息');
      } else {
        currentConversationMessages = [];
        updateTestFields();
        console.warn('[Side Panel] [測試窗格] ⚠️ 響應格式異常:', response);
      }
    } catch (error) {
      console.error('[Side Panel] [測試窗格] 載入對話消息時發生錯誤:', error);
      console.error('[Side Panel] [測試窗格] 錯誤堆疊:', error.stack);
      currentConversationMessages = [];
      updateTestFields();
    }
  }

  // 發送消息
  async function sendMessage() {
    if (!sendMessageInput || !sendMessageBtn) {
      console.error('[Side Panel] [發送消息] ❌ 輸入框或按鈕元素不存在');
      return;
    }

    const messageText = sendMessageInput.value.trim();
    if (!messageText && !pendingAttachmentFile) {
      console.warn('[Side Panel] [發送消息] ⚠️ 消息內容為空');
      showToast('請輸入消息內容或上傳圖片', 2000);
      return;
    }

    try {
      console.log('[Side Panel] [發送消息] ========== 開始發送消息 ==========');
      console.log('[Side Panel] [發送消息] 消息內容:', messageText.substring(0, 50) + (messageText.length > 50 ? '...' : ''));
      console.log('[Side Panel] [發送消息] 消息長度:', messageText.length, '字符');
      
      sendMessageBtn.disabled = true;
      sendMessageBtn.textContent = '發送中...';

      // 獲取 Gemini 分頁
      const tab = await getGeminiTabInCurrentWindow();
      if (!tab || !tab.url || !tab.url.includes('gemini.google.com')) {
        console.error('[Side Panel] [發送消息] ❌ 當前標籤頁不是 Gemini 頁面');
        showToast('請在 Gemini 頁面上發送消息', 2000);
        sendMessageBtn.disabled = false;
        sendMessageBtn.textContent = '發送';
        return;
      }

      console.log('[Side Panel] [發送消息] 當前標籤頁:', tab.url);
      console.log('[Side Panel] [發送消息] 發送請求到 content.js...');

      let response;
      if (pendingAttachmentFile) {
        // 讀取圖片為 dataURL，再交給 content.js 上傳到 Gemini
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('讀取圖片失敗'));
          reader.onload = () => resolve(String(reader.result || ''));
          reader.readAsDataURL(pendingAttachmentFile);
        });

        response = await chrome.tabs.sendMessage(tab.id, {
          action: 'sendMessageWithImage',
          messageText: messageText,
          imageDataUrl: dataUrl,
          filename: pendingAttachmentFile.name || 'image.png',
          mime: pendingAttachmentFile.type || ''
        });
      } else {
        response = await chrome.tabs.sendMessage(tab.id, {
          action: 'sendMessage',
          messageText: messageText
        });
      }

      if (chrome.runtime.lastError) {
        console.error('[Side Panel] [發送消息] ❌ 發送消息失敗:', chrome.runtime.lastError.message);
        showToast('發送失敗: ' + chrome.runtime.lastError.message, 3000);
        sendMessageBtn.disabled = false;
        sendMessageBtn.textContent = '發送';
        return;
      }

      console.log('[Side Panel] [發送消息] 收到響應:', response);

      if (response && response.success) {
        showToast('消息已發送', 2000);
        sendMessageInput.value = '';
        pendingAttachmentFile = null;
        if (sendMessageFileInput) sendMessageFileInput.value = '';
        if (sendMessageAttachment) sendMessageAttachment.style.display = 'none';
        console.log('[Side Panel] [發送消息] ✓ 消息發送成功（方法:', response.method, ')');
        
        // 等待一下後刷新對話記錄（多次刷新以確保捕捉到回復）
        setTimeout(async () => {
          console.log('[Side Panel] [發送消息] 第一次刷新對話記錄...');
          await loadConversationMessages();
          await loadConversationMessagesForTest();
        }, 2000);
        
        // 再次刷新（等待 Gemini 回復）
        setTimeout(async () => {
          console.log('[Side Panel] [發送消息] 第二次刷新對話記錄（等待回復）...');
          await loadConversationMessages();
          await loadConversationMessagesForTest();
        }, 5000);
        
        // 第三次刷新（確保捕捉到完整回復）
        setTimeout(async () => {
          console.log('[Side Panel] [發送消息] 第三次刷新對話記錄...');
          await loadConversationMessages();
          await loadConversationMessagesForTest();
        }, 10000);
      } else {
        const errorMsg = response?.error || '未知錯誤';
        console.error('[Side Panel] [發送消息] ❌ 發送失敗:', errorMsg);
        showToast('發送失敗: ' + errorMsg, 3000);
      }

      sendMessageBtn.disabled = false;
      sendMessageBtn.textContent = '發送';
      console.log('[Side Panel] [發送消息] ========== 發送完成 ==========');
    } catch (error) {
      console.error('[Side Panel] [發送消息] ❌ 發送消息時發生錯誤:', error);
      console.error('[Side Panel] [發送消息] 錯誤堆疊:', error.stack);
      showToast('發送失敗: ' + (error.message || String(error)), 3000);
      sendMessageBtn.disabled = false;
      sendMessageBtn.textContent = '發送';
    }
  }

  // 從當前標籤頁獲取對話信息並更新測試字段
  async function updateTestFieldsFromCurrentTab() {
    try {
      const tab = await getGeminiTabInCurrentWindow();
      if (tab && tab.url && tab.url.includes('gemini.google.com')) {
        // 先檢測並更新用戶檔案（重要：先確認用戶是誰）
        try {
          const profileResponse = await chrome.tabs.sendMessage(tab.id, { action: 'getUserProfile' });
          if (profileResponse && profileResponse.userProfile && profileResponse.userProfile !== currentUserProfile) {
            console.log('[Side Panel] 🔄 檢測到用戶檔案變化:', currentUserProfile, '->', profileResponse.userProfile);
            await switchUserProfile(profileResponse.userProfile);
          }
        } catch (error) {
          console.log('[Side Panel] 無法獲取用戶檔案，使用當前檔案:', currentUserProfile);
        }

        // 先嘗試從 content.js 取得當前對話（比 URL 更可靠）
        currentUrl = tab.url;
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
          if (response && response.chatId) {
            currentChatId = response.chatId;
            currentTitle = response.title || null;

            if (response.userProfile && response.userProfile !== currentUserProfile) {
              console.log('[Side Panel] 🔄 從 ping 響應檢測到用戶檔案變化:', currentUserProfile, '->', response.userProfile);
              await switchUserProfile(response.userProfile);
            }

            // 標題不足時，從存儲補強
            if (!currentTitle) {
              const conversationsKey = `conversations_${currentUserProfile}`;
              const result = await chrome.storage.local.get([conversationsKey]);
              const storedConversations = result[conversationsKey] || {};
              if (storedConversations[currentChatId]) {
                currentTitle = storedConversations[currentChatId].title || null;
              }
            }

            updateTestFields();
            return;
          }
        } catch (error) {
          // ignore, fallback to URL
        }

        // fallback：提取 chatId 從 URL（chatId 不一定是純 hex）
        const urlMatch = tab.url.match(/\/app\/([^/?#]+)/);
        if (urlMatch && urlMatch[1]) {
          currentChatId = urlMatch[1];

          // 嘗試從存儲中獲取標題
          const conversationsKey = `conversations_${currentUserProfile}`;
          const result = await chrome.storage.local.get([conversationsKey]);
          const storedConversations = result[conversationsKey] || {};
          currentTitle = storedConversations[currentChatId]?.title || null;
        } else {
          currentChatId = null;
          currentTitle = null;
        }

        updateTestFields();
      } else {
        // 當前標籤頁不是 Gemini 網頁
        currentChatId = null;
        currentTitle = null;
        currentUrl = null;
        updateTestFields();
      }
    } catch (error) {
      console.error('[Side Panel] 獲取當前標籤頁信息時發生錯誤:', error);
      currentChatId = null;
      currentTitle = null;
      currentUrl = null;
      updateTestFields();
    }
  }

  // 設置存儲監聽（備用方案，按用戶檔案）
  function setupStorageListeners() {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local') {
        const categoriesKey = `categories_${currentUserProfile}`;
        const conversationsKey = `conversations_${currentUserProfile}`;
        const conversationStatesKey = `conversationStates_${currentUserProfile}`;
        
        if (changes[categoriesKey]) {
          categories = changes[categoriesKey].newValue || {};
          // 更新分類順序（保留現有順序，添加新分類）
          const existingCategories = Object.keys(categories);
          const existingInOrder = categoryOrder.filter(cat => existingCategories.includes(cat));
          const newCategories = existingCategories.filter(cat => !categoryOrder.includes(cat)).sort((a, b) => a.localeCompare(b, 'zh-TW'));
          categoryOrder = [...existingInOrder, ...newCategories];
          updateCategoriesList();
        }
        
        // 處理分類順序變化
        const categoryOrderKey = `categoryOrder_${currentUserProfile}`;
        if (changes[categoryOrderKey]) {
          categoryOrder = changes[categoryOrderKey].newValue || [];
          updateCategoriesList();
        }
        if (changes[conversationsKey]) {
          conversations = changes[conversationsKey].newValue || {};
          updateCategoriesList();
          // 同時更新對話列表
          if (conversationListExpanded) {
            loadConversationList();
          }
        }
        if (changes[conversationStatesKey]) {
          // 合併到 conversations
          const newStates = changes[conversationStatesKey].newValue || {};
          Object.entries(newStates).forEach(([chatId, data]) => {
            if (!conversations[chatId]) {
              conversations[chatId] = data;
            } else {
              conversations[chatId] = { ...conversations[chatId], ...data };
            }
          });
          updateCategoriesList();
        }
        
        // 處理用戶檔案列表變化
        if (changes.availableProfiles) {
          availableProfiles = changes.availableProfiles.newValue || ['default'];
          updateProfileSelector();
        }
      }
    });
  }

  // 確保對話信息已保存
  async function ensureConversationSaved(chatId, title, url) {
    if (!conversations[chatId]) {
      conversations[chatId] = {
        chatId: chatId,
        title: title,
        url: url,
        timestamp: Date.now()
      };
      await saveData();
    } else {
      // 更新現有對話信息
      let updated = false;
      if (title && conversations[chatId].title !== title) {
        conversations[chatId].title = title;
        updated = true;
      }
      if (url && conversations[chatId].url !== url) {
        conversations[chatId].url = url;
        updated = true;
      }
      if (updated) {
        await saveData();
      }
    }
  }

  // 自動建議分類（使用 Mock Data）
  async function suggestCategory() {
    if (!currentChatId || !currentTitle) {
      showToast('無法建議分類：缺少對話信息');
      return;
    }

    // 禁用按鈕，顯示載入狀態
    autoSuggestBtn.disabled = true;
    autoSuggestBtn.textContent = '分析中...';

    try {
      // 模擬 API 調用延遲
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Mock Data - 根據對話標題和內容建議分類
      const suggestedCategory = getMockCategorySuggestion(currentTitle);

      if (suggestedCategory) {
        // 如果分類不存在，創建它
        if (!categories[suggestedCategory]) {
          categories[suggestedCategory] = [];
          expandedCategories[suggestedCategory] = true;
          
          // 將新分類添加到順序列表末尾
          if (!categoryOrder.includes(suggestedCategory)) {
            categoryOrder.push(suggestedCategory);
            await saveCategoryOrder();
          }
          
          await saveData();
          await saveExpandedState();
        }

        // 將對話分配到建議的分類
        await assignConversationToCategory(currentChatId, suggestedCategory);
        
        // 更新 UI
        updateCategoriesList();
        
        showToast(`已建議分類：${suggestedCategory}`);
      } else {
        showToast('無法自動建議分類');
      }
    } catch (error) {
      console.error('[Side Panel] 自動建議分類時發生錯誤:', error);
      showToast('建議分類失敗');
    } finally {
      // 恢復按鈕
      autoSuggestBtn.disabled = false;
      autoSuggestBtn.textContent = '✨ 自動建議';
    }
  }

  // Mock 分類建議邏輯
  function getMockCategorySuggestion(title) {
    if (!title) return null;

    const titleLower = title.toLowerCase();
    
    // 關鍵詞匹配規則
    const rules = [
      { keywords: ['代碼', 'code', '編程', 'programming', 'function', 'class', 'api', 'bug', 'error', 'debug'], category: '編程' },
      { keywords: ['翻譯', 'translate', '語言', 'language', '英文', '中文'], category: '翻譯' },
      { keywords: ['解釋', 'explain', '說明', '什麼是', '如何', '為什麼', '學習', 'study'], category: '學習' },
      { keywords: ['寫作', 'writing', '文章', 'essay', '創意', 'creative', '故事', 'story'], category: '創意寫作' },
      { keywords: ['設計', 'design', 'ui', 'ux', '介面', 'layout'], category: '設計' },
      { keywords: ['數據', 'data', '分析', 'analysis', '統計', 'statistics'], category: '數據分析' },
      { keywords: ['商業', 'business', '市場', 'market', '策略', 'strategy'], category: '商業' },
      { keywords: ['健康', 'health', '醫療', 'medical', '運動', 'exercise'], category: '健康' },
      { keywords: ['旅遊', 'travel', '景點', '行程', 'trip'], category: '旅遊' },
      { keywords: ['美食', 'food', '食譜', 'recipe', '料理', 'cooking'], category: '美食' },
      { keywords: ['專案', 'project', '系統', 'system', '開發', 'development'], category: '專案' }
    ];

    // 檢查標題是否包含關鍵詞
    for (const rule of rules) {
      if (rule.keywords.some(keyword => titleLower.includes(keyword))) {
        return rule.category;
      }
    }

    // 如果沒有匹配，返回默認分類
    return '一般對話';
  }

  // 顯示分類分配菜單（支持多選）
  async function showAssignCategoryMenu(chatId, buttonElement) {
    // 移除現有菜單
    const existingMenu = document.querySelector('.category-menu');
    if (existingMenu) {
      existingMenu.remove();
    }

    // 創建菜單
    const menu = document.createElement('div');
    menu.className = 'category-menu';
    
    // 獲取當前對話所在的所有分類（支持多對多）
    const currentCategories = new Set();
    for (const [catName, chatIds] of Object.entries(categories)) {
      if (chatIds.includes(chatId)) {
        currentCategories.add(catName);
      }
    }

    // 添加標題
    const menuTitle = document.createElement('div');
    menuTitle.className = 'category-menu-title';
    menuTitle.textContent = '選擇分類（可多選）';
    menu.appendChild(menuTitle);

    // 添加所有分類選項（帶複選框，使用固定順序）
    const existingCategoryNames = Object.keys(categories);
    const orderedCategories = categoryOrder.filter(cat => existingCategoryNames.includes(cat));
    const newCategories = existingCategoryNames.filter(cat => !categoryOrder.includes(cat)).sort((a, b) => a.localeCompare(b, 'zh-TW'));
    const categoryNames = [...orderedCategories, ...newCategories];
    
    if (categoryNames.length === 0) {
      const noCategoryItem = document.createElement('div');
      noCategoryItem.className = 'category-menu-item';
      noCategoryItem.textContent = '尚無分類，請先創建分類';
      noCategoryItem.style.color = '#94a3b8';
      noCategoryItem.style.cursor = 'default';
      menu.appendChild(noCategoryItem);
    } else {
      categoryNames.forEach(categoryName => {
        const isChecked = currentCategories.has(categoryName);
        
        const menuItem = document.createElement('div');
        menuItem.className = `category-menu-item ${isChecked ? 'checked' : ''}`;
        menuItem.innerHTML = `
          <input type="checkbox" class="category-checkbox" id="cat-${categoryName}" 
                 ${isChecked ? 'checked' : ''} data-category="${categoryName}">
          <label for="cat-${categoryName}" class="category-menu-label">${categoryName}</label>
        `;
        
        // 點擊項目時切換狀態
        menuItem.addEventListener('click', async (e) => {
          e.stopPropagation();
          const checkbox = menuItem.querySelector('.category-checkbox');
          const wasChecked = checkbox.checked;
          
          if (wasChecked) {
            // 從分類中移除
            await removeConversationFromCategory(chatId, categoryName);
            checkbox.checked = false;
            menuItem.classList.remove('checked');
            showToast(`已從「${categoryName}」移除`);
          } else {
            // 添加到分類
            await addConversationToCategory(chatId, categoryName);
            checkbox.checked = true;
            menuItem.classList.add('checked');
            showToast(`已加入「${categoryName}」`);
          }
          
          updateCategoriesList();
          
          // 不關閉菜單，允許繼續選擇
        });
        
        menu.appendChild(menuItem);
      });
      
      // 添加「從所有分類移除」選項（如果對話有分類）
      if (currentCategories.size > 0) {
        const divider = document.createElement('div');
        divider.className = 'category-menu-divider';
        menu.appendChild(divider);
        
        const removeAllItem = document.createElement('div');
        removeAllItem.className = 'category-menu-item remove';
        removeAllItem.textContent = '從所有分類移除';
        removeAllItem.addEventListener('click', async () => {
          // 從所有分類中移除
          for (const catName of currentCategories) {
            await removeConversationFromCategory(chatId, catName);
          }
          updateCategoriesList();
          menu.remove();
          showToast('已從所有分類移除');
        });
        menu.appendChild(removeAllItem);
      }
    }

    // 定位菜單
    const rect = buttonElement.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = (rect.bottom + 5) + 'px';
    menu.style.right = '20px';
    menu.style.left = 'auto';

    document.body.appendChild(menu);

    // 點擊外部關閉菜單
    const closeMenu = (e) => {
      if (!menu.contains(e.target) && e.target !== buttonElement) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    
    setTimeout(() => {
      document.addEventListener('click', closeMenu);
    }, 100);
  }

  // 切換用戶檔案
  async function switchUserProfile(profileId) {
    console.log('[Side Panel] 切換用戶檔案:', currentUserProfile, '->', profileId);
    
    // 保存當前檔案狀態
    await saveData();
    await saveExpandedState();
    await saveCategoryOrder();
    
    // 切換到新檔案
    currentUserProfile = profileId || 'default';
    
    // 如果這是一個新檔案，添加到列表
    if (!availableProfiles.includes(currentUserProfile)) {
      availableProfiles.push(currentUserProfile);
      await saveAvailableProfiles();
    }
    
    // 載入新檔案的數據（包括分類順序）
    await loadData();
    await loadExpandedState();
    
    // 更新 UI
    updateProfileSelector();
    updateCategoriesList();
    updateTestSectionDisplay(); // 更新測試區域顯示狀態
    updateTestFields(); // 更新測試字段（包括用戶檔案顯示）
    
    showToast(`已切換到用戶檔案: ${currentUserProfile}`);
  }

  // 更新用戶檔案選擇器
  function updateProfileSelector() {
    const profileSelector = document.getElementById('profileSelector');
    if (!profileSelector) return;
    
    // 更新選擇器的選項
    profileSelector.innerHTML = '';
    availableProfiles.forEach(profile => {
      const option = document.createElement('option');
      option.value = profile;
      option.textContent = profile === 'default' ? '預設檔案' : profile;
      if (profile === currentUserProfile) {
        option.selected = true;
      }
      profileSelector.appendChild(option);
    });
    
    console.log('[Side Panel] 用戶檔案選擇器已更新，當前檔案:', currentUserProfile);
  }

  // 切換對話記錄區域展開/收起
  function toggleConversationHistory() {
    conversationHistoryExpanded = !conversationHistoryExpanded;
    
    const content = document.getElementById('conversationHistoryContent');
    const toggle = document.getElementById('conversationHistoryToggle');
    
    if (content && toggle) {
      if (conversationHistoryExpanded) {
        content.classList.add('expanded');
        toggle.classList.add('expanded');
        // 載入對話記錄
        loadConversationMessages();
      } else {
        content.classList.remove('expanded');
        toggle.classList.remove('expanded');
      }
    }
  }

  // 對話列表展開/收起狀態
  let conversationListExpanded = true; // 默認展開

  // 切換對話列表展開/收起
  function toggleConversationList() {
    conversationListExpanded = !conversationListExpanded;
    
    if (conversationListContent && conversationListToggle) {
      if (conversationListExpanded) {
        conversationListContent.style.display = 'block';
        conversationListToggle.textContent = '▼';
        conversationListToggle.classList.add('expanded');
        // 載入對話列表
        loadConversationList();
      } else {
        conversationListContent.style.display = 'none';
        conversationListToggle.textContent = '▶';
        conversationListToggle.classList.remove('expanded');
      }
    }
  }

  // 載入對話列表（顯示所有對話標題）
  async function loadConversationList() {
    if (!conversationListItems) {
      console.warn('[Side Panel] [對話列表] conversationListItems 元素不存在');
      return;
    }

    try {
      console.log('[Side Panel] [對話列表] 開始載入對話列表...');
      
      // 獲取所有對話（從 conversations 對象）
      const allConversations = Object.values(conversations || {})
        .filter(conv => conv && conv.chatId)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)); // 按時間倒序排列

      console.log('[Side Panel] [對話列表] 找到', allConversations.length, '個對話');

      if (allConversations.length === 0) {
        conversationListItems.innerHTML = '<div class="empty-state" style="text-align: center; padding: 2rem 1rem; color: #94a3b8; font-size: 0.875rem;">尚無對話記錄</div>';
        return;
      }

      // 渲染對話列表
      const conversationsHtml = allConversations.map((conv, index) => {
        const isSelected = conv.chatId === currentChatId;
        const title = conv.title || '未命名對話';
        const timestamp = conv.timestamp ? new Date(conv.timestamp).toLocaleString('zh-TW', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        }) : '';
        
        return `
          <div class="conversation-list-item" 
               data-chat-id="${escapeHtml(conv.chatId)}" 
               style="padding: 0.625rem 0.75rem; margin-bottom: 0.375rem; background: ${isSelected ? '#dcfce7' : 'white'}; border: 1px solid ${isSelected ? '#86efac' : '#e2e8f0'}; border-radius: 0.375rem; cursor: pointer; transition: all 0.15s; ${isSelected ? 'box-shadow: 0 2px 4px rgba(16, 185, 129, 0.2);' : ''}"
               onmouseover="this.style.background='${isSelected ? '#bbf7d0' : '#f8fafc'}'; this.style.borderColor='${isSelected ? '#86efac' : '#cbd5e1'}'"
               onmouseout="this.style.background='${isSelected ? '#dcfce7' : 'white'}'; this.style.borderColor='${isSelected ? '#86efac' : '#e2e8f0'}'">
            <div style="font-weight: 500; font-size: 0.875rem; color: #1e293b; margin-bottom: 0.25rem; word-break: break-word;">${escapeHtml(title)}</div>
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem; color: #64748b;">
              <span style="font-family: monospace; font-size: 0.6875rem;">${escapeHtml(conv.chatId.substring(0, 20))}${conv.chatId.length > 20 ? '...' : ''}</span>
              ${timestamp ? `<span>${timestamp}</span>` : ''}
            </div>
          </div>
        `;
      }).join('');

      conversationListItems.innerHTML = conversationsHtml;

      // 添加點擊事件
      conversationListItems.querySelectorAll('.conversation-list-item').forEach(item => {
        item.addEventListener('click', async () => {
          const chatId = item.dataset.chatId;
          if (chatId) {
            await selectConversation(chatId);
          }
        });
      });

      console.log('[Side Panel] [對話列表] ✓ 對話列表已載入');
    } catch (error) {
      console.error('[Side Panel] [對話列表] ❌ 載入對話列表時發生錯誤:', error);
      conversationListItems.innerHTML = '<div class="empty-state" style="text-align: center; padding: 2rem 1rem; color: #ef4444; font-size: 0.875rem;">載入失敗: ' + escapeHtml(error.message || String(error)) + '</div>';
    }
  }

  // 選擇對話並載入消息
  async function selectConversation(chatId) {
    if (!chatId) {
      console.warn('[Side Panel] [選擇對話] 缺少 chatId');
      return;
    }

    try {
      console.log('[Side Panel] [選擇對話] 選擇對話:', chatId);
      
      // 更新當前對話 ID
      currentChatId = chatId;
      
      // 從 conversations 對象獲取對話信息
      const conversation = conversations[chatId];
      if (conversation) {
        currentTitle = conversation.title || null;
        currentUrl = conversation.url || `https://gemini.google.com/app/${chatId}`;
      }

      // 更新測試字段
      updateTestFields();

      // 展開對話記錄區域
      if (!conversationHistoryExpanded) {
        conversationHistoryExpanded = true;
        const content = document.getElementById('conversationHistoryContent');
        const toggle = document.getElementById('conversationHistoryToggle');
        if (content && toggle) {
          content.classList.add('expanded');
          toggle.classList.add('expanded');
        }
      }

      // 載入對話消息
      await loadConversationMessages();
      await loadConversationMessagesForTest();

      // 刷新對話列表（更新選中狀態）
      await loadConversationList();

      console.log('[Side Panel] [選擇對話] ✓ 對話已選擇並載入');
    } catch (error) {
      console.error('[Side Panel] [選擇對話] ❌ 選擇對話時發生錯誤:', error);
      showToast('載入對話失敗: ' + (error.message || String(error)), 3000);
    }
  }

  // 確保「圖像生成」分類存在
  async function ensureImageGenerationCategory() {
    const categoryName = '圖像生成';
    if (!categories[categoryName]) {
      categories[categoryName] = [];
      await saveData();
      // 如果分類順序中沒有，添加到末尾
      if (!categoryOrder.includes(categoryName)) {
        categoryOrder.push(categoryName);
        await saveCategoryOrder();
      }
      console.log('[Side Panel] ✓ 已創建「圖像生成」分類');
    }
    // 確保分類是展開的
    if (!expandedCategories[categoryName]) {
      expandedCategories[categoryName] = true;
      await saveExpandedState();
    }
  }

  // Base64 轉換為 Blob（用於下載）
  function base64ToBlob(base64String, mimeType = 'image/png') {
    try {
      // 移除 data URL 前綴（如果有的話）
      const base64Data = base64String.includes(',') 
        ? base64String.split(',')[1] 
        : base64String;
      
      // 轉換 Base64 字符串為二進制數據
      const byteCharacters = atob(base64Data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      
      // 創建 Blob
      return new Blob([byteArray], { type: mimeType });
    } catch (error) {
      console.error('[Side Panel] [Base64轉換] 轉換 Blob 失敗:', error);
      return null;
    }
  }
  
  // 顯示生成圖片（在「圖像生成」分類下）
  async function displayGeneratedImages(imageData) {
    try {
      console.log('[Side Panel] [圖片顯示] ========== 開始顯示圖片 ==========');
      console.log('[Side Panel] [圖片顯示] 圖片數量:', imageData.length);
      
      // 確保「圖像生成」分類存在
      await ensureImageGenerationCategory();
      
      // 獲取或創建圖片容器
      let imageContainer = document.getElementById('image-generation-list');
      if (!imageContainer) {
        // 找到「圖像生成」分類的對話列表容器
        const categoryItem = Array.from(document.querySelectorAll('.category-item')).find(item => {
          const nameEl = item.querySelector('.category-name');
          return nameEl && nameEl.textContent === '圖像生成';
        });
        
        if (categoryItem) {
          const conversationsList = categoryItem.querySelector('.category-conversations-list');
          if (conversationsList) {
            // 創建圖片容器
            imageContainer = document.createElement('div');
            imageContainer.id = 'image-generation-list';
            imageContainer.className = 'image-generation-list';
            conversationsList.appendChild(imageContainer);
            console.log('[Side Panel] [圖片顯示] ✓ 已創建圖片容器');
          }
        }
      }
      
      if (!imageContainer) {
        console.error('[Side Panel] [圖片顯示] ❌ 無法找到或創建圖片容器');
        // 強制更新分類列表，然後再試
        updateCategoriesList();
        setTimeout(() => displayGeneratedImages(imageData), 500);
        return;
      }
      
      // 顯示每張圖片
      imageData.forEach(imgObj => {
        // 檢查是否已經顯示過這張圖
        if (!document.getElementById(`image-${imgObj.id}`)) {
          const imgElement = document.createElement('div');
          imgElement.className = 'image-card';
          imgElement.id = `image-${imgObj.id}`;
          
          // 優先使用 Base64（避開 CSP），否則使用 URL
          const imageSrc = imgObj.base64 || imgObj.url || '';
          
          // 下載函數（使用 Base64 或 URL）
          const downloadImage = () => {
            if (imgObj.base64) {
              // 如果是 Base64，創建 Blob 並下載
              const blob = base64ToBlob(imgObj.base64, 'image/png');
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `gemini-image-${imgObj.id.substring(0, 20)}.png`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setTimeout(() => URL.revokeObjectURL(url), 100);
            } else if (imgObj.url) {
              // 如果只有 URL，在新標籤頁打開
              window.open(imgObj.url, '_blank');
            }
          };
          
          imgElement.innerHTML = `
            <div class="image-card-header">
              <p class="image-timestamp">${imgObj.timestampDisplay || imgObj.timestamp || '未知時間'}</p>
              ${imgObj.bardVeMetadataKey ? `<p class="image-metadata" style="font-size: 0.625rem; color: #64748b; margin-top: 0.25rem;">Metadata: ${imgObj.id.substring(0, 20)}...</p>` : ''}
            </div>
            <img src="${escapeHtml(imageSrc)}" 
                 alt="${escapeHtml(imgObj.alt || '生成的圖片')}" 
                 class="generated-image-preview" 
                 loading="lazy"
                 onerror="this.style.display='none'; const errorEl = this.parentElement.querySelector('.image-error'); if(errorEl) errorEl.style.display='block';" />
            <div class="image-error" style="display: none;">圖片載入失敗</div>
            <div class="image-card-actions">
              <button class="btn-download" data-image-id="${escapeHtml(imgObj.id)}" 
                      data-base64="${imgObj.base64 ? 'true' : 'false'}"
                      data-url="${escapeHtml(imgObj.url || '')}"
                      title="${imgObj.base64 ? '下載圖片 (Base64)' : '在新標籤頁打開原圖'}">
                ${imgObj.base64 ? '📥 下載圖片' : '📥 下載原圖'}
              </button>
            </div>
          `;
          
          // 添加到容器頂部（最新的在前）
          imageContainer.insertBefore(imgElement, imageContainer.firstChild);
          
          // 設置下載按鈕事件監聽器（使用閉包保存 imgObj 引用）
          const downloadBtn = imgElement.querySelector('.btn-download');
          if (downloadBtn) {
            downloadBtn.addEventListener('click', () => {
              if (imgObj.base64) {
                // 如果是 Base64，創建 Blob 並下載
                const blob = base64ToBlob(imgObj.base64, 'image/png');
                if (blob) {
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `gemini-image-${imgObj.id.substring(0, 20)}.png`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  setTimeout(() => URL.revokeObjectURL(url), 100);
                  showToast('圖片已下載', 2000);
                } else {
                  showToast('下載失敗：無法轉換 Base64', 2000);
                }
              } else if (imgObj.url) {
                // 如果只有 URL，在新標籤頁打開
                window.open(imgObj.url, '_blank');
              }
            });
          }
          
          console.log('[Side Panel] [圖片顯示] ✓ 已添加圖片:', {
            id: imgObj.id.substring(0, 30),
            hasBase64: !!imgObj.base64,
            hasBardVeMetadataKey: !!imgObj.bardVeMetadataKey
          });
        }
      });
      
      // 更新分類列表（確保「圖像生成」分類可見）
      updateCategoriesList();
      
      console.log('[Side Panel] [圖片顯示] ========== 圖片顯示完成 ==========');
    } catch (error) {
      console.error('[Side Panel] [圖片顯示] ❌ 顯示圖片時發生錯誤:', error);
      console.error('[Side Panel] [圖片顯示] 錯誤堆疊:', error.stack);
    }
  }

  // 切換圖片記錄區域展開/收起
  function toggleImagesRecord() {
    imagesRecordExpanded = !imagesRecordExpanded;
    
    if (imagesRecordToggle) {
      if (imagesRecordExpanded) {
        imagesRecordToggle.textContent = '▼';
        imagesRecordToggle.classList.add('expanded');
      } else {
        imagesRecordToggle.textContent = '▶';
        imagesRecordToggle.classList.remove('expanded');
      }
    }
    
    if (imagesRecordContent) {
      if (imagesRecordExpanded) {
        imagesRecordContent.classList.add('expanded');
      } else {
        imagesRecordContent.classList.remove('expanded');
      }
    }
    
    // 保存展開狀態
    saveImagesRecordExpandedState();
    
    // 如果展開，載入圖片記錄
    if (imagesRecordExpanded) {
      loadAllImagesRecord();
    }
  }

  // 載入對話記錄展開狀態
  async function loadConversationHistoryExpandedState() {
    try {
      const userProfile = currentUserProfile || 'default';
      const storageKey = `conversationHistoryExpanded_${userProfile}`;
      const result = await chrome.storage.local.get([storageKey]);
      
      if (result[storageKey] !== undefined) {
        conversationHistoryExpanded = result[storageKey];
        
        const content = document.getElementById('conversationHistoryContent');
        const toggle = document.getElementById('conversationHistoryToggle');
        
        if (content && toggle) {
          if (conversationHistoryExpanded) {
            content.classList.add('expanded');
            toggle.classList.add('expanded');
            toggle.textContent = '▼';
          } else {
            content.classList.remove('expanded');
            toggle.classList.remove('expanded');
            toggle.textContent = '▶';
          }
        }
      }
    } catch (error) {
      console.error('[Side Panel] 載入對話記錄展開狀態時發生錯誤:', error);
    }
  }

  // 載入圖片記錄展開狀態
  async function loadImagesRecordExpandedState() {
    try {
      const userProfile = currentUserProfile || 'default';
      const storageKey = `imagesRecordExpanded_${userProfile}`;
      const result = await chrome.storage.local.get([storageKey]);
      imagesRecordExpanded = result[storageKey] || false;
      
      // 更新 UI
      if (imagesRecordToggle) {
        if (imagesRecordExpanded) {
          imagesRecordToggle.textContent = '▼';
          imagesRecordToggle.classList.add('expanded');
        } else {
          imagesRecordToggle.textContent = '▶';
          imagesRecordToggle.classList.remove('expanded');
        }
      }
      
      if (imagesRecordContent) {
        if (imagesRecordExpanded) {
          imagesRecordContent.classList.add('expanded');
          // 如果展開，載入圖片記錄
          await loadAllImagesRecord();
        } else {
          imagesRecordContent.classList.remove('expanded');
        }
      }
    } catch (error) {
      console.error('[Side Panel] 載入圖片記錄展開狀態時發生錯誤:', error);
    }
  }

  // 保存圖片記錄展開狀態
  async function saveImagesRecordExpandedState() {
    try {
      const userProfile = currentUserProfile || 'default';
      const storageKey = `imagesRecordExpanded_${userProfile}`;
      await chrome.storage.local.set({ [storageKey]: imagesRecordExpanded });
    } catch (error) {
      console.error('[Side Panel] 保存圖片記錄展開狀態時發生錯誤:', error);
    }
  }

  // 載入所有圖片記錄
  async function loadAllImagesRecord() {
    try {
      if (!imagesRecordList) {
        console.error('[Side Panel] [圖片記錄] 找不到 imagesRecordList 元素');
        return;
      }

      const userProfile = currentUserProfile || 'default';
      const storageKey = `all_images_record_${userProfile}`;
      
      console.log('[Side Panel] [圖片記錄] 開始載入圖片記錄...');
      const result = await chrome.storage.local.get([storageKey]);
      const allImages = result[storageKey] || [];
      
      console.log('[Side Panel] [圖片記錄] 找到', allImages.length, '張圖片記錄');
      
      displayAllImagesRecord(allImages);
    } catch (error) {
      console.error('[Side Panel] [圖片記錄] 載入圖片記錄時發生錯誤:', error);
      if (imagesRecordList) {
        imagesRecordList.innerHTML = '<div class="empty-state">載入失敗，請重試</div>';
      }
    }
  }

  // 標準化圖片 URL（用於去重）
  function normalizeImageUrl(url) {
    if (!url || typeof url !== 'string') return '';
    
    try {
      // 移除常見的動態查詢參數（這些參數不影響圖片內容）
      const urlObj = new URL(url);
      
      // 保留必要的參數，移除時間戳等動態參數
      const paramsToKeep = ['w', 'h', 's', 'sz', 'rw', 'rh']; // 常見的圖片尺寸參數
      const newParams = new URLSearchParams();
      
      urlObj.searchParams.forEach((value, key) => {
        // 保留尺寸相關參數，移除時間戳、token 等動態參數
        if (paramsToKeep.includes(key.toLowerCase())) {
          newParams.set(key, value);
        } else if (key.toLowerCase().includes('token') || 
                   key.toLowerCase().includes('timestamp') || 
                   key.toLowerCase().includes('t') ||
                   key.toLowerCase().includes('expire')) {
          // 跳過動態參數
        } else {
          // 其他參數也保留（以防有重要參數）
          newParams.set(key, value);
        }
      });
      
      // 重建 URL（只包含路徑和保留的參數）
      return `${urlObj.origin}${urlObj.pathname}${newParams.toString() ? '?' + newParams.toString() : ''}`;
    } catch (e) {
      // 如果 URL 解析失敗，返回原始 URL（去除查詢參數）
      try {
        const urlObj = new URL(url);
        return `${urlObj.origin}${urlObj.pathname}`;
      } catch (e2) {
        // 如果還是失敗，返回原始 URL
        return url;
      }
    }
  }

  // 顯示所有圖片記錄
  function displayAllImagesRecord(allImages) {
    if (!imagesRecordList) {
      console.error('[Side Panel] [圖片記錄] 找不到 imagesRecordList 元素');
      return;
    }

    try {
      if (allImages.length === 0) {
        imagesRecordList.innerHTML = '<div class="empty-state">尚未檢測到任何圖片</div>';
        return;
      }

      // 【去重機制】根據 URL 去重，保留最新的記錄
      const urlMap = new Map();
      allImages.forEach(img => {
        const url = img.url || '';
        if (!url) return; // 跳過沒有 URL 的記錄
        
        // 標準化 URL（移除查詢參數中的時間戳等動態參數，但保留必要的參數）
        const normalizedUrl = normalizeImageUrl(url);
        
        // 如果該 URL 已存在，比較時間戳，保留最新的
        if (urlMap.has(normalizedUrl)) {
          const existing = urlMap.get(normalizedUrl);
          const existingTime = existing.timestamp || existing.recordedAt || 0;
          const currentTime = img.timestamp || img.recordedAt || 0;
          if (currentTime > existingTime) {
            urlMap.set(normalizedUrl, img);
          }
        } else {
          urlMap.set(normalizedUrl, img);
        }
      });
      
      // 轉換回數組
      const uniqueImages = Array.from(urlMap.values());
      
      console.log(`[Side Panel] [圖片記錄] 去重前: ${allImages.length} 張，去重後: ${uniqueImages.length} 張`);

      // 按時間戳排序（最新的在前）
      const sortedImages = [...uniqueImages].sort((a, b) => {
        const timeA = a.timestamp || a.recordedAt || 0;
        const timeB = b.timestamp || b.recordedAt || 0;
        return timeB - timeA;
      });

      let html = '';
      
      sortedImages.forEach((img, index) => {
        const id = img.id || `unknown-${index}`;
        const url = img.url || (img.base64 ? 'Base64 圖片' : '無 URL');
        const alt = img.alt || '生成的圖片';
        const timestamp = img.timestamp || img.recordedAt || Date.now();
        const timestampDisplay = img.timestampDisplay || new Date(timestamp).toLocaleString('zh-TW');
        const downloaded = img.downloaded || false;
        const downloadPath = img.downloadPath || null;
        const downloadError = img.downloadError || null;
        const chatId = img.chatId || '未知對話';
        const width = img.width || null;
        const height = img.height || null;

        // 確定狀態
        let statusClass = 'pending';
        let statusText = '待下載';
        if (downloaded) {
          statusClass = 'downloaded';
          statusText = '已下載';
        } else if (downloadError) {
          statusClass = 'failed';
          statusText = '下載失敗';
        }

        // 顯示 URL（截斷過長的 URL）
        const displayUrl = url.length > 150 ? url.substring(0, 150) + '...' : url;

        html += `
          <div class="image-record-item" data-image-id="${escapeHtml(id)}">
            <div class="image-record-header-row">
              <div class="image-record-id" title="${escapeHtml(id)}">${escapeHtml(id.substring(0, 50))}${id.length > 50 ? '...' : ''}</div>
              <span class="image-record-status ${statusClass}">${statusText}</span>
            </div>
            <div class="image-record-url" title="${escapeHtml(url)}">${escapeHtml(displayUrl)}</div>
            <div class="image-record-meta">
              <div class="image-record-meta-item">
                <span>📅</span>
                <span>${escapeHtml(timestampDisplay)}</span>
              </div>
              <div class="image-record-meta-item">
                <span>💬</span>
                <span>${escapeHtml(chatId.substring(0, 20))}${chatId.length > 20 ? '...' : ''}</span>
              </div>
              ${width && height ? `
              <div class="image-record-meta-item">
                <span>📏</span>
                <span>${width} × ${height}</span>
              </div>
              ` : ''}
              ${downloadPath ? `
              <div class="image-record-meta-item" title="下載路徑">
                <span>💾</span>
                <span>${escapeHtml(downloadPath)}</span>
              </div>
              ` : ''}
              ${downloadError ? `
              <div class="image-record-meta-item" title="錯誤信息">
                <span>❌</span>
                <span style="color: #991b1b;">${escapeHtml(downloadError.substring(0, 50))}</span>
              </div>
              ` : ''}
            </div>
            <div class="image-record-actions">
              <button class="btn-copy-url" data-image-url="${escapeHtml(url)}" title="複製 URL">📋 複製 URL</button>
              <button class="btn-view-image" data-image-url="${escapeHtml(url)}" data-image-base64="${img.base64 ? escapeHtml(img.base64.substring(0, 100)) : ''}" title="查看圖片">👁️ 查看</button>
              ${!downloaded || downloadError ? `
              <button class="btn-redownload" data-image-id="${escapeHtml(id)}" title="重新下載">⬇️ 重新下載</button>
              ` : ''}
            </div>
          </div>
        `;
      });

      imagesRecordList.innerHTML = html;

      // 設置事件監聽器
      setupImagesRecordEventListeners();

      console.log('[Side Panel] [圖片記錄] ✓ 已顯示', sortedImages.length, '張圖片記錄');
    } catch (error) {
      console.error('[Side Panel] [圖片記錄] 顯示圖片記錄時發生錯誤:', error);
      imagesRecordList.innerHTML = '<div class="empty-state">顯示失敗，請重試</div>';
    }
  }

  // 設置圖片記錄事件監聽器
  function setupImagesRecordEventListeners() {
    if (!imagesRecordList) return;

    // 複製 URL 按鈕
    imagesRecordList.querySelectorAll('.btn-copy-url').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const url = e.target.getAttribute('data-image-url');
        if (url) {
          try {
            await navigator.clipboard.writeText(url);
            showToast('URL 已複製到剪貼板', 2000);
            console.log('[Side Panel] [圖片記錄] ✓ URL 已複製:', url.substring(0, 50));
          } catch (error) {
            console.error('[Side Panel] [圖片記錄] 複製 URL 失敗:', error);
            showToast('複製失敗，請手動複製', 2000);
          }
        }
      });
    });

    // 查看圖片按鈕
    imagesRecordList.querySelectorAll('.btn-view-image').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const url = e.target.getAttribute('data-image-url');
        const base64 = e.target.getAttribute('data-image-base64');
        
        if (base64 && base64.length > 0) {
          // 如果有 Base64，創建 Blob URL 並打開
          try {
            const blob = base64ToBlob(base64, 'image/png');
            if (blob) {
              const blobUrl = URL.createObjectURL(blob);
              window.open(blobUrl, '_blank');
              // 延遲清理 URL
              setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
            } else {
              window.open(url, '_blank');
            }
          } catch (error) {
            console.error('[Side Panel] [圖片記錄] 打開 Base64 圖片失敗:', error);
            window.open(url, '_blank');
          }
        } else if (url && !url.startsWith('data:')) {
          window.open(url, '_blank');
        } else if (url && url.startsWith('data:')) {
          window.open(url, '_blank');
        } else {
          showToast('無法查看圖片：缺少 URL', 2000);
        }
      });
    });

    // 重新下載按鈕
    imagesRecordList.querySelectorAll('.btn-redownload').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const imageId = e.target.getAttribute('data-image-id');
        if (imageId) {
          showToast('重新下載中...', 2000);
          
          // 發送消息到 background.js 觸發重新下載
          try {
            const userProfile = currentUserProfile || 'default';
            const storageKey = `all_images_record_${userProfile}`;
            const result = await chrome.storage.local.get([storageKey]);
            const allImages = result[storageKey] || [];
            const image = allImages.find(img => img.id === imageId);
            
            if (image) {
              // 重置下載狀態
              image.downloaded = false;
              image.downloadError = null;
              image.downloadPath = null;
              
              // 保存狀態
              await chrome.storage.local.set({ [storageKey]: allImages });
              
              // 發送到 background.js 觸發重新下載
              chrome.runtime.sendMessage({
                action: 'RECORD_IMAGE',
                data: image
              }, (response) => {
                if (chrome.runtime.lastError) {
                  console.error('[Side Panel] [圖片記錄] 重新下載失敗:', chrome.runtime.lastError.message);
                  showToast('重新下載失敗', 2000);
                } else if (response && response.status === 'ok') {
                  showToast('重新下載已觸發', 2000);
                  // 刷新列表
                  setTimeout(() => loadAllImagesRecord(), 1000);
                }
              });
            } else {
              showToast('找不到圖片記錄', 2000);
            }
          } catch (error) {
            console.error('[Side Panel] [圖片記錄] 重新下載時發生錯誤:', error);
            showToast('重新下載失敗', 2000);
          }
        }
      });
    });
  }

  // 備份對話記錄（導出為 JSON 文件）
  async function backupConversationMessages() {
    if (!currentChatId) {
      showToast('沒有可備份的對話記錄（缺少對話 ID）', 2000);
      return;
    }

    try {
      console.log('[Side Panel] [備份] ========== 開始備份對話記錄 ==========');
      console.log('[Side Panel] [備份] ChatId:', currentChatId);
      
      // 如果當前消息列表為空，先從數據庫載入
      let messagesToBackup = currentConversationMessages || [];
      if (messagesToBackup.length === 0) {
        console.log('[Side Panel] [備份] 當前消息列表為空，從數據庫載入...');
        showToast('正在載入對話記錄...', 2000);
        
        const response = await chrome.runtime.sendMessage({
          action: 'getConversationMessages',
          data: {
            chatId: currentChatId,
            userProfile: currentUserProfile || 'default'
          }
        });

        if (chrome.runtime.lastError) {
          console.error('[Side Panel] [備份] ❌ 獲取對話消息失敗:', chrome.runtime.lastError.message);
          showToast('備份失敗: 無法載入對話記錄', 3000);
          return;
        }

        if (response && response.success && response.messages) {
          messagesToBackup = response.messages;
          currentConversationMessages = messagesToBackup; // 更新當前消息列表
          console.log('[Side Panel] [備份] ✓ 已從數據庫載入', messagesToBackup.length, '條消息');
        } else {
          console.warn('[Side Panel] [備份] ⚠️ 響應格式異常或沒有消息:', response);
          showToast('沒有可備份的對話記錄', 2000);
          return;
        }
      }

      if (messagesToBackup.length === 0) {
        showToast('沒有可備份的對話記錄', 2000);
        return;
      }

      console.log('[Side Panel] [備份] 消息數量:', messagesToBackup.length);

      // 構建備份數據
      const backupData = {
        version: '1.0',
        exportDate: new Date().toISOString(),
        chatId: currentChatId,
        title: currentTitle || '未命名對話',
        url: currentUrl || `https://gemini.google.com/app/${currentChatId}`,
        userProfile: currentUserProfile || 'default',
        messageCount: messagesToBackup.length,
        messages: messagesToBackup.map(msg => ({
          role: msg.role || 'unknown',
          text: msg.text || '',
          timestamp: msg.timestamp || Date.now(),
          codeBlocks: msg.codeBlocks || []
        }))
      };

      // 轉換為 JSON 字符串
      const jsonString = JSON.stringify(backupData, null, 2);
      
      // 創建 Blob
      const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
      
      // 創建下載鏈接
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const fileName = `gemini-對話記錄-${currentChatId}-${new Date().toISOString().split('T')[0]}.json`;
      a.href = url;
      a.download = fileName;
      
      // 觸發下載
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      // 清理 URL
      setTimeout(() => URL.revokeObjectURL(url), 100);
      
      console.log('[Side Panel] [備份] ✓ 對話記錄已導出:', fileName);
      showToast(`對話記錄已導出為 ${fileName}`, 3000);
    } catch (error) {
      console.error('[Side Panel] [備份] ❌ 備份對話記錄時發生錯誤:', error);
      console.error('[Side Panel] [備份] 錯誤堆疊:', error.stack);
      showToast('備份失敗: ' + (error.message || String(error)), 3000);
    }
  }

  // 操作日誌監控區域展開/收起
  function toggleOperationLogs() {
    operationLogsExpanded = !operationLogsExpanded;
    
    if (operationLogsToggle) {
      if (operationLogsExpanded) {
        operationLogsToggle.classList.add('expanded');
      } else {
        operationLogsToggle.classList.remove('expanded');
      }
    }
    
    if (operationLogsContent) {
      if (operationLogsExpanded) {
        operationLogsContent.classList.add('expanded');
        // 如果展開，載入操作日誌
        loadOperationLogs();
        // 開始自動刷新（每 5 秒）
        startOperationLogsAutoRefresh();
      } else {
        operationLogsContent.classList.remove('expanded');
        // 如果收起，停止自動刷新
        stopOperationLogsAutoRefresh();
      }
    }
    
    // 保存展開狀態
    saveOperationLogsExpandedState();
  }

  // 開始自動刷新操作日誌
  function startOperationLogsAutoRefresh() {
    stopOperationLogsAutoRefresh(); // 先清除現有的定時器
    operationLogsRefreshInterval = setInterval(() => {
      if (operationLogsExpanded) {
        loadOperationLogs();
      }
    }, 5000); // 每 5 秒刷新一次
  }

  // 停止自動刷新操作日誌
  function stopOperationLogsAutoRefresh() {
    if (operationLogsRefreshInterval) {
      clearInterval(operationLogsRefreshInterval);
      operationLogsRefreshInterval = null;
    }
  }

  // 切換下載按鈕測試區域
  function toggleDownloadButtonsTest() {
    downloadButtonsTestExpanded = !downloadButtonsTestExpanded;
    
    if (downloadButtonsTestToggle) {
      downloadButtonsTestToggle.textContent = downloadButtonsTestExpanded ? '▼' : '▶';
      downloadButtonsTestToggle.classList.toggle('expanded', downloadButtonsTestExpanded);
    }
    
    if (downloadButtonsTestContent) {
      downloadButtonsTestContent.style.display = downloadButtonsTestExpanded ? 'block' : 'none';
    }
    
    if (downloadButtonsTestExpanded) {
      loadDownloadButtons();
      // 開始自動刷新（每 3 秒）
      startDownloadButtonsAutoRefresh();
    } else {
      // 如果收起，停止自動刷新
      stopDownloadButtonsAutoRefresh();
    }
    
    saveDownloadButtonsTestExpandedState();
  }

  // 開始自動刷新下載按鈕列表
  function startDownloadButtonsAutoRefresh() {
    stopDownloadButtonsAutoRefresh(); // 先清除現有的定時器
    downloadButtonsRefreshInterval = setInterval(() => {
      if (downloadButtonsTestExpanded) {
        loadDownloadButtons();
      }
    }, 3000); // 每 3 秒刷新一次
  }

  // 停止自動刷新下載按鈕列表
  function stopDownloadButtonsAutoRefresh() {
    if (downloadButtonsRefreshInterval) {
      clearInterval(downloadButtonsRefreshInterval);
      downloadButtonsRefreshInterval = null;
    }
  }

  // 載入下載按鈕列表
  async function loadDownloadButtons() {
    try {
      if (!downloadButtonsTestList) {
        console.error('[Side Panel] [下載按鈕測試] 找不到 downloadButtonsTestList 元素');
        return;
      }

      downloadButtonsTestList.innerHTML = '<div class="empty-state">載入中...</div>';
      
      // 從 content.js 獲取下載按鈕列表
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length === 0 || !tabs[0].url || !tabs[0].url.includes('gemini.google.com')) {
          downloadButtonsTestList.innerHTML = '<div class="empty-state">請在 Gemini 頁面使用此功能</div>';
          if (downloadButtonsCount) {
            downloadButtonsCount.textContent = '0';
          }
          return;
        }

        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'GET_DOWNLOAD_BUTTONS'
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('[Side Panel] [下載按鈕測試] 獲取按鈕失敗:', chrome.runtime.lastError.message);
            downloadButtonsTestList.innerHTML = '<div class="empty-state">獲取失敗: ' + chrome.runtime.lastError.message + '</div>';
            if (downloadButtonsCount) {
              downloadButtonsCount.textContent = '0';
            }
            return;
          }

          if (response && response.status === 'ok' && response.buttons) {
            const buttons = response.buttons || [];
            displayDownloadButtons(buttons);
            
            if (downloadButtonsCount) {
              downloadButtonsCount.textContent = buttons.length.toString();
            }
          } else {
            console.error('[Side Panel] [下載按鈕測試] 獲取按鈕失敗:', response);
            downloadButtonsTestList.innerHTML = '<div class="empty-state">獲取失敗</div>';
            if (downloadButtonsCount) {
              downloadButtonsCount.textContent = '0';
            }
          }
        });
      });
    } catch (error) {
      console.error('[Side Panel] [下載按鈕測試] 載入按鈕時發生錯誤:', error);
      if (downloadButtonsTestList) {
        downloadButtonsTestList.innerHTML = '<div class="empty-state">載入失敗，請重試</div>';
      }
      if (downloadButtonsCount) {
        downloadButtonsCount.textContent = '0';
      }
    }
  }

  // 顯示下載按鈕列表
  function displayDownloadButtons(buttons) {
    if (!downloadButtonsTestList) {
      console.error('[Side Panel] [下載按鈕測試] 找不到 downloadButtonsTestList 元素');
      return;
    }

    try {
      if (buttons.length === 0) {
        downloadButtonsTestList.innerHTML = '<div class="empty-state">尚未監控到任何下載按鈕</div>';
        return;
      }

      let html = '';
      buttons.forEach((button, index) => {
        const ariaLabel = button.ariaLabel || '無標籤';
        const dataTestId = button.dataTestId || '無';
        const jslog = (button.jslog || '').substring(0, 100);
        
        html += `
          <div class="log-entry">
            <div class="log-entry-header">
              <span class="log-entry-operation">按鈕 #${index + 1}</span>
              <button class="log-entry-download-btn" 
                      data-button-index="${index}"
                      title="測試點擊此按鈕">
                🖱️ 測試點擊
              </button>
            </div>
            <div class="log-entry-details">
              <div><strong>aria-label:</strong> ${escapeHtml(ariaLabel)}</div>
              <div><strong>data-test-id:</strong> ${escapeHtml(dataTestId)}</div>
              ${jslog ? `<div><strong>jslog:</strong> ${escapeHtml(jslog)}...</div>` : ''}
            </div>
          </div>
        `;
      });

      downloadButtonsTestList.innerHTML = html;
      
      // 為測試點擊按鈕添加事件監聽器（每次刷新時重新綁定）
      // 注意：由於 innerHTML 會清除所有舊的事件監聽器，所以每次都需要重新綁定
      const testButtons = downloadButtonsTestList.querySelectorAll('.log-entry-download-btn');
      console.log('[Side Panel] [下載按鈕測試] 找到', testButtons.length, '個測試點擊按鈕，正在綁定事件監聽器...');
      
      if (testButtons.length === 0) {
        console.warn('[Side Panel] [下載按鈕測試] ⚠️ 未找到任何測試點擊按鈕');
      }
      
      testButtons.forEach((btn, btnIndex) => {
        // 直接綁定事件監聽器（因為 innerHTML 已經清除了舊的監聽器）
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          
          const buttonIndexStr = btn.getAttribute('data-button-index');
          const buttonIndex = buttonIndexStr !== null ? parseInt(buttonIndexStr, 10) : -1;
          
          console.log('[Side Panel] [下載按鈕測試] 點擊測試按鈕，索引:', buttonIndex, '總按鈕數:', buttons.length);
          
          if (isNaN(buttonIndex) || buttonIndex < 0 || buttonIndex >= buttons.length) {
            console.error('[Side Panel] [下載按鈕測試] 無效的按鈕索引:', buttonIndex, '按鈕數:', buttons.length);
            showToast(`無效的按鈕索引: ${buttonIndex}`, 2000);
            return;
          }

          showToast(`正在測試點擊按鈕 #${buttonIndex + 1}...`, 2000);
          
          // 發送點擊請求到 content.js
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length === 0) {
              console.error('[Side Panel] [下載按鈕測試] 無法獲取當前標籤頁');
              showToast('無法獲取當前標籤頁', 2000);
              return;
            }

            console.log('[Side Panel] [下載按鈕測試] 發送點擊請求，按鈕索引:', buttonIndex);
            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'CLICK_DOWNLOAD_BUTTON',
              buttonIndex: buttonIndex
            }, (response) => {
              if (chrome.runtime.lastError) {
                console.error('[Side Panel] [下載按鈕測試] 點擊失敗:', chrome.runtime.lastError.message);
                showToast('點擊失敗: ' + chrome.runtime.lastError.message, 3000);
                return;
              }

              console.log('[Side Panel] [下載按鈕測試] 收到響應:', response);
              if (response && response.status === 'ok') {
                console.log('[Side Panel] [下載按鈕測試] ✓ 點擊成功');
                showToast(`按鈕 #${buttonIndex + 1} 點擊成功`, 2000);
                // 刷新列表
                setTimeout(() => {
                  loadDownloadButtons();
                }, 1000);
              } else {
                console.error('[Side Panel] [下載按鈕測試] 點擊失敗:', response);
                showToast('點擊失敗: ' + (response?.error || response?.message || '未知錯誤'), 3000);
              }
            });
          });
        });
      });

      console.log('[Side Panel] [下載按鈕測試] ✓ 已顯示', buttons.length, '個按鈕');
    } catch (error) {
      console.error('[Side Panel] [下載按鈕測試] 顯示按鈕時發生錯誤:', error);
      downloadButtonsTestList.innerHTML = '<div class="empty-state">顯示失敗，請重試</div>';
    }
  }

  // 保存下載按鈕測試區域展開狀態
  async function saveDownloadButtonsTestExpandedState() {
    try {
      const userProfile = currentUserProfile || 'default';
      const storageKey = `downloadButtonsTestExpanded_${userProfile}`;
      await chrome.storage.local.set({ [storageKey]: downloadButtonsTestExpanded });
    } catch (error) {
      console.error('[Side Panel] 保存下載按鈕測試展開狀態時發生錯誤:', error);
    }
  }

  // 載入下載按鈕測試區域展開狀態
  async function loadDownloadButtonsTestExpandedState() {
    try {
      const userProfile = currentUserProfile || 'default';
      const storageKey = `downloadButtonsTestExpanded_${userProfile}`;
      const result = await chrome.storage.local.get([storageKey]);
      const savedState = result[storageKey];
      
      if (savedState !== undefined) {
        downloadButtonsTestExpanded = savedState;
        
        if (downloadButtonsTestToggle) {
          downloadButtonsTestToggle.textContent = downloadButtonsTestExpanded ? '▼' : '▶';
          downloadButtonsTestToggle.classList.toggle('expanded', downloadButtonsTestExpanded);
        }
        
        if (downloadButtonsTestContent) {
          downloadButtonsTestContent.style.display = downloadButtonsTestExpanded ? 'block' : 'none';
        }
        
        if (downloadButtonsTestExpanded) {
          loadDownloadButtons();
        }
      }
    } catch (error) {
      console.error('[Side Panel] 載入下載按鈕測試展開狀態時發生錯誤:', error);
    }
  }

  // 載入操作日誌
  async function loadOperationLogs() {
    try {
      if (!operationLogsList) {
        console.error('[Side Panel] [操作日誌] 找不到 operationLogsList 元素');
        return;
      }

      const userProfile = currentUserProfile || 'default';
      
      console.log('[Side Panel] [操作日誌] 開始載入操作日誌...');
      
      // 從 background.js 獲取日誌
      chrome.runtime.sendMessage({
        action: 'GET_OPERATION_LOGS',
        userProfile: userProfile
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[Side Panel] [操作日誌] 獲取日誌失敗:', chrome.runtime.lastError.message);
          if (operationLogsList) {
            operationLogsList.innerHTML = '<div class="empty-state">載入失敗，請重試</div>';
          }
          return;
        }

        if (response && response.status === 'ok' && response.logs) {
          const logs = response.logs || [];
          console.log('[Side Panel] [操作日誌] 找到', logs.length, '條日誌');
          displayOperationLogs(logs);
          updateOperationLogsStats(logs);
        } else {
          console.error('[Side Panel] [操作日誌] 獲取日誌失敗:', response);
          if (operationLogsList) {
            operationLogsList.innerHTML = '<div class="empty-state">載入失敗</div>';
          }
        }
      });
    } catch (error) {
      console.error('[Side Panel] [操作日誌] 載入日誌時發生錯誤:', error);
      if (operationLogsList) {
        operationLogsList.innerHTML = '<div class="empty-state">載入失敗，請重試</div>';
      }
    }
  }

  // 更新操作日誌統計
  function updateOperationLogsStats(logs) {
    if (!logsTotalCount || !logsLatestTime) return;

    const totalCount = logs.length;
    logsTotalCount.textContent = totalCount.toString();

    if (logs.length > 0) {
      // 按時間戳排序（最新的在前）
      const sortedLogs = [...logs].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      const latestLog = sortedLogs[0];
      const latestTime = latestLog.timestampDisplay || new Date(latestLog.timestamp || Date.now()).toLocaleString('zh-TW');
      logsLatestTime.textContent = latestTime;
    } else {
      logsLatestTime.textContent = '無';
    }
  }

  // 顯示操作日誌
  function displayOperationLogs(logs) {
    if (!operationLogsList) {
      console.error('[Side Panel] [操作日誌] 找不到 operationLogsList 元素');
      return;
    }

    try {
      if (logs.length === 0) {
        operationLogsList.innerHTML = '<div class="empty-state">尚未記錄任何操作</div>';
        return;
      }

      // 按時間戳排序（最新的在前）
      const sortedLogs = [...logs].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      
      // 顯示所有日誌（不限制數量）
      const displayLogs = sortedLogs;

      let html = '';
      
      displayLogs.forEach((log, index) => {
        const operation = log.operation || '未知操作';
        const time = log.timestampDisplay || new Date(log.timestamp || Date.now()).toLocaleString('zh-TW');
        const chatId = log.chatId ? (log.chatId.substring(0, 20) + (log.chatId.length > 20 ? '...' : '')) : '無';
        const url = log.url || '無';
        const displayUrl = url.length > 100 ? url.substring(0, 100) + '...' : url;
        
        // 檢查是否包含可下載的 URL（originalUrl 或其他 URL）
        const originalUrl = (log.data && log.data.originalUrl) || (log.url && log.url !== '無' ? log.url : null);
        const requestId = (log.data && log.data.requestId) || (log.requestId) || null;
        const hasDownloadableUrl = originalUrl && originalUrl.includes('googleusercontent.com');
        
        let detailsHtml = '';
        if (log.data && Object.keys(log.data).length > 0) {
          detailsHtml = '<div class="log-entry-details">';
          for (const [key, value] of Object.entries(log.data)) {
            if (value !== null && value !== undefined) {
              let displayValue = String(value);
              if (displayValue.length > 100) {
                displayValue = displayValue.substring(0, 100) + '...';
              }
              detailsHtml += `<div><strong>${escapeHtml(key)}:</strong> ${escapeHtml(displayValue)}</div>`;
            }
          }
          detailsHtml += '</div>';
        }
        
        // 下載按鈕 HTML（僅在包含可下載 URL 時顯示）
        const downloadButtonHtml = hasDownloadableUrl ? `
          <button class="log-entry-download-btn" 
                  data-log-index="${index}"
                  data-original-url="${escapeHtml(originalUrl)}"
                  data-request-id="${escapeHtml(requestId || '')}"
                  title="下載圖片">
            📥 下載
          </button>
        ` : '';

        html += `
          <div class="log-entry" data-log-index="${index}">
            <div class="log-entry-header">
              <span class="log-entry-operation">${escapeHtml(operation)}</span>
              <span class="log-entry-time">${escapeHtml(time)}</span>
              ${downloadButtonHtml}
            </div>
            <div class="log-entry-details">
              <div>對話ID: ${escapeHtml(chatId)}</div>
              ${url !== '無' ? `<div class="log-entry-url" title="${escapeHtml(url)}">URL: ${escapeHtml(displayUrl)}</div>` : ''}
              ${detailsHtml}
            </div>
          </div>
        `;
      });

      // 顯示總數信息
      html += `<div class="empty-state" style="margin-top: 0.5rem; font-size: 0.6875rem; color: #64748b; padding: 0.5rem; background: #f8fafc; border-radius: 0.25rem;">共顯示 ${displayLogs.length} 條日誌</div>`;

      operationLogsList.innerHTML = html;
      
      // 為下載按鈕添加事件監聽器（需要將完整的 logs 數據傳遞，因為 displayLogs 是按索引的）
      setupLogEntryDownloadButtons(logs);

      console.log('[Side Panel] [操作日誌] ✓ 已顯示', displayLogs.length, '條日誌');
    } catch (error) {
      console.error('[Side Panel] [操作日誌] 顯示日誌時發生錯誤:', error);
      operationLogsList.innerHTML = '<div class="empty-state">顯示失敗，請重試</div>';
    }
  }

  // 為日誌條目的下載按鈕設置事件監聽器
  function setupLogEntryDownloadButtons(logs) {
    const downloadButtons = operationLogsList.querySelectorAll('.log-entry-download-btn');
    downloadButtons.forEach((button) => {
      button.addEventListener('click', async (e) => {
        e.stopPropagation();
        const originalUrl = button.getAttribute('data-original-url');
        const requestId = button.getAttribute('data-request-id') || null;
        
        if (!originalUrl) {
          showToast('無法獲取圖片 URL', 2000);
          return;
        }
        
        console.log('[Side Panel] [操作日誌] 開始下載圖片...', {
          originalUrl: originalUrl.substring(0, 100),
          requestId: requestId
        });
        
        showToast('正在下載圖片...', 2000);
        
        // 發送下載請求到 background.js
        chrome.runtime.sendMessage({
          action: 'DOWNLOAD_IMAGE',
          url: originalUrl,
          requestId: requestId,
          filename: null // 讓 background.js 自動生成文件名
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('[Side Panel] [操作日誌] 下載失敗:', chrome.runtime.lastError.message);
            showToast('下載失敗: ' + chrome.runtime.lastError.message, 3000);
            return;
          }
          
          if (response && response.status === 'ok') {
            console.log('[Side Panel] [操作日誌] ✓ 圖片下載已啟動');
            showToast('圖片下載已啟動', 2000);
          } else {
            console.error('[Side Panel] [操作日誌] 下載失敗:', response);
            showToast('下載失敗: ' + (response.error || response.message || '未知錯誤'), 3000);
          }
        });
      });
    });
  }

  // 導出操作日誌
  async function exportOperationLogs() {
    try {
      const userProfile = currentUserProfile || 'default';
      
      console.log('[Side Panel] [操作日誌] 開始導出日誌...');
      showToast('正在導出日誌...', 2000);
      
      // 從 background.js 導出日誌
      chrome.runtime.sendMessage({
        action: 'EXPORT_OPERATION_LOGS',
        userProfile: userProfile
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[Side Panel] [操作日誌] 導出失敗:', chrome.runtime.lastError.message);
          showToast('導出失敗: ' + chrome.runtime.lastError.message, 3000);
          return;
        }

        if (response && response.status === 'ok') {
          console.log('[Side Panel] [操作日誌] ✓ 日誌已導出:', response.filename);
          showToast(`日誌已導出 (${response.logCount} 條)`, 3000);
          // 刷新日誌列表
          loadOperationLogs();
        } else {
          console.error('[Side Panel] [操作日誌] 導出失敗:', response);
          showToast('導出失敗: ' + (response.error || response.message || '未知錯誤'), 3000);
        }
      });
    } catch (error) {
      console.error('[Side Panel] [操作日誌] 導出日誌時發生錯誤:', error);
      showToast('導出失敗: ' + error.message, 3000);
    }
  }

  // 保存操作日誌展開狀態
  async function saveOperationLogsExpandedState() {
    try {
      const userProfile = currentUserProfile || 'default';
      const storageKey = `operationLogsExpanded_${userProfile}`;
      await chrome.storage.local.set({ [storageKey]: operationLogsExpanded });
    } catch (error) {
      console.error('[Side Panel] 保存操作日誌展開狀態時發生錯誤:', error);
    }
  }

  // 載入操作日誌展開狀態
  async function loadOperationLogsExpandedState() {
    try {
      const userProfile = currentUserProfile || 'default';
      const storageKey = `operationLogsExpanded_${userProfile}`;
      const result = await chrome.storage.local.get([storageKey]);
      
      if (result[storageKey] !== undefined) {
        operationLogsExpanded = result[storageKey];
        
        if (operationLogsToggle) {
          if (operationLogsExpanded) {
            operationLogsToggle.classList.add('expanded');
          } else {
            operationLogsToggle.classList.remove('expanded');
          }
        }
        
        if (operationLogsContent) {
          if (operationLogsExpanded) {
            operationLogsContent.classList.add('expanded');
            // 如果展開，載入操作日誌
            await loadOperationLogs();
            // 開始自動刷新
            startOperationLogsAutoRefresh();
          } else {
            operationLogsContent.classList.remove('expanded');
          }
        }
      }
    } catch (error) {
      console.error('[Side Panel] 載入操作日誌展開狀態時發生錯誤:', error);
    }
  }

  // 載入暫停狀態
  async function loadPauseState() {
    try {
      const result = await chrome.storage.local.get(['monitoringPaused']);
      const isPaused = result.monitoringPaused || false;
      
      if (pauseMonitoringBtn) {
        if (isPaused) {
          pauseMonitoringBtn.textContent = '▶️ 恢復監控';
          pauseMonitoringBtn.classList.add('paused');
        } else {
          pauseMonitoringBtn.textContent = '⏸️ 暫停監控';
          pauseMonitoringBtn.classList.remove('paused');
        }
      }
      
      return isPaused;
    } catch (error) {
      console.error('[Side Panel] 載入暫停狀態時發生錯誤:', error);
      return false;
    }
  }

  // 切換監控暫停狀態
  async function toggleMonitoringPause() {
    try {
      const result = await chrome.storage.local.get(['monitoringPaused']);
      const isPaused = result.monitoringPaused || false;
      const newPausedState = !isPaused;
      
      // 保存暫停狀態
      await chrome.storage.local.set({ monitoringPaused: newPausedState });
      
      // 更新按鈕狀態
      if (pauseMonitoringBtn) {
        if (newPausedState) {
          pauseMonitoringBtn.textContent = '▶️ 恢復監控';
          pauseMonitoringBtn.classList.add('paused');
          showToast('監控已暫停', 2000);
        } else {
          pauseMonitoringBtn.textContent = '⏸️ 暫停監控';
          pauseMonitoringBtn.classList.remove('paused');
          showToast('監控已恢復', 2000);
        }
      }
      
      // 發送消息到 content.js
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('gemini.google.com')) {
        chrome.tabs.sendMessage(tab.id, {
          action: newPausedState ? 'pauseMonitoring' : 'resumeMonitoring'
        }).catch(err => {
          console.log('[Side Panel] 發送暫停/恢復消息時發生錯誤（可忽略）:', err.message);
        });
      }
      
      console.log('[Side Panel] 監控狀態已切換:', newPausedState ? '暫停' : '恢復');
    } catch (error) {
      console.error('[Side Panel] 切換監控暫停狀態時發生錯誤:', error);
      showToast('操作失敗: ' + error.message, 3000);
    }
  }

  // 顯示 Toast 通知
  function showToast(message, duration = 3000) {
    toast.textContent = message;
    toast.classList.add('show');
    
    setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }

  // ========== 點擊監聽記錄功能 ==========

  // 切換點擊監聽記錄區域展開/收起
  function toggleClickMonitor() {
    clickMonitorExpanded = !clickMonitorExpanded;
    
    if (clickMonitorToggle) {
      clickMonitorToggle.textContent = clickMonitorExpanded ? '▼' : '▶';
      clickMonitorToggle.classList.toggle('expanded', clickMonitorExpanded);
    }
    
    if (clickMonitorContent) {
      clickMonitorContent.style.display = clickMonitorExpanded ? 'block' : 'none';
    }
    
    if (clickMonitorExpanded) {
      loadClickMonitorRecords();
    }
    
    saveClickMonitorExpandedState();
  }

  // 載入點擊監聽記錄
  async function loadClickMonitorRecords() {
    try {
      if (!clickMonitorList) {
        console.error('[Side Panel] [點擊監聽記錄] 找不到 clickMonitorList 元素');
        return;
      }

      clickMonitorList.innerHTML = '<div class="empty-state">載入中...</div>';
      
      // 從 background.js 獲取記錄（同時也從 content.js 獲取最新的內存記錄）
      const userProfile = currentUserProfile || 'default';
      
      // 先從 background.js 獲取持久化記錄
      chrome.runtime.sendMessage({
        action: 'GET_CLICK_MONITOR_RECORDS',
        userProfile: userProfile
      }, (bgResponse) => {
        let persistentRecords = [];
        if (bgResponse && bgResponse.status === 'ok' && bgResponse.records) {
          persistentRecords = bgResponse.records || [];
        }
        
        // 再從 content.js 獲取最新的內存記錄（實時更新）
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length === 0 || !tabs[0].url || !tabs[0].url.includes('gemini.google.com')) {
            // 如果不在 Gemini 頁面，只顯示持久化記錄
            displayClickMonitorRecords(persistentRecords);
            if (clickMonitorCount) {
              clickMonitorCount.textContent = persistentRecords.length.toString();
            }
            if (clickMonitorLatestTime && persistentRecords.length > 0) {
              const latest = persistentRecords[persistentRecords.length - 1];
              clickMonitorLatestTime.textContent = latest.timestampDisplay || '-';
            }
            return;
          }

          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'GET_CLICK_MONITOR_RECORDS'
          }, (response) => {
            let memoryRecords = [];
            if (response && response.status === 'ok' && response.records) {
              memoryRecords = response.records || [];
            }
            
            // 合併記錄（去重，保留最新的）
            const recordMap = new Map();
            [...persistentRecords, ...memoryRecords].forEach(record => {
              const existing = recordMap.get(record.id);
              if (!existing || (record.timestamp > existing.timestamp)) {
                recordMap.set(record.id, record);
              }
            });
            
            const allRecords = Array.from(recordMap.values());
            displayClickMonitorRecords(allRecords);
            
            if (clickMonitorCount) {
              clickMonitorCount.textContent = allRecords.length.toString();
            }
            
            if (clickMonitorLatestTime && allRecords.length > 0) {
              const latest = allRecords[allRecords.length - 1];
              clickMonitorLatestTime.textContent = latest.timestampDisplay || '-';
            }
          });
        });
      });
    } catch (error) {
      console.error('[Side Panel] [點擊監聽記錄] 載入記錄時發生錯誤:', error);
      if (clickMonitorList) {
        clickMonitorList.innerHTML = '<div class="empty-state">載入失敗，請重試</div>';
      }
    }
  }

  // 顯示點擊監聽記錄
  function displayClickMonitorRecords(records) {
    if (!clickMonitorList) {
      console.error('[Side Panel] [點擊監聽記錄] 找不到 clickMonitorList 元素');
      return;
    }

    try {
      if (records.length === 0) {
        clickMonitorList.innerHTML = '<div class="empty-state">尚未有監聽記錄</div>';
        return;
      }

      // 按時間戳排序（最新的在前）
      const sortedRecords = [...records].sort((a, b) => {
        return (b.timestamp || 0) - (a.timestamp || 0);
      });

      let html = '';
      sortedRecords.forEach((record, index) => {
        const eventType = record.eventType || 'UNKNOWN';
        const timestamp = record.timestampDisplay || new Date(record.timestamp || Date.now()).toLocaleString('zh-TW');
        const data = record.data || {};
        
        // 根據事件類型選擇不同的圖標和顏色
        let eventIcon = '📝';
        let eventColor = '#64748b';
        if (eventType === 'BUTTON_CLICKED' || eventType === 'TEST_BUTTON_CLICKED') {
          eventIcon = '🖱️';
          eventColor = '#3b82f6';
        } else if (eventType === 'NETWORK_REQUEST_FETCH' || eventType === 'NETWORK_REQUEST_XHR') {
          eventIcon = '🌐';
          eventColor = '#10b981';
        } else if (eventType === 'URL_REDIRECT' || eventType === 'TRACK_REDIRECT') {
          eventIcon = '🔀';
          eventColor = '#f97316';
        } else if (eventType === 'URL_FOUND_IN_RESPONSE' || eventType === 'TRACK_URL_EXTRACTED' || eventType === 'TEST_URL_EXTRACTED') {
          eventIcon = '🔍';
          eventColor = '#14b8a6';
        } else if (eventType === 'DOWNLOAD_STARTED') {
          eventIcon = '⬇️';
          eventColor = '#f59e0b';
        } else if (eventType === 'BUTTON_STATE_CHANGED') {
          eventIcon = '🔄';
          eventColor = '#8b5cf6';
        } else if (eventType === 'DOM_CHANGED' || eventType === 'DOWNLOAD_TEXT_DETECTED') {
          eventIcon = '📄';
          eventColor = '#ec4899';
        } else if (eventType === 'MONITOR_ENDED' || eventType === 'TRACK_FINAL_URL' || eventType === 'TEST_TRACK_SUCCESS') {
          eventIcon = '✅';
          eventColor = '#22c55e';
        } else if (eventType.startsWith('TRACK_')) {
          eventIcon = '🔗';
          eventColor = '#06b6d4';
        } else if (eventType.startsWith('TEST_')) {
          eventIcon = '🧪';
          eventColor = '#a855f7';
        }
        
        html += `
          <div class="log-entry" style="border-left: 3px solid ${eventColor};">
            <div class="log-entry-header">
              <span class="log-entry-operation" style="color: ${eventColor};">
                ${eventIcon} ${eventType}
              </span>
              <span style="font-size: 0.75rem; color: #64748b;">${timestamp}</span>
            </div>
            <div class="log-entry-details">
              ${Object.entries(data).map(([key, value]) => {
                let displayValue = value;
                if (typeof value === 'object' && value !== null) {
                  displayValue = JSON.stringify(value, null, 2);
                } else if (typeof value === 'string' && value.length > 200) {
                  displayValue = value.substring(0, 200) + '...';
                }
                return `<div><strong>${escapeHtml(key)}:</strong> <pre style="margin: 0.25rem 0; font-size: 0.75rem; white-space: pre-wrap; word-break: break-all;">${escapeHtml(String(displayValue))}</pre></div>`;
              }).join('')}
            </div>
          </div>
        `;
      });

      clickMonitorList.innerHTML = html;
      console.log('[Side Panel] [點擊監聽記錄] ✓ 已顯示', records.length, '條記錄');
    } catch (error) {
      console.error('[Side Panel] [點擊監聽記錄] 顯示記錄時發生錯誤:', error);
      clickMonitorList.innerHTML = '<div class="empty-state">顯示失敗，請重試</div>';
    }
  }

  // 保存點擊監聽記錄區域展開狀態
  async function saveClickMonitorExpandedState() {
    try {
      const userProfile = currentUserProfile || 'default';
      const storageKey = `clickMonitorExpanded_${userProfile}`;
      await chrome.storage.local.set({ [storageKey]: clickMonitorExpanded });
    } catch (error) {
      console.error('[Side Panel] 保存點擊監聽記錄展開狀態時發生錯誤:', error);
    }
  }

  // 導出點擊監聽記錄
  async function exportClickMonitorRecords() {
    try {
      const userProfile = currentUserProfile || 'default';
      
      console.log('[Side Panel] [點擊監聽記錄] 開始導出記錄...');
      showToast('正在導出記錄...', 2000);
      
      // 從 background.js 導出記錄
      chrome.runtime.sendMessage({
        action: 'EXPORT_CLICK_MONITOR_RECORDS',
        userProfile: userProfile
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[Side Panel] [點擊監聽記錄] 導出失敗:', chrome.runtime.lastError.message);
          showToast('導出失敗: ' + chrome.runtime.lastError.message, 3000);
          return;
        }

        if (response && response.status === 'ok') {
          console.log('[Side Panel] [點擊監聽記錄] ✓ 記錄已導出:', response.filename);
          showToast(`記錄已導出 (${response.recordCount} 條)`, 3000);
        } else {
          console.error('[Side Panel] [點擊監聽記錄] 導出失敗:', response);
          showToast('導出失敗: ' + (response?.error || response?.message || '未知錯誤'), 3000);
        }
      });
    } catch (error) {
      console.error('[Side Panel] [點擊監聽記錄] 導出記錄時發生錯誤:', error);
      showToast('導出失敗: ' + error.message, 3000);
    }
  }

  // 載入點擊監聽記錄區域展開狀態
  async function loadClickMonitorExpandedState() {
    try {
      const userProfile = currentUserProfile || 'default';
      const storageKey = `clickMonitorExpanded_${userProfile}`;
      const result = await chrome.storage.local.get([storageKey]);
      const savedState = result[storageKey];
      
      if (savedState === true) {
        clickMonitorExpanded = true;
        if (clickMonitorToggle) {
          clickMonitorToggle.textContent = '▼';
          clickMonitorToggle.classList.add('expanded');
        }
        if (clickMonitorContent) {
          clickMonitorContent.style.display = 'block';
        }
        await loadClickMonitorRecords();
      }
    } catch (error) {
      console.error('[Side Panel] 載入點擊監聽記錄展開狀態時發生錯誤:', error);
    }
  }

  // ========== GAPI Server 配置功能 ==========

  // 切換 GAPI Server 配置區域展開/收起
  function toggleGapiServerSection() {
    gapiServerExpanded = !gapiServerExpanded;
    if (gapiServerContent) gapiServerContent.style.display = gapiServerExpanded ? 'block' : 'none';
    if (gapiServerToggle) gapiServerToggle.textContent = gapiServerExpanded ? '▼' : '▶';
    saveGapiServerExpandedState();
  }

  // 載入 GAPI Server 區域展開狀態
  async function loadGapiServerExpandedState() {
    try {
      const result = await chrome.storage.local.get(['gapiServerExpanded']);
      if (result.gapiServerExpanded === true) {
        gapiServerExpanded = true;
        if (gapiServerToggle) gapiServerToggle.textContent = '▼';
        if (gapiServerContent) gapiServerContent.style.display = 'block';
      }
    } catch (e) {
      console.error('[Side Panel] 載入 GAPI Server 展開狀態失敗:', e);
    }
  }

  // 保存 GAPI Server 區域展開狀態
  async function saveGapiServerExpandedState() {
    try {
      await chrome.storage.local.set({ gapiServerExpanded });
    } catch (e) {
      console.error('[Side Panel] 保存 GAPI Server 展開狀態失敗:', e);
    }
  }

  // 載入 GAPI Server 配置
  async function loadGapiServerConfig() {
    try {
      const result = await chrome.storage.local.get(['gapiServerHost']);
      const host = result.gapiServerHost || '';
      if (gapiServerHostInput) gapiServerHostInput.value = host;
      updateGapiServerConfigStatus(host ? `目前: ${host}` : '使用預設值 localhost:18799', 'info');
    } catch (e) {
      console.error('[Side Panel] 載入 GAPI Server 配置失敗:', e);
      updateGapiServerConfigStatus('載入失敗: ' + e.message, 'error');
    }
  }

  // 儲存 GAPI Server 配置
  async function saveGapiServerConfig() {
    const host = (gapiServerHostInput?.value || '').trim();
    if (!host) {
      // 清除自訂值，回到預設
      await chrome.storage.local.remove(['gapiServerHost']);
      updateGapiServerConfigStatus('已清除，使用預設值 localhost:18799', 'success');
      return;
    }
    try {
      await chrome.storage.local.set({ gapiServerHost: host });
      updateGapiServerConfigStatus(`已儲存: ${host}`, 'success');
    } catch (e) {
      updateGapiServerConfigStatus('儲存失敗: ' + e.message, 'error');
    }
  }

  // 測試 GAPI Server 連線
  async function testGapiServerConnection() {
    const host = (gapiServerHostInput?.value || '').trim() || 'localhost:18799';
    updateGapiServerConfigStatus('測試連線中...', 'info');
    if (gapiServerStatus) gapiServerStatus.style.background = '#94a3b8'; // grey
    try {
      const resp = await fetch(`http://${host}/status`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json();
        updateGapiServerConfigStatus(`連線成功 - ${data.connected_extensions ?? 0} 個連線`, 'success');
        if (gapiServerStatus) gapiServerStatus.style.background = '#22c55e'; // green
      } else {
        updateGapiServerConfigStatus(`連線失敗: HTTP ${resp.status}`, 'error');
        if (gapiServerStatus) gapiServerStatus.style.background = '#ef4444'; // red
      }
    } catch (e) {
      updateGapiServerConfigStatus('連線失敗: ' + e.message, 'error');
      if (gapiServerStatus) gapiServerStatus.style.background = '#ef4444'; // red
    }
  }

  // 更新 GAPI Server 配置狀態訊息
  function updateGapiServerConfigStatus(message, type = 'info') {
    if (!gapiServerConfigStatus) return;
    gapiServerConfigStatus.textContent = message;
    gapiServerConfigStatus.style.color =
      type === 'success' ? '#16a34a' :
      type === 'error' ? '#dc2626' :
      '#64748b';
  }

  // ========== R2 儲存功能 ==========

  // 切換 R2 儲存區域展開/收起
  function toggleR2Storage() {
    r2StorageExpanded = !r2StorageExpanded;
    
    if (r2StorageToggle) {
      if (r2StorageExpanded) {
        r2StorageToggle.classList.add('expanded');
        if (r2StorageContent) {
          r2StorageContent.style.display = 'block';
        }
      } else {
        r2StorageToggle.classList.remove('expanded');
        if (r2StorageContent) {
          r2StorageContent.style.display = 'none';
        }
      }
    }

    // 保存展開狀態
    saveR2StorageExpandedState();
  }

  // 載入 R2 儲存區域展開狀態
  async function loadR2StorageExpandedState() {
    try {
      const userProfile = currentUserProfile || 'default';
      const storageKey = `r2StorageExpanded_${userProfile}`;
      const result = await chrome.storage.local.get([storageKey]);
      const savedState = result[storageKey];
      
      if (savedState === true) {
        r2StorageExpanded = true;
        if (r2StorageToggle) {
          r2StorageToggle.classList.add('expanded');
        }
        if (r2StorageContent) {
          r2StorageContent.style.display = 'block';
        }
      }
    } catch (error) {
      console.error('[Side Panel] 載入 R2 儲存展開狀態失敗:', error);
    }
  }

  // 保存 R2 儲存區域展開狀態
  async function saveR2StorageExpandedState() {
    try {
      const userProfile = currentUserProfile || 'default';
      const storageKey = `r2StorageExpanded_${userProfile}`;
      await chrome.storage.local.set({ [storageKey]: r2StorageExpanded });
    } catch (error) {
      console.error('[Side Panel] 保存 R2 儲存展開狀態失敗:', error);
    }
  }

  // 載入 R2 配置
  async function loadR2Config() {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'R2_LOAD_CONFIG'
      });

      if (chrome.runtime.lastError) {
        console.error('[Side Panel] [R2] 載入配置失敗:', chrome.runtime.lastError.message);
        updateR2ConfigStatus('載入配置失敗: ' + chrome.runtime.lastError.message, 'error');
        return;
      }

      if (response && response.success && response.config) {
        const config = response.config;
        if (r2AccountId) r2AccountId.value = config.accountId || '';
        if (r2AccessKeyId) r2AccessKeyId.value = config.accessKeyId || '';
        if (r2SecretAccessKey) r2SecretAccessKey.value = config.secretAccessKey || '';
        if (r2Bucket) r2Bucket.value = config.bucket || '';
        if (r2Endpoint) r2Endpoint.value = config.endpoint || '';
        updateR2ConfigStatus('配置已載入', 'success');
      } else {
        updateR2ConfigStatus('尚未配置', 'info');
      }
    } catch (error) {
      console.error('[Side Panel] [R2] 載入配置時發生錯誤:', error);
      updateR2ConfigStatus('載入失敗: ' + error.message, 'error');
    }
  }

  // 保存 R2 配置
  async function saveR2Config() {
    try {
      const config = {
        accountId: r2AccountId?.value?.trim() || '',
        accessKeyId: r2AccessKeyId?.value?.trim() || '',
        secretAccessKey: r2SecretAccessKey?.value?.trim() || '',
        bucket: r2Bucket?.value?.trim() || '',
        endpoint: r2Endpoint?.value?.trim() || ''
      };

      if (!config.accountId || !config.accessKeyId || !config.secretAccessKey || !config.bucket) {
        updateR2ConfigStatus('請填寫所有必填欄位', 'error');
        showToast('請填寫所有必填欄位', 3000);
        return;
      }

      updateR2ConfigStatus('保存中...', 'info');
      
      const response = await chrome.runtime.sendMessage({
        action: 'R2_SAVE_CONFIG',
        config: config
      });

      if (chrome.runtime.lastError) {
        console.error('[Side Panel] [R2] 保存配置失敗:', chrome.runtime.lastError.message);
        updateR2ConfigStatus('保存失敗: ' + chrome.runtime.lastError.message, 'error');
        showToast('保存失敗', 3000);
        return;
      }

      if (response && response.success) {
        updateR2ConfigStatus('配置已保存', 'success');
        showToast('R2 配置已保存', 2000);
      } else {
        updateR2ConfigStatus('保存失敗: ' + (response?.error || '未知錯誤'), 'error');
        showToast('保存失敗', 3000);
      }
    } catch (error) {
      console.error('[Side Panel] [R2] 保存配置時發生錯誤:', error);
      updateR2ConfigStatus('保存失敗: ' + error.message, 'error');
      showToast('保存失敗', 3000);
    }
  }

  // 測試 R2 連接
  async function testR2Connection() {
    try {
      updateR2ConfigStatus('測試連接中...', 'info');
      
      const response = await chrome.runtime.sendMessage({
        action: 'R2_TEST_CONNECTION'
      });

      if (chrome.runtime.lastError) {
        console.error('[Side Panel] [R2] 測試連接失敗:', chrome.runtime.lastError.message);
        updateR2ConfigStatus('測試失敗: ' + chrome.runtime.lastError.message, 'error');
        showToast('測試連接失敗', 3000);
        return;
      }

      if (response && response.success) {
        updateR2ConfigStatus('連接成功 ✓', 'success');
        showToast('R2 連接成功', 2000);
      } else {
        updateR2ConfigStatus('連接失敗: ' + (response?.error || '未知錯誤'), 'error');
        showToast('連接失敗: ' + (response?.error || '未知錯誤'), 3000);
      }
    } catch (error) {
      console.error('[Side Panel] [R2] 測試連接時發生錯誤:', error);
      updateR2ConfigStatus('測試失敗: ' + error.message, 'error');
      showToast('測試連接失敗', 3000);
    }
  }

  // 更新 R2 配置狀態顯示
  function updateR2ConfigStatus(message, type = 'info') {
    if (!r2ConfigStatus) return;
    
    r2ConfigStatus.textContent = message;
    r2ConfigStatus.style.color = 
      type === 'success' ? '#166534' :
      type === 'error' ? '#991b1b' :
      '#64748b';
  }

  // 上傳當前對話到 R2
  async function uploadCurrentConversationToR2() {
    if (!currentChatId) {
      showToast('請先選擇一個對話', 3000);
      return;
    }

    try {
      updateR2Results('上傳中...', 'info');
      if (r2UploadCurrentBtn) r2UploadCurrentBtn.disabled = true;
      
      const response = await chrome.runtime.sendMessage({
        action: 'R2_UPLOAD_CONVERSATION',
        data: {
          chatId: currentChatId,
          userProfile: currentUserProfile || 'default'
        }
      });

      if (chrome.runtime.lastError) {
        console.error('[Side Panel] [R2] 上傳對話失敗:', chrome.runtime.lastError.message);
        updateR2Results('上傳失敗: ' + chrome.runtime.lastError.message, 'error');
        showToast('上傳失敗', 3000);
        return;
      }

      if (response && response.success) {
        updateR2Results(`✓ 對話已上傳: ${currentChatId}`, 'success');
        showToast('對話已上傳到 R2', 2000);
      } else {
        updateR2Results('上傳失敗: ' + (response?.error || '未知錯誤'), 'error');
        showToast('上傳失敗', 3000);
      }
    } catch (error) {
      console.error('[Side Panel] [R2] 上傳對話時發生錯誤:', error);
      updateR2Results('上傳失敗: ' + error.message, 'error');
      showToast('上傳失敗', 3000);
    } finally {
      if (r2UploadCurrentBtn) r2UploadCurrentBtn.disabled = false;
    }
  }

  // 上傳所有對話到 R2
  async function uploadAllConversationsToR2() {
    if (!confirm('確定要上傳所有對話到 R2 嗎？這可能需要一些時間。')) {
      return;
    }

    try {
      updateR2Results('批量上傳中，請稍候...', 'info');
      if (r2UploadAllBtn) r2UploadAllBtn.disabled = true;
      
      const response = await chrome.runtime.sendMessage({
        action: 'R2_UPLOAD_ALL',
        data: {
          userProfile: currentUserProfile || 'default'
        }
      });

      if (chrome.runtime.lastError) {
        console.error('[Side Panel] [R2] 批量上傳失敗:', chrome.runtime.lastError.message);
        updateR2Results('批量上傳失敗: ' + chrome.runtime.lastError.message, 'error');
        showToast('批量上傳失敗', 3000);
        return;
      }

      if (response && response.success && response.results) {
        const results = response.results;
        const message = `上傳完成: 成功 ${results.success}/${results.total}，失敗 ${results.failed}`;
        updateR2Results(message, results.failed === 0 ? 'success' : 'warning');
        showToast(message, 4000);
        
        if (results.errors && results.errors.length > 0) {
          const errorList = results.errors.map(e => `  - ${e.chatId}: ${e.error}`).join('\n');
          updateR2Results(message + '\n\n失敗的對話:\n' + errorList, 'error');
        }
      } else {
        updateR2Results('批量上傳失敗: ' + (response?.error || '未知錯誤'), 'error');
        showToast('批量上傳失敗', 3000);
      }
    } catch (error) {
      console.error('[Side Panel] [R2] 批量上傳時發生錯誤:', error);
      updateR2Results('批量上傳失敗: ' + error.message, 'error');
      showToast('批量上傳失敗', 3000);
    } finally {
      if (r2UploadAllBtn) r2UploadAllBtn.disabled = false;
    }
  }

  // 列出 R2 中的對話
  async function listR2Conversations() {
    try {
      updateR2Results('載入中...', 'info');
      if (r2ListBtn) r2ListBtn.disabled = true;
      
      const response = await chrome.runtime.sendMessage({
        action: 'R2_LIST_CONVERSATIONS',
        data: {
          userProfile: currentUserProfile || 'default'
        }
      });

      if (chrome.runtime.lastError) {
        console.error('[Side Panel] [R2] 列出對話失敗:', chrome.runtime.lastError.message);
        updateR2Results('列出失敗: ' + chrome.runtime.lastError.message, 'error');
        showToast('列出失敗', 3000);
        return;
      }

      if (response && response.success && response.conversations) {
        const conversations = response.conversations;
        if (conversations.length === 0) {
          updateR2Results('R2 中沒有對話', 'info');
        } else {
          const list = conversations.map(c => 
            `  - ${c.title || '未命名對話'} (${c.chatId})\n    消息數: ${c.messageCount || 0}, 更新時間: ${new Date(c.lastUpdated || 0).toLocaleString('zh-TW')}`
          ).join('\n');
          updateR2Results(`找到 ${conversations.length} 個對話:\n\n${list}`, 'success');
        }
        showToast(`找到 ${conversations.length} 個對話`, 2000);
      } else {
        updateR2Results('列出失敗: ' + (response?.error || '未知錯誤'), 'error');
        showToast('列出失敗', 3000);
      }
    } catch (error) {
      console.error('[Side Panel] [R2] 列出對話時發生錯誤:', error);
      updateR2Results('列出失敗: ' + error.message, 'error');
      showToast('列出失敗', 3000);
    } finally {
      if (r2ListBtn) r2ListBtn.disabled = false;
    }
  }

  // 從 R2 同步對話到本地
  async function syncConversationsFromR2() {
    if (!confirm('確定要從 R2 同步對話到本地嗎？這將覆蓋本地現有的對話數據。')) {
      return;
    }

    try {
      updateR2Results('同步中，請稍候...', 'info');
      if (r2SyncBtn) r2SyncBtn.disabled = true;
      
      const response = await chrome.runtime.sendMessage({
        action: 'R2_SYNC_FROM_R2',
        data: {
          userProfile: currentUserProfile || 'default'
        }
      });

      if (chrome.runtime.lastError) {
        console.error('[Side Panel] [R2] 同步失敗:', chrome.runtime.lastError.message);
        updateR2Results('同步失敗: ' + chrome.runtime.lastError.message, 'error');
        showToast('同步失敗', 3000);
        return;
      }

      if (response && response.success && response.results) {
        const results = response.results;
        const message = `同步完成: 成功 ${results.success}/${results.total}，失敗 ${results.failed}`;
        updateR2Results(message, results.failed === 0 ? 'success' : 'warning');
        showToast(message, 4000);
        
        // 刷新對話列表
        await loadData();
        updateCategoriesList();
        
        if (results.errors && results.errors.length > 0) {
          const errorList = results.errors.map(e => `  - ${e.chatId}: ${e.error}`).join('\n');
          updateR2Results(message + '\n\n失敗的對話:\n' + errorList, 'error');
        }
      } else {
        updateR2Results('同步失敗: ' + (response?.error || '未知錯誤'), 'error');
        showToast('同步失敗', 3000);
      }
    } catch (error) {
      console.error('[Side Panel] [R2] 同步時發生錯誤:', error);
      updateR2Results('同步失敗: ' + error.message, 'error');
      showToast('同步失敗', 3000);
    } finally {
      if (r2SyncBtn) r2SyncBtn.disabled = false;
    }
  }

  // 更新 R2 操作結果顯示
  function updateR2Results(message, type = 'info') {
    if (!r2ResultsList) return;
    
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    logEntry.style.cssText = `
      background: ${type === 'success' ? '#dcfce7' : type === 'error' ? '#fee2e2' : '#f1f5f9'};
      color: ${type === 'success' ? '#166534' : type === 'error' ? '#991b1b' : '#475569'};
      padding: 0.75rem;
      border-radius: 0.375rem;
      margin-bottom: 0.5rem;
      font-size: 0.75rem;
      white-space: pre-wrap;
      word-break: break-word;
    `;
    logEntry.textContent = `[${new Date().toLocaleTimeString('zh-TW')}] ${message}`;
    
    r2ResultsList.insertBefore(logEntry, r2ResultsList.firstChild);
    
    // 只保留最近 20 條記錄
    while (r2ResultsList.children.length > 20) {
      r2ResultsList.removeChild(r2ResultsList.lastChild);
    }
  }
});

