const ACTIVE_STATUSES = new Set(["submitted", "thinking", "using_tools", "streaming"]);
const STATUS_RANK = {
  failed: 0,
  using_tools: 1,
  thinking: 2,
  streaming: 3,
  submitted: 4,
  stalled: 5,
  completed: 6,
  new: 7
};

const elements = {
  stats: document.querySelector("#stats"),
  sessionList: document.querySelector("#sessionList"),
  emptyState: document.querySelector("#emptyState"),
  searchInput: document.querySelector("#searchInput"),
  filters: document.querySelector("#filters"),
  refreshButton: document.querySelector("#refreshButton"),
  groupTabsButton: document.querySelector("#groupTabsButton"),
  closeDuplicatesButton: document.querySelector("#closeDuplicatesButton"),
  openChatGptButton: document.querySelector("#openChatGptButton"),
  notificationsToggle: document.querySelector("#notificationsToggle"),
  snippetsToggle: document.querySelector("#snippetsToggle"),
  toast: document.querySelector("#toast")
};

let sessions = [];
let settings = {};
let currentFilter = "all";
let toastTimer = 0;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character]);
}

function formatDuration(milliseconds) {
  if (milliseconds == null || Number.isNaN(milliseconds))
    return "";

  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;

  if (hours)
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatTokens(tokens) {
  const value = Number(tokens) || 0;
  if (value >= 1000000)
    return `≈${(value / 1000000).toFixed(1)}M токенов`;
  if (value >= 1000)
    return `≈${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K токенов`;
  return `≈${value} токенов`;
}

function contextLabel(level) {
  return ({ fresh: "свежий", medium: "средний", heavy: "тяжёлый", critical: "критический" })[level] || "оценка";
}

function getStatusPresentation(session) {
  if (session.unread)
    return { label: "Ответ готов · не прочитано", className: "unread", dot: "unread" };

  switch (session.status) {
    case "using_tools": return { label: session.stage || "Использует инструмент", className: "running", dot: "running" };
    case "thinking": return { label: session.stage || "Размышляет", className: "running", dot: "running" };
    case "streaming": return { label: session.stage || "Формирует ответ", className: "running", dot: "running" };
    case "submitted": return { label: "Запрос отправлен", className: "running", dot: "running" };
    case "stalled": return { label: "Нет активности после отправки", className: "stalled", dot: "stalled" };
    case "failed": return { label: "Ошибка", className: "failed", dot: "failed" };
    case "completed": return { label: "Ждёт вашего сообщения", className: "completed", dot: "completed" };
    default: return { label: "Новый чат", className: "idle", dot: "idle" };
  }
}

function matchesFilter(session) {
  switch (currentFilter) {
    case "running": return ACTIVE_STATUSES.has(session.status);
    case "unread": return session.unread;
    case "waiting": return session.status === "completed" && !session.unread;
    case "failed": return session.status === "failed" || session.status === "stalled";
    default: return true;
  }
}

function getFilteredSessions() {
  const query = elements.searchInput.value.trim().toLocaleLowerCase("ru");
  return sessions.filter(session => {
    if (!matchesFilter(session))
      return false;

    if (!query)
      return true;

    const haystack = [session.alias, session.title, session.browserTitle, session.lastUserText, session.lastAssistantText, session.model]
      .filter(Boolean).join(" ").toLocaleLowerCase("ru");
    return haystack.includes(query);
  }).sort((a, b) => {
    if (a.unread !== b.unread)
      return a.unread ? -1 : 1;

    const rankDifference = (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99);
    if (rankDifference)
      return rankDifference;

    return (b.updatedAt || b.lastSeenAt || 0) - (a.updatedAt || a.lastSeenAt || 0);
  });
}

function renderStats() {
  const running = sessions.filter(session => ACTIVE_STATUSES.has(session.status)).length;
  const unread = sessions.filter(session => session.unread).length;
  elements.stats.innerHTML = `
    <div class="stat"><strong>${sessions.length}</strong><span>вкладок</span></div>
    <div class="stat running"><strong>${running}</strong><span>в работе</span></div>
    <div class="stat unread"><strong>${unread}</strong><span>не прочитано</span></div>`;
}

function renderCard(session) {
  const title = session.alias || session.title || session.browserTitle || "ChatGPT";
  const originalTitle = session.alias && session.title && session.alias !== session.title ? session.title : "";
  const status = getStatusPresentation(session);
  const active = ACTIVE_STATUSES.has(session.status);
  const duration = active && session.startedAt ? Date.now() - session.startedAt : session.durationMs;
  const snippet = session.status === "completed" || session.unread ? session.lastAssistantText : session.lastUserText;
  const snippetLabel = session.status === "completed" || session.unread ? "Ответ" : "Запрос";
  const cardClasses = ["session-card"];
  if (session.unread)
    cardClasses.push("unread");
  else if (active)
    cardClasses.push("running");
  else if (session.status === "failed")
    cardClasses.push("failed");

  return `
    <article class="${cardClasses.join(" ")}" data-tab-id="${session.tabId}">
      <div class="card-head">
        <span class="status-dot ${status.dot}"></span>
        <div class="title-area">
          <div class="title-view">
            <div class="title-row">
              <button class="chat-title" data-action="open" title="Открыть чат">${escapeHtml(title)}</button>
              <button class="rename-button" data-action="edit" title="Изменить локальное название">✎</button>
            </div>
            ${originalTitle ? `<div class="original-title">ChatGPT: ${escapeHtml(originalTitle)}</div>` : ""}
          </div>
          <div class="title-editor" hidden>
            <input type="text" maxlength="160" value="${escapeHtml(session.alias || "")}" placeholder="Локальное название чата">
            <button data-action="save-name">OK</button>
          </div>
        </div>
      </div>

      <div class="status-label ${status.className}">
        ${escapeHtml(status.label)}
        ${duration != null ? `<span class="timer" data-started-at="${active ? session.startedAt || "" : ""}" data-duration="${duration}"> · ${formatDuration(duration)}</span>` : ""}
      </div>

      <div class="meta-row">
        <span class="badge" title="Модель или режим, определённые по интерфейсу">${escapeHtml(session.model || "Модель не определена")}</span>
        <span class="badge context-${escapeHtml(session.contextLevel || "fresh")}" title="Оценка только по видимому тексту переписки">${formatTokens(session.estimatedTokens)} · ${contextLabel(session.contextLevel)}</span>
        <span class="badge">${session.messageCount || 0} сообщ.</span>
      </div>

      ${snippet ? `<p class="snippet"><strong>${snippetLabel}:</strong> ${escapeHtml(snippet)}</p>` : ""}

      <div class="card-actions">
        <button class="open-button" data-action="open">Открыть</button>
        ${session.unread ? '<button data-action="mark-read">Прочитано</button>' : ""}
        <button data-action="toggle-details">Подробнее</button>
        <button class="close-button" data-action="close">Закрыть</button>
      </div>

      <div class="details" hidden>
        <div><span>Conversation ID</span><code>${escapeHtml(session.conversationId || "ещё не создан")}</code></div>
        <div><span>Состояние</span><code>${escapeHtml(session.status || "unknown")}</code></div>
        <div><span>Вкладка</span><code>#${session.tabId}, окно #${session.windowId ?? "?"}</code></div>
        <div><span>В фокусе</span><code>${session.focused ? "да" : "нет"}; внизу: ${session.atBottom ? "да" : "нет"}</code></div>
        <div><span>Обновлено</span><code>${new Date(session.updatedAt || session.lastSeenAt || Date.now()).toLocaleTimeString("ru-RU")}</code></div>
        <div><span>URL</span><code class="url-code">${escapeHtml(session.url || "")}</code></div>
        <button data-action="copy-diagnostics">Копировать диагностику</button>
      </div>
    </article>`;
}

function render() {
  renderStats();
  const filtered = getFilteredSessions();
  elements.sessionList.innerHTML = filtered.map(renderCard).join("");
  elements.emptyState.hidden = filtered.length > 0;
}

async function loadSessions() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SESSIONS" });
  sessions = response?.sessions || [];
  settings = response?.settings || {};
  elements.notificationsToggle.checked = settings.notifications !== false;
  elements.snippetsToggle.checked = settings.includeSnippets === true;
  render();
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.ok === false)
    throw new Error(response.error || "Неизвестная ошибка");
  return response;
}

