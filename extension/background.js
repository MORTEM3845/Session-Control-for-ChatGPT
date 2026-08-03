const CHATGPT_URL_PATTERNS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];
const ACTIVE_STATUSES = new Set(["submitted", "thinking", "using_tools", "streaming"]);
const DEFAULT_SETTINGS = {
  notifications: true,
  notifyOnErrors: true,
  includeSnippets: false,
  autoMarkRead: true
};

let storePromise;
let mutationQueue = Promise.resolve();

function isChatGptUrl(url = "") {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(url);
}

function getAliasKey(session) {
  if (session.conversationId)
    return `conversation:${session.conversationId}`;

  try {
    const url = new URL(session.url);
    return `url:${url.origin}${url.pathname}`;
  } catch {
    return `tab:${session.tabId}`;
  }
}

async function queryChatTabs(query = {}) {
  return chrome.tabs.query({ url: CHATGPT_URL_PATTERNS, ...query });
}

async function getStore() {
  if (!storePromise) {
    storePromise = chrome.storage.local.get("appState").then(result => {
      const state = result.appState || {};
      return {
        sessions: state.sessions || {},
        aliases: state.aliases || {},
        settings: { ...DEFAULT_SETTINGS, ...(state.settings || {}) }
      };
    });
  }

  return storePromise;
}

function mutateStore(mutator, options = {}) {
  mutationQueue = mutationQueue.then(async () => {
    const store = await getStore();
    await mutator(store);
    await chrome.storage.local.set({ appState: store });
    await updateBadge(store);

    if (options.broadcast !== false)
      broadcastChange();

    return store;
  }).catch(error => console.error("Session Control for ChatGPT:", error));

  return mutationQueue;
}

async function updateBadge(store) {
  const sessions = Object.values(store.sessions);
  const unread = sessions.filter(session => session.unread).length;
  const running = sessions.filter(session => ACTIVE_STATUSES.has(session.status)).length;

  await chrome.action.setBadgeText({ text: unread ? String(unread) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: unread ? "#dc2626" : "#2563eb" });
  await chrome.action.setTitle({
    title: unread
      ? `Session Control: непрочитанных ответов — ${unread}`
      : running
        ? `Session Control: выполняется задач — ${running}`
        : "Открыть Session Control for ChatGPT"
  });
}

function broadcastChange() {
  chrome.runtime.sendMessage({ type: "SESSIONS_CHANGED" }).catch(() => {});
}

