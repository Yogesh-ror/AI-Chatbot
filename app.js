let STORAGE_KEY = "aster-chat-state-v1";
const MODEL_LABELS = {
  "gemini-3.8-flash": "Fastest response",
  "gemini-3.1-pro-preview": "Fastest response",
  "gemini-3.5-flash-lite": "Fastest response",
};
const validThemes = new Set(["light", "dark", "system"]);
const validStyles = new Set(["concise", "balanced", "detailed"]);

const defaults = {
  chats: [],
  activeId: null,
  preferences: {
    theme: "light",
    model: "gemini-3.8-flash",
    responseStyle: "balanced",
    webSearch: false,
    enterToSend: true,
  },
};

function loadSavedState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved || typeof saved !== "object") return structuredClone(defaults);
    const preferences = { ...defaults.preferences, ...(saved.preferences || {}) };
    if (!validThemes.has(preferences.theme)) preferences.theme = defaults.preferences.theme;
    if (!validStyles.has(preferences.responseStyle)) preferences.responseStyle = defaults.preferences.responseStyle;
    if (!MODEL_LABELS[preferences.model]) preferences.model = defaults.preferences.model;
    const chats = Array.isArray(saved.chats) ? saved.chats.filter(isValidChat) : [];
    const activeId = chats.some((chat) => chat.id === saved.activeId) ? saved.activeId : null;
    return { chats, activeId, preferences };
  } catch {
    return structuredClone(defaults);
  }
}

function isValidChat(chat) {
  return Boolean(chat && typeof chat.id === "string" && typeof chat.title === "string" && Array.isArray(chat.messages));
}

let state = structuredClone(defaults);
const elements = {
  sidebar: document.querySelector("#sidebar"),
  mobileScrim: document.querySelector("#mobile-scrim"),
  chatList: document.querySelector("#chat-list"),
  emptyHistory: document.querySelector("#empty-history"),
  search: document.querySelector("#chat-search"),
  welcome: document.querySelector("#welcome"),
  messageList: document.querySelector("#message-list"),
  conversationView: document.querySelector("#conversation-view"),
  composer: document.querySelector("#composer"),
  input: document.querySelector("#message-input"),
  sendButton: document.querySelector("#send-button"),
  connectionNote: document.querySelector("#connection-note"),
  dialog: document.querySelector("#settings-dialog"),
  themeSelect: document.querySelector("#theme-select"),
  modelSelect: document.querySelector("#model-select"),
  styleSelect: document.querySelector("#style-select"),
  webSearchToggle: document.querySelector("#web-search-toggle"),
  enterToggle: document.querySelector("#enter-toggle"),
  modelLabel: document.querySelector("#model-label"),
  apiLight: document.querySelector("#api-status-light"),
  apiTitle: document.querySelector("#api-status-title"),
  apiDetail: document.querySelector("#api-status-detail"),
  toast: document.querySelector("#toast"),
  currentAvatar: document.querySelector("#current-avatar"),
  currentName: document.querySelector("#current-name"),
  currentEmail: document.querySelector("#current-email"),
  adminLink: document.querySelector("#admin-link"),
};

let requestInProgress = false;
let currentRequest = null;
let lastFailedChatId = null;
let toastTimer = null;
let connectionAvailable = false;
let currentUser = null;
let remoteSyncReady = false;
const conversationQueues = new Map();

function activeChat() {
  return state.chats.find((chat) => chat.id === state.activeId) || null;
}

function persist() {
  try {
    const savedState = {
      ...state,
      chats: state.chats.map((chat) => ({
        ...chat,
        messages: chat.messages.map(({ searchSuggestionsHTML, ...message }) => message),
      })),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedState));
    if (remoteSyncReady) {
      const chat = activeChat();
      if (chat) queueConversationSync(chat);
    }
    return true;
  } catch {
    showToast("This browser is out of space for saved chats.");
    return false;
  }
}

