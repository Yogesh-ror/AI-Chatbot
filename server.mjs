import { createServer } from "node:http";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DATA_DIR = resolve(process.env.ASTER_DATA_DIR || resolve(ROOT, ".data"));
const USERS_FILE = resolve(DATA_DIR, "users.json");
const CONVERSATIONS_FILE = resolve(DATA_DIR, "conversations.json");
const allowedModels = new Set(["gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite"]);
const scrypt = promisify(scryptCallback);
const localSessionSecret = randomBytes(32).toString("base64url");
const rateEvents = new Map();
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
let mongoConnectionPromise = null;
let mongoIndexesPromise = null;
const styles = {
  concise: "Answer in a few clear sentences by default. Use a list only when it makes the answer easier to scan.",
  balanced: "Answer clearly and directly. Use short sections or lists when they make the answer easier to understand. Include useful context without unnecessary length.",
  detailed: "Give a thorough, well-structured answer. Explain important reasoning and assumptions, and use examples when they clarify the answer.",
};

loadDotEnv();

function loadDotEnv() {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return;
  try {
    const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]]) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, "");
      process.env[match[1]] = value;
    }
  } catch {
    // The server can still use API keys supplied by the process environment.
  }
}

function mongoConfigured() {
  return Boolean(process.env.MONGODB_URI?.trim());
}

async function getMongoDb() {
  if (!mongoConfigured()) {
    if (process.env.VERCEL) throw new Error("MongoDB must be configured for Vercel deployments.");
    return null;
  }
  if (!mongoConnectionPromise) {
    mongoConnectionPromise = (async () => {
      const { MongoClient, ServerApiVersion } = await import("mongodb");
      const client = new MongoClient(process.env.MONGODB_URI, {
        serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
        appName: "aster-chat",
        serverSelectionTimeoutMS: 10000,
      });
      await client.connect();
      const db = client.db(process.env.MONGODB_DB_NAME || "aster_chat");
      await db.command({ ping: 1 });
      return { client, db };
    })().catch((error) => {
      mongoConnectionPromise = null;
      throw error;
    });
  }
  const connection = await mongoConnectionPromise;
  if (!mongoIndexesPromise) {
    mongoIndexesPromise = Promise.all([
      connection.db.collection("users").createIndex({ email: 1 }, { unique: true }),
      connection.db.collection("conversations").createIndex({ userId: 1, updatedAt: -1 }),
    ]).catch((error) => {
      mongoIndexesPromise = null;
      throw error;
    });
  }
  await mongoIndexesPromise;
  return connection.db;
}

async function databaseStatus() {
  if (!mongoConfigured()) {
    return process.env.VERCEL
      ? { configured: false, connected: false, mode: "required", message: "MongoDB must be configured before this deployment can store accounts and chats." }
      : { configured: false, connected: false, mode: "local", message: "MongoDB is not configured; using local storage." };
  }
  try {
    await getMongoDb();
    return { configured: true, connected: true, mode: "mongodb", message: "MongoDB Atlas is connected." };
  } catch {
    return { configured: true, connected: false, mode: "mongodb", message: "MongoDB is unreachable. Check the URI and Atlas network access list." };
  }
}

function storageError() {
  return mongoConfigured()
    ? "MongoDB could not be reached. Check MONGODB_URI and your Atlas network access list, then restart the server."
    : "Local storage is unavailable. Check the app's .data folder permissions.";
}

function sendJSON(response, status, data, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extraHeaders,
  });
  response.end(JSON.stringify(data));
}

async function readJSON(request, limit = 1024 * 1024) {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > limit) throw Object.assign(new Error("Request body is too large."), { status: 413 });
  if (request.body !== undefined) {
    if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) return request.body;
    const rawBody = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : String(request.body);
    if (Buffer.byteLength(rawBody) > limit) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    try { return JSON.parse(rawBody); }
    catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 });
  }
}