function showToast(text) {
  clearTimeout(toastTimer);
  elements.toast.textContent = text;
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2300);
}

function getCard(target) {
  return target.closest(".session-card");
}

function beginEdit(card) {
  card.querySelector(".title-view").hidden = true;
  const editor = card.querySelector(".title-editor");
  editor.hidden = false;
  const input = editor.querySelector("input");
  input.focus();
  input.select();
}

async function saveName(card) {
  const input = card.querySelector(".title-editor input");
  await send({ type: "RENAME_SESSION", tabId: Number(card.dataset.tabId), alias: input.value });
  await loadSessions();
}

elements.sessionList.addEventListener("click", async event => {
  const actionElement = event.target.closest("[data-action]");
  if (!actionElement)
    return;

  const card = getCard(actionElement);
  const tabId = Number(card.dataset.tabId);

  try {
    switch (actionElement.dataset.action) {
      case "open":
        await send({ type: "FOCUS_SESSION", tabId, scrollToEnd: true });
        break;
      case "edit":
        beginEdit(card);
        break;
      case "save-name":
        await saveName(card);
        break;
      case "mark-read":
        await send({ type: "MARK_READ", tabId });
        await loadSessions();
        break;
      case "toggle-details": {
        const details = card.querySelector(".details");
        details.hidden = !details.hidden;
        actionElement.textContent = details.hidden ? "Подробнее" : "Скрыть";
        break;
      }
      case "copy-diagnostics": {
        const session = sessions.find(item => Number(item.tabId) === tabId);
        await navigator.clipboard.writeText(JSON.stringify(session, null, 2));
        showToast("Диагностика скопирована");
        break;
      }
      case "close":
        await send({ type: "CLOSE_TAB", tabId });
        break;
    }
  } catch (error) {
    showToast(error.message);
  }
});