function queueConversationSync(chat) {
  const snapshot = structuredClone(chat);
  snapshot.messages = snapshot.messages.map(({ searchSuggestionsHTML, ...message }) => message);
  const previous = conversationQueues.get(chat.id) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const response = await fetch(`/api/conversations/${encodeURIComponent(snapshot.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: snapshot }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || "Conversation could not be saved to the server.");
    }
  }).catch((error) => {
    elements.connectionNote.textContent = error.message || "Conversation sync is unavailable.";
  }).finally(() => {
    if (conversationQueues.get(chat.id) === next) conversationQueues.delete(chat.id);
  });
  conversationQueues.set(chat.id, next);
}

async function deleteRemoteConversation(id = null) {
  try {
    const pending = id ? conversationQueues.get(id) : Promise.all([...conversationQueues.values()]);
    if (pending) await pending.catch(() => {});
    const path = id ? `/api/conversations/${encodeURIComponent(id)}` : "/api/conversations";
    const response = await fetch(path, { method: "DELETE" });
    if (!response.ok) throw new Error("The server could not delete this conversation.");
  } catch (error) {
    elements.connectionNote.textContent = error.message || "Conversation sync is unavailable.";
  }
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function applyTheme() {
  const selected = state.preferences.theme;
  const useDark = selected === "dark" || (selected === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = useDark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]').content = useDark ? "#191b19" : "#f7f7f5";
}

function createId() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function startNewChat() {
  const chat = { id: createId(), title: "New conversation", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  state.chats.unshift(chat);
  state.activeId = chat.id;
  persist();
  renderHistory();
  renderConversation();
  closeMobileSidebar();
  elements.input.focus();
}

function deleteChat(id) {
  const deletingActive = state.activeId === id;
  state.chats = state.chats.filter((chat) => chat.id !== id);
  if (deletingActive) state.activeId = state.chats[0]?.id || null;
  persist();
  if (remoteSyncReady) void deleteRemoteConversation(id);
  renderHistory();
  renderConversation();
}

function titleFromMessage(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 36) return clean;
  const first = clean.slice(0, 36).replace(/\s+\S*$/, "").trim();
  return `${first || clean.slice(0, 33)}…`;
}

function renderHistory() {
  const query = elements.search.value.trim().toLowerCase();
  const filtered = state.chats.filter((chat) => {
    if (!query) return true;
    return chat.title.toLowerCase().includes(query) || chat.messages.some((message) => (message.content || "").toLowerCase().includes(query));
  });
  elements.chatList.replaceChildren();
  for (const chat of filtered) {
    const item = document.createElement("div");
    item.className = `chat-item${chat.id === state.activeId ? " active" : ""}`;

    const open = document.createElement("button");
    open.className = "chat-open";
    open.type = "button";
    open.setAttribute("aria-label", `Open ${chat.title}`);
    open.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-message"></use></svg>';
    const title = document.createElement("span");
    title.className = "chat-title";
    title.textContent = chat.title || "New conversation";
    open.append(title);
    open.addEventListener("click", () => {
      state.activeId = chat.id;
      persist();
      renderHistory();
      renderConversation();
      closeMobileSidebar();
    });

    const remove = document.createElement("button");
    remove.className = "delete-chat";
    remove.type = "button";
    remove.setAttribute("aria-label", `Delete ${chat.title}`);
    remove.title = "Delete conversation";
    remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-trash"></use></svg>';
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteChat(chat.id);
    });
    item.append(open, remove);
    elements.chatList.append(item);
  }
  elements.emptyHistory.classList.toggle("hidden", filtered.length > 0);
  if (filtered.length === 0) {
    elements.emptyHistory.textContent = query ? "No conversations match that search." : "Your conversations will show up here.";
  }
}

function addAssistantAvatar() {
  const avatar = document.createElement("span");
  avatar.className = "assistant-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.innerHTML = '<svg class="icon"><use href="#i-aster"></use></svg>';
  return avatar;
}

function renderConversation() {
  const chat = activeChat();
  const hasMessages = Boolean(chat?.messages.length);
  elements.welcome.hidden = hasMessages;
  elements.messageList.replaceChildren();
  if (!chat) {
    elements.connectionNote.hidden = true;
    return;
  }
  for (const [index, message] of chat.messages.entries()) {
    elements.messageList.append(renderMessage(message, index, chat.id));
  }
  if (requestInProgress && currentRequest?.chatId === chat.id) {
    const pending = document.createElement("article");
    pending.className = "message assistant pending-message";
    pending.append(addAssistantAvatar());
    const body = document.createElement("div");
    body.className = "message-body";
    body.innerHTML = '<span class="typing-dots" aria-label="Aster is thinking"><span></span><span></span><span></span></span>';
    pending.append(body);
    elements.messageList.append(pending);
  }
  elements.connectionNote.hidden = !lastFailedChatId || lastFailedChatId !== chat.id;
  elements.conversationView.scrollTop = elements.conversationView.scrollHeight;
}

function renderMessage(message, index, chatId) {
  const article = document.createElement("article");
  article.className = `message ${message.role === "user" ? "user" : "assistant"}`;
  if (message.role === "user") {
    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = message.content;
    article.append(body);
    return article;
  }

  article.append(addAssistantAvatar());
  const body = document.createElement("div");
  body.className = "message-body";
  const content = document.createElement("div");
  content.className = "message-content";
  content.innerHTML = renderMarkdown(message.content || "");
  body.append(content);
  if (message.searchSuggestionsHTML) {
    const suggestions = document.createElement("iframe");
    suggestions.className = "search-suggestions";
    suggestions.title = "Google Search suggestions";
    suggestions.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
    suggestions.setAttribute("referrerpolicy", "no-referrer");
    suggestions.srcdoc = message.searchSuggestionsHTML;
    body.append(suggestions);
  }
  if (message.content) {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "message-action";
    copy.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-message"></use></svg><span>Copy</span>';
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(message.content);
        showToast("Copied to clipboard.");
      } catch {
        showToast("Clipboard access is unavailable in this browser.");
      }
    });
    actions.append(copy);
    body.append(actions);
  }
  article.append(body);
  article.dataset.messageIndex = String(index);
  article.dataset.chatId = chatId;
  return article;
}

function escapeHTML(text) {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function safeLinks(text) {
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    let safeURL;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return label;
      safeURL = escapeHTML(parsed.href);
    } catch {
      return label;
    }
    return `<a href="${safeURL}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
}

function inlineMarkdown(text) {
  let safe = escapeHTML(text);
  safe = safeLinks(safe);
  safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
  safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  safe = safe.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  return safe;
}

function renderMarkdown(text) {
  const pieces = text.split(/```([^\n`]*)\n([\s\S]*?)```/g);
  let html = "";
  for (let index = 0; index < pieces.length; index += 1) {
    if (index % 3 === 1) {
      const code = pieces[index + 1] || "";
      html += `<pre><code>${escapeHTML(code.replace(/\n$/, ""))}</code></pre>`;
      index += 1;
      continue;
    }
    html += renderTextBlocks(pieces[index]);
  }
  return html;
}

function renderTextBlocks(text) {
  const lines = text.split("\n");
  const out = [];
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { flushParagraph(); flushList(); continue; }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    const quote = trimmed.match(/^>\s?(.*)$/);
    if (heading) {
      flushParagraph(); flushList();
      const level = Math.min(heading[1].length + 2, 4);
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
    } else if (unordered || ordered) {
      flushParagraph();
      const wanted = unordered ? "ul" : "ol";
      if (list !== wanted) { flushList(); out.push(`<${wanted}>`); list = wanted; }
      out.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
    } else if (quote) {
      flushParagraph(); flushList();
      out.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
    } else {
      flushList(); paragraph.push(line);
    }
  }
  flushParagraph(); flushList();
  return out.join("");
}

function setBusy(busy) {
  requestInProgress = busy;
  elements.input.disabled = busy;
  elements.sendButton.disabled = busy;
  elements.sendButton.setAttribute("aria-label", busy ? "Aster is replying" : "Send message");
  if (!busy) elements.input.focus();
}

async function submitText(rawText) {
  const text = rawText.trim();
  if (!text || requestInProgress) return;
  let chat = activeChat();
  if (!chat) {
    startNewChat();
    chat = activeChat();
  }
  if (!chat) return;

  const chatId = chat.id;
  chat.messages.push({ role: "user", content: text, createdAt: Date.now() });
  if (chat.messages.filter((message) => message.role === "user").length === 1) chat.title = titleFromMessage(text);
  chat.updatedAt = Date.now();
  state.chats.sort((a, b) => b.updatedAt - a.updatedAt);
  lastFailedChatId = null;
  persist();
  renderHistory();
  elements.input.value = "";
  resizeInput();
  currentRequest = { chatId, userText: text, controller: new AbortController() };
  setBusy(true);
  renderConversation();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: currentRequest.controller.signal,
      body: JSON.stringify({
        model: state.preferences.model,
        responseStyle: state.preferences.responseStyle,
        webSearch: state.preferences.webSearch,
        messages: chat.messages.slice(-40).map(({ role, content }) => ({ role, content })),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "The assistant could not reply right now.");
    const target = state.chats.find((item) => item.id === chatId);
    if (!target) return;
    target.messages.push({ role: "assistant", content: result.text, searchSuggestionsHTML: result.searchSuggestionsHTML || undefined, createdAt: Date.now() });
    target.updatedAt = Date.now();
    state.chats.sort((a, b) => b.updatedAt - a.updatedAt);
    persist();
    lastFailedChatId = null;
  } catch (error) {
    if (error.name !== "AbortError") {
      lastFailedChatId = chatId;
      elements.connectionNote.textContent = error.message || "Something went wrong while contacting the assistant.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => retryLastMessage(chatId));
      elements.connectionNote.append(retry);
    }
  } finally {
    currentRequest = null;
    setBusy(false);
    renderHistory();
    renderConversation();
  }
}

async function retryLastMessage(chatId) {
  const chat = state.chats.find((item) => item.id === chatId);
  const lastUserMessage = chat?.messages.findLast?.((message) => message.role === "user") || [...(chat?.messages || [])].reverse().find((message) => message.role === "user");
  if (!chat || !lastUserMessage || requestInProgress) return;
  state.activeId = chatId;
  const messages = chat.messages;
  const latestIndex = messages.lastIndexOf(lastUserMessage);
  const transcript = messages.slice(0, latestIndex + 1);
  currentRequest = { chatId, userText: lastUserMessage.content, controller: new AbortController() };
  lastFailedChatId = null;
  setBusy(true);
  renderConversation();
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: currentRequest.controller.signal,
      body: JSON.stringify({
        model: state.preferences.model,
        responseStyle: state.preferences.responseStyle,
        webSearch: state.preferences.webSearch,
        messages: transcript.slice(-40).map(({ role, content }) => ({ role, content })),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "The assistant could not reply right now.");
    chat.messages.push({ role: "assistant", content: result.text, searchSuggestionsHTML: result.searchSuggestionsHTML || undefined, createdAt: Date.now() });
    chat.updatedAt = Date.now();
    persist();
  } catch (error) {
    if (error.name !== "AbortError") {
      lastFailedChatId = chatId;
      elements.connectionNote.textContent = error.message || "Something went wrong while contacting the assistant.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => retryLastMessage(chatId));
      elements.connectionNote.append(retry);
    }
  } finally {
    currentRequest = null;
    setBusy(false);
    renderHistory();
    renderConversation();
  }
}

function resizeInput() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 170)}px`;
}

