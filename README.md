# Aster Chat

A polished, responsive AI chat app built with plain HTML, CSS, and JavaScript. The local Node server calls the Gemini API, so the API key is never sent to the browser.

## Run locally

1. Install Node.js 20 or newer if it is not already installed.
2. In PowerShell, copy the example settings file and add your rotated credentials:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   Add a Gemini API key and, if using Atlas, a MongoDB connection string, then save the file. Keys shared in chat should be rotated before production use. URL-encode any special characters in the MongoDB username or password.
3. Install the dependencies and start the server from this folder:

   ```powershell
   npm install
   npm start
   ```

4. Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

You can also set `GEMINI_API_KEY` in the shell before starting the server. The server listens on `127.0.0.1` by default; set `PORT` to use a different local port.

## Included

- Gemini API chat with Gemini 3.8 Flash, Gemini 3.1 Pro, and Gemini 3.5 Flash-Lite choices.
- Optional Google Search grounding, response detail, light/dark/system themes, and Enter-to-send preference.
- Searchable conversation history synchronized to MongoDB Atlas (or stored locally when MongoDB is not configured), with delete and clear controls.
- Login and sign-up pages with scrypt-hashed passwords, account-specific browser history, and HTTP-only session cookies.
- An admin console for `ADMIN_EMAIL` with account, conversation, message, recent activity, and database connection overview.
- Responsive layout, keyboard shortcuts, message copy, Markdown formatting, and retry after API errors.
- Gemini API key stays in the local server environment and is never included in frontend code.

MongoDB account and conversation records are used when `MONGODB_URI` is configured. Without a MongoDB URI, the app uses local JSON files under the ignored `.data` directory. The browser keeps a per-account local cache for preferences and offline continuity. Sessions last until the server restarts or the cookie expires. Replies go to Google’s Gemini API using `GEMINI_API_KEY`. When Google Search grounding is enabled, grounded answers include source citations and the Search Suggestions widget returned by Gemini. Google Search grounding may have separate charges; review the current [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) before enabling it.

## Deploy to Vercel

The frontend is served as static files, with `/api/*` routed to a Node.js Function. Add these environment variables in the Vercel project settings before deploying:

- `GEMINI_API_KEY` — Gemini API key.
- `MONGODB_URI` — MongoDB Atlas connection string. Persistent storage is required on Vercel.
- `MONGODB_DB_NAME` — optional; defaults to `aster_chat`.
- `SESSION_SECRET` — a random secret of at least 32 bytes used to sign HTTP-only session cookies.
- `ADMIN_EMAIL` — optional; defaults to `admin@example.com`.

The project includes a Vercel API adapter and routes for the single-function API deployment. Local file storage is only used outside Vercel. The database connection string and API key must be stored as encrypted Vercel environment variables and must never be committed to Git.

This is a starter app rather than a production identity service. Accounts currently use password sign-in without email verification. Before opening the app to the public, use a verified identity provider and review the admin account bootstrap flow.