async function readUsers() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(USERS_FILE, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("The account store is invalid.");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeUsers(users) {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = resolve(DATA_DIR, `users-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(users, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, USERS_FILE);
}

async function readConversationsLocal() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(CONVERSATIONS_FILE, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("The conversation store is invalid.");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeConversationsLocal(conversations) {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = resolve(DATA_DIR, `conversations-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(conversations, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, CONVERSATIONS_FILE);
}

async function findUserByEmail(email) {
  const db = await getMongoDb();
  if (db) return await db.collection("users").findOne({ email });
  return (await readUsers()).find((user) => user.email === email) || null;
}

async function insertUser(user) {
  const db = await getMongoDb();
  if (db) {
    await db.collection("users").insertOne({ ...user, _id: user.id });
    return;
  }
  const users = await readUsers();
  if (users.some((entry) => entry.email === user.email)) throw Object.assign(new Error("Account already exists."), { code: 11000 });
  users.push(user);
  await writeUsers(users);
}

async function listConversations(user) {
  const db = await getMongoDb();
  if (db) {
    return await db.collection("conversations").find({ userId: user.id }, { projection: { _id: 0 } }).sort({ updatedAt: -1 }).toArray();
  }
  return (await readConversationsLocal()).filter((conversation) => conversation.userId === user.id).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function saveConversation(user, chat) {
  const document = {
    id: chat.id,
    userId: user.id,
    ownerEmail: user.email,
    title: chat.title,
    messages: chat.messages,
    createdAt: chat.createdAt || Date.now(),
    updatedAt: chat.updatedAt || Date.now(),
  };
  const db = await getMongoDb();
  if (db) {
    await db.collection("conversations").replaceOne({ _id: chat.id, userId: user.id }, { ...document, _id: chat.id }, { upsert: true });
    return;
  }
  const conversations = await readConversationsLocal();
  const index = conversations.findIndex((item) => item.id === chat.id && item.userId === user.id);
  if (index < 0) conversations.push(document);
  else conversations[index] = document;
  await writeConversationsLocal(conversations);
}

async function deleteConversations(user, id = null) {
  const db = await getMongoDb();
  if (db) {
    const filter = { userId: user.id, ...(id ? { _id: id } : {}) };
    const result = await db.collection("conversations").deleteMany(filter);
    return result.deletedCount;
  }
  const conversations = await readConversationsLocal();
  const remaining = conversations.filter((item) => item.userId !== user.id || (id && item.id !== id));
  await writeConversationsLocal(remaining);
  return conversations.length - remaining.length;
}

async function buildAdminOverview() {
  const database = await databaseStatus();
  let db;
  try { db = await getMongoDb(); }
  catch {
    return { database, userCount: null, conversationCount: null, newUsers7d: null, messageCount: null, recent: [] };
  }
  if (db) {
    const users = db.collection("users");
    const conversations = db.collection("conversations");
    const activeSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [userCount, conversationCount, newUsers7d, messageRows, recent] = await Promise.all([
      users.countDocuments({}),
      conversations.countDocuments({}),
      users.countDocuments({ createdAt: { $gte: activeSince } }),
      conversations.aggregate([{ $group: { _id: null, total: { $sum: { $size: { $ifNull: ["$messages", []] } } } } }]).toArray(),
      conversations.aggregate([
        { $addFields: { messageCount: { $size: { $ifNull: ["$messages", []] } } } },
        { $sort: { updatedAt: -1 } }, { $limit: 8 },
        { $project: { _id: 0, title: 1, ownerEmail: 1, updatedAt: 1, messageCount: 1 } },
      ]).toArray(),
    ]);
    return { database, userCount, conversationCount, newUsers7d, messageCount: messageRows[0]?.total || 0, recent };
  }

  const [users, conversations] = await Promise.all([readUsers(), readConversationsLocal()]);
  const activeSince = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const owned = conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return {
    database,
    userCount: users.length,
    conversationCount: conversations.length,
    newUsers7d: users.filter((user) => Date.parse(user.createdAt) >= activeSince).length,
    messageCount: conversations.reduce((total, chat) => total + (chat.messages?.length || 0), 0),
    recent: owned.slice(0, 8).map((chat) => ({ title: chat.title, ownerEmail: chat.ownerEmail, updatedAt: chat.updatedAt, messageCount: chat.messages?.length || 0 })),
  };
}

async function handleConversations(request, response, session, pathname) {
  const match = pathname.match(/^\/api\/conversations(?:\/([^/]+))?$/);
  if (!match) { sendJSON(response, 404, { error: "Conversation endpoint not found." }); return; }
  let id = null;
  try { id = match[1] ? decodeURIComponent(match[1]) : null; }
  catch { sendJSON(response, 400, { error: "Invalid conversation ID." }); return; }

  try {
    if (request.method === "GET" && !id) {
      sendJSON(response, 200, { chats: await listConversations(session.user) });
      return;
    }
    if (request.method === "PUT" && id) {
      let body;
      try { body = await readJSON(request, 3 * 1024 * 1024); }
      catch (error) { sendJSON(response, error.status || 400, { error: error.message }); return; }
      const source = body.chat;
      if (!source || source.id !== id || typeof source.title !== "string" || source.title.length > 180 || !Array.isArray(source.messages) || source.messages.length > 250) {
        sendJSON(response, 400, { error: "Invalid conversation data." });
        return;
      }
      const messages = [];
      for (const message of source.messages) {
        if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || message.content.length > 50000) {
          sendJSON(response, 400, { error: "Invalid message data." });
          return;
        }
        messages.push({ role: message.role, content: message.content, createdAt: Number(message.createdAt) || Date.now() });
      }
      await saveConversation(session.user, { ...source, messages });
      sendJSON(response, 200, { ok: true });
      return;
    }
    if (request.method === "DELETE") {
      const deleted = await deleteConversations(session.user, id);
      sendJSON(response, 200, { deleted });
      return;
    }
    sendJSON(response, 405, { error: "Method not allowed." }, { Allow: "GET, PUT, DELETE" });
  } catch {
    sendJSON(response, 503, { error: storageError() });
  }
}

async function handleAdmin(request, response) {
  if (request.method !== "GET") {
    sendJSON(response, 405, { error: "Method not allowed." }, { Allow: "GET" });
    return;
  }
  const session = findSession(request);
  if (!session) { sendJSON(response, 401, { error: "Sign in to continue." }); return; }
  if (session.user.role !== "admin") { sendJSON(response, 403, { error: "Admin access is required." }); return; }
  try {
    sendJSON(response, 200, await buildAdminOverview());
  } catch {
    sendJSON(response, 503, { error: storageError() });
  }
}

function readSessionId(request) {
  const cookieHeader = request.headers.cookie || "";
  const cookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith("aster_session="));
  if (!cookie) return null;
  try { return decodeURIComponent(cookie.slice("aster_session=".length)); }
  catch { return null; }
}

function getSessionSecret() {
  return process.env.SESSION_SECRET?.trim() || (process.env.VERCEL ? null : localSessionSecret);
}

function findSession(request) {
  const token = readSessionId(request);
  const secret = getSessionSecret();
  if (!token || !secret) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.user?.id || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) return null;
    return { sessionId: token, user: session.user, expiresAt: session.expiresAt };
  } catch {
    return null;
  }
}