async function broadcastCaptureSettings(includeSnippets) {
  const tabs = await queryChatTabs();
  await Promise.allSettled(tabs.filter(tab => tab.id != null).map(tab =>
    chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_SETTINGS_CHANGED", includeSnippets })));
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch {
    // Выгруженная или ещё не загрузившаяся вкладка может временно не принимать скрипт.
  }
}

async function requestTabState(tabId) {
  try {
    const state = await chrome.tabs.sendMessage(tabId, { type: "GET_STATE" });
    if (state)
      await processStateUpdate(tabId, state);
  } catch {
    await injectContentScript(tabId);
  }
}

async function syncOpenTabs(requestStates = true, shouldBroadcast = true) {
  const chatTabs = (await queryChatTabs()).filter(tab => tab.id != null);
  const activeIds = new Set(chatTabs.map(tab => String(tab.id)));

  await mutateStore(store => {
    for (const tabId of Object.keys(store.sessions)) {
      if (!activeIds.has(tabId))
        delete store.sessions[tabId];
    }
  }, { broadcast: false });

  if (requestStates) {
    for (const tab of chatTabs) {
      await injectContentScript(tab.id);
      setTimeout(() => requestTabState(tab.id), 150);
    }
  }

  if (shouldBroadcast)
    broadcastChange();

  return chatTabs;
}

function sanitizePayload(payload, includeSnippets) {
  return {
    ...payload,
    lastUserText: includeSnippets ? String(payload.lastUserText || "").slice(0, 400) : "",
    lastAssistantText: includeSnippets ? String(payload.lastAssistantText || "").slice(-600) : ""
  };
}

async function processStateUpdate(tabId, rawPayload, tabInfo = null) {
  const tab = tabInfo || await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !isChatGptUrl(rawPayload.url || tab.url || ""))
    return;

  let notification = null;

  await mutateStore(store => {
    const payload = sanitizePayload(rawPayload, store.settings.includeSnippets);
    const key = String(tabId);
    const isNewSession = !store.sessions[key];
    const previous = store.sessions[key] || {};
    const now = Date.now();
    const previousActive = ACTIVE_STATUSES.has(previous.status);
    const currentActive = ACTIVE_STATUSES.has(payload.status);
    const aliasKey = getAliasKey({ ...previous, ...payload, tabId });
    const preservedAlias = previous.alias || store.aliases[aliasKey] || "";

    let startedAt = previous.startedAt || null;
    let completedAt = previous.completedAt || null;
    let unread = Boolean(previous.unread);
    let completionId = previous.completionId || null;

    if (currentActive && !previousActive) {
      startedAt = now;
      completedAt = null;
      completionId = null;
      unread = false;
    }

    const becameCompleted = !isNewSession && payload.status === "completed" && previous.status !== "completed";
    const becameFailed = !isNewSession && payload.status === "failed" && previous.status !== "failed";

    if (becameCompleted) {
      completedAt = now;
      completionId = `${tabId}-${now}`;
      unread = !(payload.focused && payload.atBottom);

      if (unread && store.settings.notifications) {
        notification = {
          id: `chat:${tabId}:${now}`,
          title: preservedAlias || payload.title || "ChatGPT завершил задачу",
          message: store.settings.includeSnippets && payload.lastAssistantText
            ? payload.lastAssistantText.slice(-220)
            : "Ответ готов. Нажмите, чтобы открыть чат.",
          tabId
        };
      }
    } else if (becameFailed) {
      unread = !payload.focused;
      if (store.settings.notifications && store.settings.notifyOnErrors) {
        notification = {
          id: `error:${tabId}:${now}`,
          title: preservedAlias || payload.title || "Ошибка ChatGPT",
          message: "Во время выполнения возникла ошибка. Откройте чат для повторной попытки.",
          tabId
        };
      }
    } else if (store.settings.autoMarkRead && payload.status === "completed" && payload.focused && payload.atBottom) {
      unread = false;
    }

    const session = {
      ...previous,
      ...payload,
      tabId,
      windowId: tab.windowId,
      browserTitle: tab.title || payload.title || "ChatGPT",
      alias: preservedAlias,
      startedAt,
      completedAt,
      durationMs: completedAt && startedAt ? Math.max(0, completedAt - startedAt) : null,
      unread,
      completionId,
      lastSeenAt: now
    };

    const newAliasKey = getAliasKey(session);
    if (session.alias)
      store.aliases[newAliasKey] = session.alias;

    store.sessions[key] = session;
  });

  if (notification)
    await showNotification(notification);
}

async function showNotification(notification) {
  try {
    await chrome.notifications.create(notification.id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: notification.title.slice(0, 120),
      message: notification.message.replace(/\s+/g, " ").trim().slice(0, 260),
      priority: 1
    });
  } catch (error) {
    console.warn("Не удалось показать уведомление:", error);
  }
}

async function focusTab(tabId, scrollToEnd = false) {
  const tab = await chrome.tabs.get(Number(tabId));
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });

  if (scrollToEnd) {
    setTimeout(() => {
      chrome.tabs.sendMessage(tab.id, { type: "SCROLL_TO_END" }).catch(() => {});
    }, 250);
  }

  await mutateStore(store => {
    const session = store.sessions[String(tab.id)];
    if (session && session.status === "completed")
      session.unread = false;
  });
}

async function groupChatTabs() {
  const chatTabs = (await queryChatTabs()).filter(tab => tab.id != null);
  const byWindow = chatTabs.reduce((map, tab) => {
    if (!map.has(tab.windowId))
      map.set(tab.windowId, []);
    map.get(tab.windowId).push(tab);
    return map;
  }, new Map());

  for (const [windowId, windowTabs] of byWindow) {
    if (!windowTabs.length)
      continue;

    const groupId = await chrome.tabs.group({ tabIds: windowTabs.map(tab => tab.id), createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title: "ChatGPT Work", color: "blue", collapsed: false });
  }

  return chatTabs.length;
}

async function findDuplicates() {
  const store = await getStore();
  const sessions = Object.values(store.sessions).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  const seen = new Set();
  const duplicates = [];

  for (const session of sessions) {
    if (!session.conversationId)
      continue;

    if (seen.has(session.conversationId)) {
      duplicates.push({
        tabId: session.tabId,
        title: session.alias || session.title || session.browserTitle || "ChatGPT",
        conversationId: session.conversationId
      });
    } else {
      seen.add(session.conversationId);
    }
  }

  return duplicates;
}

