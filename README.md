# Aster Chat

A polished, responsive AI chat app built with plain HTML, CSS, and JavaScript. The local Node server can call OpenAI and Gemini in parallel, so provider API keys are never sent to the browser.

## Run locally

1. Install Node.js 20 or newer if it is not already installed.
2. In PowerShell, copy the example settings file and add your rotated credentials:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   Add an OpenAI key, a Gemini key, or both, plus a MongoDB connection string if using Atlas. If both providers are configured, Aster starts both requests together and returns the first successful response. The slower request is aborted when possible; a provider may still charge for work it already started. Keys shared in chat should be rotated before production use. URL-encode any special characters in the MongoDB username or password.
3. Install the dependencies and start the server from this folder:

   ```powershell
   npm install
   npm start
   ```

4. Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

You can also set `OPENAI_API_KEY` and/or `GEMINI_API_KEY` in the shell before starting the server. The server listens on `127.0.0.1` by default; set `PORT` to use a different local port.

## Included

- Parallel OpenAI Responses API and Gemini API chat, returning the first successful provider response. OpenAI uses `gpt-4.1-mini`; the Gemini model can be selected in settings.
- Optional web search (Google Search grounding for Gemini and OpenAI's built-in web search), response detail, light/dark/system themes, and Enter-to-send preference.
- Searchable conversation history synchronized to MongoDB Atlas (or stored locally when MongoDB is not configured), with delete and clear controls.
- Login and sign-up pages with scrypt-hashed passwords, account-specific browser history, and HTTP-only session cookies.
- An admin console for `ADMIN_EMAIL` with account, conversation, message, recent activity, and database connection overview.
- Responsive layout, keyboard shortcuts, message copy, Markdown formatting, and retry after API errors.
- OpenAI and Gemini API keys stay in the server environment and are never included in frontend code.

MongoDB account and conversation records are used when `MONGODB_URI` is configured. Without a MongoDB URI, the app uses local JSON files under the ignored `.data` directory. The browser keeps a per-account local cache for preferences and offline continuity. Sessions last until the server restarts or the cookie expires. When both provider keys are set, each chat starts a Gemini request and an OpenAI Responses API request at the same time; the first successful complete response is returned and the slower request is aborted. A provider may still charge for processing already started before cancellation. If only one key is configured, that provider is used. `OPENAI_API_KEY` uses the OpenAI Responses API with `gpt-4.1-mini` and `store: false`. OpenAI web-search citations are included as clickable source links. Gemini's selected model remains configurable in settings; when Google Search grounding is enabled, Gemini answers include grounding citations and its Search Suggestions widget. Search features may incur provider charges; review [OpenAI API pricing](https://openai.com/api/pricing/) and [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) before enabling them.

## Deploy to Vercel

The frontend is served as static files, with `/api/*` routed to a Node.js Function. Add these environment variables in the Vercel project settings before deploying. Configure at least one AI provider; if both are configured, the first successful response wins:

- `OPENAI_API_KEY` — optional OpenAI API key.
- `GEMINI_API_KEY` — optional Gemini API key. Configure one or both provider keys.
- `MONGODB_URI` — MongoDB Atlas connection string. Persistent storage is required on Vercel.
- `MONGODB_DB_NAME` — optional; defaults to `aster_chat`.
- `SESSION_SECRET` — a random secret of at least 32 bytes used to sign HTTP-only session cookies.
- `ADMIN_EMAIL` — optional; defaults to `admin@example.com`.

The project includes a Vercel API adapter and routes for the single-function API deployment. Local file storage is only used outside Vercel. The database connection string and API key must be stored as encrypted Vercel environment variables and must never be committed to Git.

This is a starter app rather than a production identity service. Accounts currently use password sign-in without email verification. Before opening the app to the public, use a verified identity provider and review the admin account bootstrap flow.