function openSettings() {
  elements.themeSelect.value = state.preferences.theme;
  elements.modelSelect.value = state.preferences.model;
  elements.styleSelect.value = state.preferences.responseStyle;
  elements.webSearchToggle.checked = state.preferences.webSearch;
  elements.enterToggle.checked = state.preferences.enterToSend;
  if (!elements.dialog.open) elements.dialog.showModal();
}

function savePreferences() {
  state.preferences.theme = elements.themeSelect.value;
  state.preferences.model = elements.modelSelect.value;
  state.preferences.responseStyle = elements.styleSelect.value;
  state.preferences.webSearch = elements.webSearchToggle.checked;
  state.preferences.enterToSend = elements.enterToggle.checked;
  applyTheme();
  elements.modelLabel.textContent = MODEL_LABELS[state.preferences.model];
  persist();
}

function closeMobileSidebar() {
  elements.sidebar.classList.remove("mobile-open");
  elements.mobileScrim.classList.remove("visible");
}

function openMobileSidebar() {
  elements.sidebar.classList.add("mobile-open");
  elements.mobileScrim.classList.add("visible");
}

async function checkConnection() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    const config = await response.json();
    const configuredProviders = [config.openaiConfigured && "OpenAI", config.geminiConfigured && "Gemini"].filter(Boolean);
    connectionAvailable = Boolean(response.ok && configuredProviders.length);
    if (connectionAvailable) {
      elements.apiLight.className = "status-light ready";
      elements.apiTitle.textContent = configuredProviders.length > 1 ? "Both AI providers are configured" : `${configuredProviders[0]} key is configured`;
      elements.apiDetail.textContent = configuredProviders.length > 1
        ? `OpenAI and Gemini run together; the first successful answer is used. ${config.database?.message || ""}`
        : `Aster can connect to ${configuredProviders[0]}. ${config.database?.message || ""}`;
    } else {
      elements.apiLight.className = "status-light offline";
      elements.apiTitle.textContent = "AI API key needed";
      elements.apiDetail.textContent = `Add OPENAI_API_KEY or GEMINI_API_KEY to the local .env file. ${config.database?.message || ""}`;
    }
    if (config.defaultModel && !state.preferences.model) state.preferences.model = config.defaultModel;
  } catch {
    connectionAvailable = false;
    elements.apiLight.className = "status-light offline";
    elements.apiTitle.textContent = "App server unavailable";
    elements.apiDetail.textContent = "Start the local server and refresh this page.";
  }
}

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitText(elements.input.value);
});
elements.input.addEventListener("input", resizeInput);
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && state.preferences.enterToSend) {
    event.preventDefault();
    elements.composer.requestSubmit();
  } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.search.addEventListener("input", renderHistory);