async function closeDuplicates(requestedIds) {
  const duplicates = await findDuplicates();
  const allowed = new Set(duplicates.map(item => Number(item.tabId)));
  const ids = [...new Set((requestedIds || []).map(Number))].filter(id => allowed.has(id));

  if (ids.length)
    await chrome.tabs.remove(ids);

  return ids.length;
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "STATE_UPDATE":
      if (sender.tab?.id != null)
        await processStateUpdate(sender.tab.id, message.payload, sender.tab);
      return { ok: true };

    case "GET_CAPTURE_SETTINGS": {
      const store = await getStore();
      return { includeSnippets: store.settings.includeSnippets };
    }

    case "GET_SESSIONS": {
      await syncOpenTabs(false, false);
      const store = await getStore();
      return { sessions: Object.values(store.sessions), settings: store.settings };
    }

    case "FOCUS_SESSION":
      await focusTab(message.tabId, Boolean(message.scrollToEnd));
      return { ok: true };

    case "RENAME_SESSION":
      await mutateStore(store => {
        const session = store.sessions[String(message.tabId)];
        if (!session)
          return;

        const alias = String(message.alias || "").trim().slice(0, 160);
        const aliasKey = getAliasKey(session);
        session.alias = alias;
        if (alias)
          store.aliases[aliasKey] = alias;
        else
          delete store.aliases[aliasKey];
      });
      return { ok: true };

    case "MARK_READ":
      await mutateStore(store => {
        const session = store.sessions[String(message.tabId)];
        if (session)
          session.unread = false;
      });
      return { ok: true };

    case "CLOSE_TAB":
      await chrome.tabs.remove(Number(message.tabId));
      return { ok: true };

    case "GROUP_TABS":
      return { ok: true, count: await groupChatTabs() };

    case "PREVIEW_DUPLICATES":
      return { ok: true, duplicates: await findDuplicates() };

    case "CLOSE_DUPLICATES":
      return { ok: true, count: await closeDuplicates(message.tabIds) };

    case "REFRESH_ALL":
      await syncOpenTabs(true);
      return { ok: true };

    case "UPDATE_SETTINGS": {
      const nextSettings = message.settings || {};
      await mutateStore(store => {
        store.settings = { ...store.settings, ...nextSettings };
        if (nextSettings.includeSnippets === false) {
          for (const session of Object.values(store.sessions)) {
            session.lastUserText = "";
            session.lastAssistantText = "";
          }
        }
      });

      if (Object.hasOwn(nextSettings, "includeSnippets"))
        await broadcastCaptureSettings(Boolean(nextSettings.includeSnippets));

      return { ok: true };
    }

    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(error => {
    console.error(error);
    sendResponse({ ok: false, error: String(error?.message || error) });
  });
  return true;
});

chrome.runtime.onInstalled.addListener(async details => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await mutateStore(store => {
    store.settings = { ...DEFAULT_SETTINGS, ...store.settings };
    if (details.reason === "update" && details.previousVersion === "0.1.0")
      store.settings.includeSnippets = false;
    if (!store.settings.includeSnippets) {
      for (const session of Object.values(store.sessions)) {
        session.lastUserText = "";
        session.lastAssistantText = "";
      }
    }
  });
  await syncOpenTabs(true);
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await syncOpenTabs(true);
});

chrome.tabs.onRemoved.addListener(tabId => {
  mutateStore(store => {
    delete store.sessions[String(tabId)];
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url || "";
  if (isChatGptUrl(url) && (changeInfo.status === "complete" || changeInfo.url)) {
    setTimeout(async () => {
      await injectContentScript(tabId);
      await requestTabState(tabId);
    }, 300);
  } else if (changeInfo.url && !isChatGptUrl(changeInfo.url)) {
    mutateStore(store => {
      delete store.sessions[String(tabId)];
    });
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  setTimeout(() => requestTabState(tabId), 250);
});

chrome.windows.onFocusChanged.addListener(async windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE)
    return;

  const [tab] = await chrome.tabs.query({ active: true, windowId, url: CHATGPT_URL_PATTERNS });
  if (tab?.id != null)
    requestTabState(tab.id);
});

chrome.notifications.onClicked.addListener(async notificationId => {
  const match = notificationId.match(/^(?:chat|error):(\d+):/);
  if (!match)
    return;

  await focusTab(Number(match[1]), true).catch(() => {});
  await chrome.notifications.clear(notificationId);
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== "open-next-unread")
    return;

  const store = await getStore();
  const next = Object.values(store.sessions)
    .filter(session => session.unread)
    .sort((a, b) => (a.completedAt || a.lastSeenAt) - (b.completedAt || b.lastSeenAt))[0];

  if (next)
    await focusTab(next.tabId, true);
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
syncOpenTabs(true).catch(() => {});