elements.sessionList.addEventListener("keydown", async event => {
  if (event.key !== "Enter" || !event.target.matches(".title-editor input"))
    return;

  try {
    await saveName(getCard(event.target));
  } catch (error) {
    showToast(error.message);
  }
});

elements.searchInput.addEventListener("input", render);
elements.filters.addEventListener("click", event => {
  const button = event.target.closest("[data-filter]");
  if (!button)
    return;

  currentFilter = button.dataset.filter;
  for (const filter of elements.filters.querySelectorAll(".filter"))
    filter.classList.toggle("active", filter === button);
  render();
});

elements.refreshButton.addEventListener("click", async () => {
  elements.refreshButton.classList.add("loading");
  try {
    await send({ type: "REFRESH_ALL" });
    setTimeout(loadSessions, 600);
  } finally {
    setTimeout(() => elements.refreshButton.classList.remove("loading"), 700);
  }
});

elements.groupTabsButton.addEventListener("click", async () => {
  try {
    const response = await send({ type: "GROUP_TABS" });
    showToast(`Собрано вкладок: ${response.count}`);
  } catch (error) {
    showToast(error.message);
  }
});

elements.closeDuplicatesButton.addEventListener("click", async () => {
  try {
    const preview = await send({ type: "PREVIEW_DUPLICATES" });
    const duplicates = preview.duplicates || [];
    if (!duplicates.length) {
      showToast("Дубликатов не найдено");
      return;
    }

    const titles = duplicates.slice(0, 8).map(item => `• ${item.title}`).join("\n");
    const rest = duplicates.length > 8 ? `\n…и ещё ${duplicates.length - 8}` : "";
    const confirmed = confirm(`Будут закрыты ${duplicates.length} дублирующихся вкладок:\n\n${titles}${rest}\n\nПродолжить?`);
    if (!confirmed)
      return;

    const response = await send({ type: "CLOSE_DUPLICATES", tabIds: duplicates.map(item => item.tabId) });
    showToast(`Закрыто дублей: ${response.count}`);
  } catch (error) {
    showToast(error.message);
  }
});

elements.openChatGptButton.addEventListener("click", () => chrome.tabs.create({ url: "https://chatgpt.com/" }));
elements.notificationsToggle.addEventListener("change", async () => {
  await send({ type: "UPDATE_SETTINGS", settings: { notifications: elements.notificationsToggle.checked } });
  showToast(elements.notificationsToggle.checked ? "Уведомления включены" : "Уведомления выключены");
});

elements.snippetsToggle.addEventListener("change", async () => {
  await send({ type: "UPDATE_SETTINGS", settings: { includeSnippets: elements.snippetsToggle.checked } });
  await loadSessions();
  showToast(elements.snippetsToggle.checked ? "Фрагменты будут сохраняться локально" : "Сохранённые фрагменты удалены");
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "SESSIONS_CHANGED")
    loadSessions().catch(() => {});
});

setInterval(() => {
  for (const timer of document.querySelectorAll(".timer[data-started-at]")) {
    const startedAt = Number(timer.dataset.startedAt);
    const duration = startedAt ? Date.now() - startedAt : Number(timer.dataset.duration);
    timer.textContent = ` · ${formatDuration(duration)}`;
  }
}, 1000);

loadSessions().catch(error => showToast(error.message));