function publicAccount(user) {
  const adminEmail = (process.env.ADMIN_EMAIL || "admin@example.com").trim().toLowerCase();
  return {
    id: user.id || String(user._id),
    name: user.name,
    email: user.email,
    role: user.email?.toLowerCase() === adminEmail ? "admin" : "user",
  };
}

function setSessionCookie(request, sessionId) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const secure = request.socket?.encrypted || forwardedProto === "https" ? "; Secure" : "";
  return `aster_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
}

function clearSessionCookie(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const secure = request.socket?.encrypted || forwardedProto === "https" ? "; Secure" : "";
  return `aster_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

function issueSession(request, response, user) {
  const secret = getSessionSecret();
  if (!secret) {
    sendJSON(response, 503, { error: "Session signing is not configured. Add SESSION_SECRET to the server environment." });
    return;
  }
  const account = publicAccount(user);
  const payload = Buffer.from(JSON.stringify({ user: account, expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  const sessionId = `${payload}.${signature}`;
  sendJSON(response, 200, { user: account }, { "Set-Cookie": setSessionCookie(request, sessionId) });
}

function rateLimited(request, route, maxAttempts) {
  const now = Date.now();
  const bucketKey = `${request.socket.remoteAddress || "unknown"}:${route}`;
  const previous = (rateEvents.get(bucketKey) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (previous.length >= maxAttempts) {
    rateEvents.set(bucketKey, previous);
    return true;
  }
  previous.push(now);
  rateEvents.set(bucketKey, previous);
  return false;
}

async function handleAuth(request, response, route) {
  if (route === "me" && request.method === "GET") {
    const session = findSession(request);
    if (!session) { sendJSON(response, 401, { error: "Sign in to continue." }); return; }
    sendJSON(response, 200, { user: session.user });
    return;
  }
  if (route === "logout" && request.method === "POST") {
    sendJSON(response, 200, { ok: true }, { "Set-Cookie": clearSessionCookie(request) });
    return;
  }
  if (!["login", "signup"].includes(route) || request.method !== "POST") {
    sendJSON(response, 404, { error: "Authentication endpoint not found." });
    return;
  }
  if (rateLimited(request, route, route === "login" ? 10 : 5)) {
    sendJSON(response, 429, { error: "Too many attempts. Wait a little and try again." });
    return;
  }

  let body;
  try { body = await readJSON(request, 16 * 1024); }
  catch (error) { sendJSON(response, error.status || 400, { error: error.message }); return; }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    sendJSON(response, 400, { error: "Enter a valid email address." });
    return;
  }
  if (password.length < 10 || password.length > 256) {
    sendJSON(response, 400, { error: "Use a password between 10 and 256 characters." });
    return;
  }

  try {
    const existing = await findUserByEmail(email);
    if (route === "signup") {
      if (name.length < 1 || name.length > 60) {
        sendJSON(response, 400, { error: "Enter a name between 1 and 60 characters." });
        return;
      }
      if (existing) {
        sendJSON(response, 409, { error: "An account with that email already exists. Try logging in." });
        return;
      }
      const salt = randomBytes(16).toString("hex");
      const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
      const user = { id: randomUUID(), name, email, salt, passwordHash, createdAt: new Date().toISOString() };
      await insertUser(user);
      issueSession(request, response, user);
      return;
    }

    const user = existing;
    const salt = user?.salt || "aster-account-not-found";
    const candidate = Buffer.from(await scrypt(password, salt, 64));
    const expected = user ? Buffer.from(user.passwordHash, "hex") : Buffer.alloc(64);
    if (!user || expected.length !== candidate.length || !timingSafeEqual(candidate, expected)) {
      sendJSON(response, 401, { error: "Email or password is incorrect." });
      return;
    }
    issueSession(request, response, user);
  } catch (error) {
    if (error.code === 11000) {
      sendJSON(response, 409, { error: "An account with that email already exists. Try logging in." });
      return;
    }
    sendJSON(response, 503, { error: storageError() });
  }
}

function validMessages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40) return null;
  const messages = [];
  for (const item of value) {
    if (!item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string") return null;
    const content = item.content.trim();
    if (!content || content.length > 20000) return null;
    messages.push({ role: item.role, content });
  }
  if (messages.at(-1)?.role !== "user") return null;
  return messages;
}

async function handleChat(request, response) {
  if (!process.env.GEMINI_API_KEY) {
    sendJSON(response, 503, { error: "Add GEMINI_API_KEY to the app’s .env file, then restart the server." });
    return;
  }
  let body;
  try {
    body = await readJSON(request);
  } catch (error) {
    sendJSON(response, error.status || 400, { error: error.message });
    return;
  }

  const messages = validMessages(body.messages);
  if (!messages) {
    sendJSON(response, 400, { error: "Send a conversation with a final user message (up to 40 messages)." });
    return;
  }
  const model = allowedModels.has(body.model) ? body.model : "gemini-3.8-flash";
  const responseStyle = styles[body.responseStyle] || styles.balanced;
  const payload = {
    system_instruction: {
      parts: [{ text: `You are Aster, a thoughtful, capable AI assistant. Be useful, honest about uncertainty, and answer the user's actual question. Use Markdown when it improves readability. ${responseStyle}` }],
    },
    contents: messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    })),
  };
  if (body.webSearch === true) payload.tools = [{ google_search: {} }];

  try {
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": process.env.GEMINI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const message = result?.error?.message || `Gemini returned an error (${upstream.status}).`;
      sendJSON(response, 502, { error: `Gemini API: ${message}` });
      return;
    }
    const candidate = result.candidates?.[0];
    let text = (candidate?.content?.parts || []).map((part) => part.text || "").join("").trim();
    const metadata = candidate?.groundingMetadata;
    const supports = [...(metadata?.groundingSupports || [])].sort((a, b) => (b.segment?.endIndex || 0) - (a.segment?.endIndex || 0));
    const chunks = metadata?.groundingChunks || [];
    for (const support of supports) {
      const endIndex = support.segment?.endIndex;
      const citations = (support.groundingChunkIndices || []).map((index) => {
        const uri = chunks[index]?.web?.uri;
        if (!uri) return null;
        try {
          const parsed = new URL(uri);
          return parsed.protocol === "https:" ? `[${index + 1}](${parsed.href})` : null;
        } catch { return null; }
      }).filter(Boolean);
      if (Number.isInteger(endIndex) && citations.length) text = `${text.slice(0, endIndex)}${citations.join(", ")}${text.slice(endIndex)}`;
    }
    if (!text) {
      const blocked = result.promptFeedback?.blockReason || candidate?.finishReason;
      sendJSON(response, 502, { error: blocked ? `Gemini could not answer this request (${blocked}). Try rephrasing it.` : "Gemini returned an empty reply. Please try again." });
      return;
    }
    sendJSON(response, 200, {
      text,
      searchSuggestionsHTML: body.webSearch === true ? metadata?.searchEntryPoint?.renderedContent || null : null,
    });
  } catch (error) {
    sendJSON(response, 502, { error: `Could not reach the Gemini API: ${error.message}` });
  }
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(urlPath, response) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch {
    response.writeHead(400, securityHeaders()).end("Bad request");
    return;
  }
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (relativePath.split(/[\\/]/).some((part) => part.startsWith("."))) {
    response.writeHead(404, securityHeaders()).end("Not found");
    return;
  }
  const target = resolve(ROOT, relativePath);
  const pathFromRoot = relative(ROOT, target);
  if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === ".." || pathFromRoot.includes(`..${sep}`)) {
    response.writeHead(403, securityHeaders()).end("Forbidden");
    return;
  }
  try {
    if (!(await stat(target)).isFile()) throw new Error("Not a file");
    const content = await readFile(target);
    response.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": mimeTypes[extname(target).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(content);
  } catch {
    response.writeHead(404, securityHeaders()).end("Not found");
  }
}