document.querySelector("#new-chat").addEventListener("click", startNewChat);
document.querySelector("#open-settings").addEventListener("click", openSettings);
document.querySelector("#top-settings").addEventListener("click", openSettings);
document.querySelector("#model-pill").addEventListener("click", openSettings);
document.querySelector("#close-settings").addEventListener("click", () => elements.dialog.close());
document.querySelector("#done-settings").addEventListener("click", () => elements.dialog.close());
document.querySelector("#sidebar-collapse").addEventListener("click", () => {
  const collapsed = elements.sidebar.classList.toggle("collapsed");
  document.querySelector("#sidebar-collapse").setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  document.querySelector("#sidebar-collapse").title = collapsed ? "Expand sidebar" : "Collapse sidebar";
});
document.querySelector("#mobile-menu").addEventListener("click", openMobileSidebar);
elements.mobileScrim.addEventListener("click", closeMobileSidebar);
document.querySelectorAll(".suggestion-card").forEach((card) => card.addEventListener("click", () => submitText(card.dataset.prompt || "")));
for (const input of [elements.themeSelect, elements.modelSelect, elements.styleSelect, elements.webSearchToggle, elements.enterToggle]) {
  input.addEventListener("change", savePreferences);
}
document.querySelector("#clear-history").addEventListener("click", () => {
  if (!state.chats.length) { showToast("There are no saved conversations to clear."); return; }
  if (!window.confirm("Clear every saved conversation from your account? This cannot be undone.")) return;
  state.chats = [];
  state.activeId = null;
  lastFailedChatId = null;
  persist();
  if (remoteSyncReady) void deleteRemoteConversation();
  renderHistory();
  renderConversation();
  elements.dialog.close();
  showToast("All conversations cleared.");
});
document.querySelector("#sign-out").addEventListener("click", async () => {
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch { /* The redirect still clears the local session view. */ }
  window.location.replace("/auth.html");
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  if (state.preferences.theme === "system") applyTheme();
});
window.addEventListener("keydown", (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === "k") { event.preventDefault(); startNewChat(); }
  if (modifier && event.key === "/") { event.preventDefault(); elements.search.focus(); }
  if (event.key === "Escape") closeMobileSidebar();
});

