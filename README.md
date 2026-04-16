# Raven Voice Agent (Gemini)

Raven is a personal AI voice assistant web app built with Next.js and Gemini.

This project uses the newer `@google/genai` SDK with server-side model fallback,
so it uses flash-first defaults and automatically fail over if unavailable for
your key or API version.

It supports:

- Voice input with live browser speech recognition when available.
- Automatic audio recording fallback + Gemini transcription for browsers without live recognition.
- Gemini chat responses with conversational memory.
- Agentic action planning and execution from prompts (Action Center).
- Voice playback of responses using browser speech synthesis.
- Mobile and laptop usage from a single deployed Vercel URL.

## 1. Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create environment variables:

```bash
# macOS/Linux
cp .env.example .env.local

# Windows PowerShell
Copy-Item .env.example .env.local
```

3. Add your Gemini API key to `.env.local`:

```bash
GEMINI_API_KEY=your_key_here
```

4. Start development server:

```bash
npm run dev
```

5. Open `http://localhost:3000`.

## 2. Environment Variables

Required:

- `GEMINI_API_KEY`: Your Gemini API key.

Optional:

- `GEMINI_API_VERSION`: Defaults to `v1` in the example file.
- `GEMINI_CHAT_MODEL`: Primary chat model. Default: `gemini-2.5-flash`.
- `GEMINI_CHAT_FALLBACK_MODELS`: Comma-separated backups (recommend flash-first order).
- `GEMINI_TRANSCRIBE_MODEL`: Primary speech-to-text model. Default: `gemini-2.5-flash`.
- `GEMINI_TRANSCRIBE_FALLBACK_MODELS`: Comma-separated backups (recommend flash-first order).

If you want Pro quality and have enough quota/billing, set:

- `GEMINI_CHAT_MODEL=gemini-3.1-pro`
- `GEMINI_TRANSCRIBE_MODEL=gemini-3.1-pro`

## 3. Rotate Exposed Key (Important)

If your API key was ever committed or shared in a screenshot/text, rotate it.

1. Open Google AI Studio API Keys page.
2. Delete the exposed key.
3. Create a new key.
4. Put the new key only in `.env.local` (local) and Vercel env vars (cloud).

## 4. Deploy to Vercel

1. Push this folder to GitHub.
2. Import the repository in Vercel.
3. In Vercel project settings, add:

- `GEMINI_API_KEY`
- Optional model overrides (`GEMINI_CHAT_MODEL`, `GEMINI_TRANSCRIBE_MODEL`)

4. Deploy.
5. Open your Vercel URL from laptop and phone.

## 5. Browser Notes

- Best voice capture experience: Chrome/Edge.
- On browsers that do not support live speech recognition, Raven records audio and transcribes via Gemini.
- Voice playback depends on browser speech synthesis voices installed on the device.
- Action Center supports cross-device actions like opening links, web search, maps, email, phone, SMS, clipboard, sharing, and timers.
- Some actions require user gesture or popup permission depending on browser security.

## 6. Project Structure

- `app/page.tsx`: Voice UI and client interactions.
- `app/api/chat/route.ts`: Gemini conversational reply endpoint.
- `app/api/transcribe/route.ts`: Gemini transcription endpoint for recorded audio.
- `lib/gemini.ts`: Gemini client and model configuration.
- `app/manifest.ts`: PWA manifest data.