export async function handleRequest(request, response) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  try {
    if (url.pathname.startsWith("/api/auth/")) {
      await handleAuth(request, response, url.pathname.slice("/api/auth/".length));
      return;
    }
    if (url.pathname === "/api/admin/overview") {
      await handleAdmin(request, response);
      return;
    }
    if (url.pathname === "/api/conversations" || url.pathname.startsWith("/api/conversations/")) {
      const session = findSession(request);
      if (!session) { sendJSON(response, 401, { error: "Sign in to continue." }); return; }
      await handleConversations(request, response, session, url.pathname);
      return;
    }
    if (url.pathname === "/api/config" && request.method === "GET") {
      sendJSON(response, 200, {
        geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
        sessionConfigured: Boolean(getSessionSecret()),
        defaultModel: "gemini-3.8-flash",
        provider: "Gemini",
        database: await databaseStatus(),
      });
      return;
    }
    if (url.pathname === "/api/chat" && request.method === "POST") {
      if (!findSession(request)) {
        sendJSON(response, 401, { error: "Sign in to continue." });
        return;
      }
      await handleChat(request, response);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      sendJSON(response, 404, { error: "API endpoint not found." });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { ...securityHeaders(), Allow: "GET, HEAD" }).end("Method not allowed");
      return;
    }
    await serveStatic(url.pathname, response);
  } catch (error) {
    console.error("[api] request failed", { path: url.pathname, errorType: error?.name || "Error" });
    if (!response.headersSent) sendJSON(response, 500, { error: "The server hit an unexpected error. Check its logs." });
    else response.destroy();
  }
}

if (!process.env.VERCEL) {
  const server = createServer(handleRequest);
  const port = Number.parseInt(process.env.PORT || "4173", 10);
  const host = "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`Aster is ready at http://${host}:${port}`);
    console.log(process.env.GEMINI_API_KEY ? "Gemini API key detected." : "Gemini API key is not configured.");
    console.log(mongoConfigured() ? "MongoDB URI is configured; connection will be checked on first request." : "MongoDB is not configured; using local file storage.");
  });

  process.on("SIGINT", () => server.close(() => process.exit(0)));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
