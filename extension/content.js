(() => {
  if (globalThis.__sessionControlForChatGptLoaded)
    return;

  globalThis.__sessionControlForChatGptLoaded = true;

  const ACTIVE_STATUSES = new Set(["submitted", "thinking", "using_tools", "streaming"]);
  const TOOL_PATTERNS = [
    /searching the web/i, /browsing/i, /analyzing/i, /reading files?/i, /running code/i,
    /generating image/i, /working/i, /поиск в сети/i, /ищу в сети/i, /анализир/i,
    /читаю файл/i, /выполняю код/i, /создаю изображение/i, /работаю/i
  ];
  const ERROR_PATTERNS = [
    /something went wrong/i, /network error/i, /connection lost/i, /failed to load/i,
    /try again/i, /произошла ошибка/i, /ошибка сети/i, /соединение потеряно/i,
    /повторить попытку/i, /не удалось загрузить/i
  ];
  const STOP_PATTERNS = [
    /stop generating/i, /^stop$/i, /stop response/i, /остановить генерацию/i,
    /^остановить$/i, /прервать ответ/i
  ];

  let previousAssistantText = "";
  let assistantChangedAt = Date.now();
  let submittedAt = 0;
  let lastUrl = location.href;
  let sendTimer = 0;
  let heartbeatTimer = 0;
  let lastSentSignature = "";
  let captureSnippets = false;
  let observedMain = null;
  let cachedModel = null;
  let modelDetectedAt = 0;
  let cachedContext = { tokens: 0, level: "fresh", chars: 0 };
  let contextEstimatedAt = 0;
  let estimatedMessageCount = -1;

  function textOf(element) {
    return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(element) {
    if (!element)
      return false;

    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)
      return false;

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getMessages() {
    const direct = [...document.querySelectorAll("[data-message-author-role]")];
    if (direct.length)
      return direct;

    return [...document.querySelectorAll("main article")].map(element => {
      const label = `${element.getAttribute("aria-label") || ""} ${textOf(element).slice(0, 120)}`;
      let role = "unknown";
      if (/you said|user|вы сказали|пользователь/i.test(label))
        role = "user";
      else if (/chatgpt said|assistant|chatgpt ответил|ассистент/i.test(label))
        role = "assistant";

      return { element, role };
    });
  }

  function getMessageRole(message) {
    return message?.getAttribute?.("data-message-author-role") || message?.role || "unknown";
  }

  function getMessageElement(message) {
    return message?.element || message;
  }

  function getConversationId() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/i);
    if (match)
      return match[1];

    const shareMatch = location.pathname.match(/\/share\/([^/?#]+)/i);
    return shareMatch ? `share:${shareMatch[1]}` : null;
  }

  function getChatTitle() {
    const selected = document.querySelector('nav a[aria-current="page"], aside a[aria-current="page"]');
    const selectedTitle = selected?.getAttribute("title") || textOf(selected);
    if (selectedTitle && !/^chatgpt$/i.test(selectedTitle))
      return selectedTitle.slice(0, 160);

    return document.title
      .replace(/\s*[|–—-]\s*ChatGPT\s*$/i, "")
      .replace(/^ChatGPT\s*[|–—-]\s*/i, "")
      .trim() || "Новый чат";
  }

  function getButtonLabel(button) {
    return `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${textOf(button)}`.trim();
  }

  function findStopButton() {
    const preferred = document.querySelectorAll(
      'button[data-testid*="stop" i], button[aria-label*="stop" i], button[aria-label*="останов" i]'
    );

    for (const button of preferred) {
      if (isVisible(button))
        return button;
    }

    for (const button of document.querySelectorAll("main button")) {
      if (isVisible(button) && STOP_PATTERNS.some(pattern => pattern.test(getButtonLabel(button))))
        return button;
    }

    return null;
  }

  function getLiveText() {
    const elements = document.querySelectorAll(
      'main [aria-live="polite"], main [aria-live="assertive"], main [role="status"], main [role="alert"]'
    );
    return [...elements].filter(isVisible).map(textOf).filter(Boolean).join(" ").slice(-3000);
  }

  function detectError(liveText) {
    if (ERROR_PATTERNS.some(pattern => pattern.test(liveText)))
      return true;

    for (const button of document.querySelectorAll("main button")) {
      if (!isVisible(button))
        continue;

      if (/^(retry|try again|повторить|повторить попытку)$/i.test(getButtonLabel(button)))
        return true;
    }

    return false;
  }

  function detectToolStage(lastAssistantText, liveText) {
    const combined = `${lastAssistantText.slice(-1500)} ${liveText}`;
    if (!TOOL_PATTERNS.some(pattern => pattern.test(combined)))
      return null;

    const statusElement = [...document.querySelectorAll('main [aria-live="polite"], main [role="status"]')]
      .filter(isVisible)
      .map(textOf)
      .find(value => TOOL_PATTERNS.some(pattern => pattern.test(value)));

    return (statusElement || "Использует инструмент").slice(0, 120);
  }

  function detectModel() {
    if (Date.now() - modelDetectedAt < 20000)
      return cachedModel;

    const selectors = [
      'button[data-testid*="model" i]',
      'button[aria-label*="model" i]',
      'button[aria-label*="модел" i]',
      'header button'
    ];

    const candidates = [];
    for (const selector of selectors) {
      for (const button of document.querySelectorAll(selector)) {
        if (!isVisible(button))
          continue;

        const value = getButtonLabel(button).replace(/\s+/g, " ").trim();
        if (value && value.length <= 100)
          candidates.push(value);
      }
    }

    const modelPattern = /(?:GPT[-\s]?\d|GPT|o\d(?:[-\w.]*)?|Instant|Thinking|Pro|Auto|Reasoning|Быстр|Размыш|Авто)/i;
    const candidate = candidates.find(value => modelPattern.test(value));
    cachedModel = candidate
      ? candidate.replace(/^(model selector|выбор модели)\s*/i, "")
        .replace(/^(model|модель)\s*[:：-]?\s*/i, "").trim().slice(0, 80)
      : null;
    modelDetectedAt = Date.now();
    return cachedModel;
  }

  function estimateTokens(messages) {
    const minInterval = document.visibilityState === "visible" ? 15000 : 60000;
    const countChanged = estimatedMessageCount !== messages.length;
    if (!countChanged && Date.now() - contextEstimatedAt < minInterval)
      return cachedContext;

    let text = "";
    for (const message of messages)
      text += `${textOf(getMessageElement(message))}\n`;

    const trimmed = text.trim();
    if (!trimmed) {
      cachedContext = { tokens: 0, level: "fresh", chars: 0 };
    } else {
      const cyrillic = (trimmed.match(/[А-Яа-яЁё]/g) || []).length;
      const divisor = cyrillic / trimmed.length > 0.25 ? 3.1 : 3.8;
      const tokens = Math.ceil(trimmed.length / divisor);
      let level = "fresh";
      if (tokens >= 80000)
        level = "critical";
      else if (tokens >= 40000)
        level = "heavy";
      else if (tokens >= 15000)
        level = "medium";

      cachedContext = { tokens, level, chars: trimmed.length };
    }

    estimatedMessageCount = messages.length;
    contextEstimatedAt = Date.now();
    return cachedContext;
  }

  function isNearBottom() {
    const root = document.scrollingElement || document.documentElement;
    return root.scrollHeight - root.scrollTop - root.clientHeight < 220;
  }

  function collectState() {
    const messages = getMessages();
    const lastMessage = messages.at(-1);
    const lastRole = getMessageRole(lastMessage);
    const assistants = messages.filter(message => getMessageRole(message) === "assistant");
    const users = messages.filter(message => getMessageRole(message) === "user");
    const lastAssistantText = textOf(getMessageElement(assistants.at(-1)));
    const lastUserText = textOf(getMessageElement(users.at(-1)));
    const liveText = getLiveText();
    const stopButton = findStopButton();
    const toolStage = detectToolStage(lastAssistantText, liveText);

    if (lastAssistantText !== previousAssistantText) {
      previousAssistantText = lastAssistantText;
      assistantChangedAt = Date.now();
    }

    if (lastRole === "user") {
      if (!submittedAt)
        submittedAt = Date.now();
    } else {
      submittedAt = 0;
    }

    let status = "new";
    let stage = "Новый чат";

    if (detectError(liveText)) {
      status = "failed";
      stage = "Ошибка ответа";
    } else if (stopButton) {
      if (toolStage) {
        status = "using_tools";
        stage = toolStage;
      } else if (lastAssistantText && Date.now() - assistantChangedAt < 3000) {
        status = "streaming";
        stage = "Формирует ответ";
      } else {
        status = "thinking";
        stage = "Размышляет";
      }
    } else if (lastRole === "assistant") {
      status = "completed";
      stage = "Ответ готов";
    } else if (lastRole === "user") {
      const delay = submittedAt ? Date.now() - submittedAt : 0;
      status = delay > 15000 ? "stalled" : "submitted";
      stage = delay > 15000 ? "Сообщение отправлено, активности нет" : "Запрос отправлен";
    }

    const context = estimateTokens(messages);
    const focused = document.visibilityState === "visible" && document.hasFocus();

    return {
      conversationId: getConversationId(),
      url: location.href,
      title: getChatTitle(),
      status,
      stage,
      model: detectModel(),
      lastUserText: captureSnippets ? lastUserText.slice(0, 400) : "",
      lastAssistantText: captureSnippets ? lastAssistantText.slice(-600) : "",
      messageCount: messages.length,
      estimatedTokens: context.tokens,
      contextLevel: context.level,
      visibleChars: context.chars,
      visible: document.visibilityState === "visible",
      focused,
      atBottom: isNearBottom(),
      updatedAt: Date.now(),
      active: ACTIVE_STATUSES.has(status)
    };
  }

  function heartbeatDelay(state) {
    if (ACTIVE_STATUSES.has(state.status))
      return document.visibilityState === "visible" ? 5000 : 10000;

    return document.visibilityState === "visible" ? 15000 : 30000;
  }

  function scheduleHeartbeat(state) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(async () => {
      attachMainObserver();
      const next = await sendState(true);
      scheduleHeartbeat(next);
    }, heartbeatDelay(state));
  }

  async function sendState(force = false) {
    if (!chrome.runtime?.id)
      return collectState();

    const state = collectState();
    const signature = JSON.stringify({
      conversationId: state.conversationId,
      title: state.title,
      status: state.status,
      stage: state.stage,
      model: state.model,
      lastUserText: state.lastUserText,
      lastAssistantText: state.lastAssistantText,
      messageCount: state.messageCount,
      estimatedTokens: state.estimatedTokens,
      visible: state.visible,
      focused: state.focused,
      atBottom: state.atBottom,
      url: state.url
    });

    if (!force && signature === lastSentSignature)
      return state;

    lastSentSignature = signature;
    await chrome.runtime.sendMessage({ type: "STATE_UPDATE", payload: state }).catch(() => {});
    return state;
  }

  function scheduleSend(delay = document.visibilityState === "visible" ? 700 : 2500) {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(async () => {
      const state = await sendState();
      scheduleHeartbeat(state);
    }, delay);
  }

  const mainObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      submittedAt = 0;
      lastSentSignature = "";
      cachedModel = null;
      modelDetectedAt = 0;
      estimatedMessageCount = -1;
    }
    scheduleSend();
  });

  function attachMainObserver() {
    const main = document.querySelector("main");
    if (!main || main === observedMain)
      return;

    mainObserver.disconnect();
    observedMain = main;
    mainObserver.observe(main, { childList: true, subtree: true, characterData: true });
    scheduleSend(100);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_STATE") {
      sendResponse(collectState());
      return false;
    }

    if (message?.type === "SCROLL_TO_END") {
      const messages = getMessages();
      const lastMessage = getMessageElement(messages.at(-1));
      if (lastMessage)
        lastMessage.scrollIntoView({ behavior: "smooth", block: "end" });
      else
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
      setTimeout(() => sendState(true), 500);
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "CAPTURE_SETTINGS_CHANGED") {
      captureSnippets = Boolean(message.includeSnippets);
      lastSentSignature = "";
      scheduleSend(50);
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  for (const eventName of ["focus", "blur", "visibilitychange"]) {
    const target = eventName === "visibilitychange" ? document : window;
    target.addEventListener(eventName, () => scheduleSend(100), { passive: true });
  }

  window.addEventListener("scroll", () => scheduleSend(500), { passive: true });

  async function initialize() {
    const settings = await chrome.runtime.sendMessage({ type: "GET_CAPTURE_SETTINGS" }).catch(() => null);
    captureSnippets = Boolean(settings?.includeSnippets);
    attachMainObserver();
    const state = await sendState(true);
    scheduleHeartbeat(state);
  }

  initialize();
})();
