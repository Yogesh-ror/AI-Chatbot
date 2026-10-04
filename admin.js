const adminElements = {
  banner: document.querySelector("#database-banner"),
  dbMessage: document.querySelector("#database-message"),
  dbHelp: document.querySelector("#database-help"),
  users: document.querySelector("#metric-users"),
  conversations: document.querySelector("#metric-conversations"),
  messages: document.querySelector("#metric-messages"),
  newUsers: document.querySelector("#metric-new-users"),
  recentRows: document.querySelector("#recent-rows"),
  emptyRecent: document.querySelector("#empty-recent"),
  error: document.querySelector("#admin-error"),
};

function formatCount(value) {
  return value == null ? "—" : new Intl.NumberFormat().format(value);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function setDatabase(database) {
  const connected = Boolean(database?.connected);
  adminElements.banner.classList.toggle("connected", connected);
  adminElements.banner.classList.toggle("local-mode", !database?.configured);
  adminElements.dbMessage.textContent = database?.message || "Database status is unavailable.";
  adminElements.dbHelp.hidden = Boolean(database?.configured);
}

function renderRecent(chats) {
  adminElements.recentRows.replaceChildren();
  adminElements.emptyRecent.hidden = chats.length > 0;
  if (!chats.length) {
    adminElements.recentRows.innerHTML = '<tr><td colspan="4" class="table-loading">No saved conversations yet.</td></tr>';
    return;
  }
  for (const chat of chats) {
    const row = document.createElement("tr");
    const title = document.createElement("td");
    title.className = "conversation-cell";
    title.textContent = chat.title || "New conversation";
    const email = document.createElement("td");
    email.className = "account-cell";
    email.textContent = chat.ownerEmail || "—";
    const count = document.createElement("td");
    count.textContent = formatCount(chat.messageCount);
    const updated = document.createElement("td");
    updated.className = "date-cell";
    updated.textContent = formatDate(chat.updatedAt);
    row.append(title, email, count, updated);
    adminElements.recentRows.append(row);
  }
}

async function loadOverview() {
  try {
    const response = await fetch("/api/admin/overview", { cache: "no-store" });
    if (response.status === 401) { window.location.replace("/auth.html"); return; }
    if (response.status === 403) { window.location.replace("/"); return; }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not load the admin overview.");
    adminElements.users.textContent = formatCount(result.userCount);
    adminElements.conversations.textContent = formatCount(result.conversationCount);
    adminElements.messages.textContent = formatCount(result.messageCount);
    adminElements.newUsers.textContent = formatCount(result.newUsers7d);
    setDatabase(result.database);
    renderRecent(result.recent || []);
    document.querySelector("#today-label").textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date());
    document.querySelector("#admin-footer-note").textContent = result.database?.mode === "mongodb" ? "Connected to your MongoDB database." : "Using local app storage until MongoDB is configured.";
    document.body.classList.remove("booting");
  } catch (error) {
    adminElements.error.textContent = error.message === "Failed to fetch"
      ? "Aster’s local server is not running. Start it with npm start from the app folder."
      : error.message;
    adminElements.error.hidden = false;
    document.body.classList.remove("booting");
  }
}

document.querySelector("#admin-signout").addEventListener("click", async () => {
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch { /* Redirect clears the local view. */ }
  window.location.replace("/auth.html");
});

loadOverview();