async function bootstrap() {
  try {
    const response = await fetch("/api/auth/me", { cache: "no-store" });
    if (!response.ok) { window.location.replace("/auth.html"); return; }
    const result = await response.json();
    currentUser = result.user;
    STORAGE_KEY = `aster-chat-state-v1:${currentUser.id}`;
    state = loadSavedState();
    elements.currentName.textContent = currentUser.name;
    elements.currentEmail.textContent = currentUser.email;
    elements.currentAvatar.textContent = currentUser.name.trim().slice(0, 1).toUpperCase();
    elements.adminLink.hidden = currentUser.role !== "admin";
    try {
      const response = await fetch("/api/conversations", { cache: "no-store" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Saved conversations could not be loaded.");
      }
      const result = await response.json();
      const localChats = state.chats;
      const remoteChats = Array.isArray(result.chats) ? result.chats.filter(isValidChat) : [];
      const merged = new Map(remoteChats.map((chat) => [chat.id, chat]));
      for (const chat of localChats) {
        const saved = merged.get(chat.id);
        if (!saved || Number(chat.updatedAt || 0) > Number(saved.updatedAt || 0)) merged.set(chat.id, chat);
      }
      state.chats = [...merged.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (!state.chats.some((chat) => chat.id === state.activeId)) state.activeId = null;
      remoteSyncReady = true;
      persist();
      for (const chat of state.chats) {
        if (!remoteChats.some((saved) => saved.id === chat.id) || Number(chat.updatedAt || 0) > Number(remoteChats.find((saved) => saved.id === chat.id)?.updatedAt || 0)) {
          queueConversationSync(chat);
        }
      }
    } catch (error) {
      elements.connectionNote.textContent = error.message || "Saved conversations could not be synced.";
    }
    state.chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    applyTheme();
    elements.modelLabel.textContent = MODEL_LABELS[state.preferences.model];
    renderHistory();
    renderConversation();
    await checkConnection();
    document.body.classList.remove("booting");
  } catch {
    window.location.replace("/auth.html");
  }
}

bootstrap();
