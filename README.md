# Raven Voice Agent (Gemini)

Raven is a personal AI voice assistant web app built with Next.js and Gemini.

It supports:

- Voice input with live browser speech recognition when available.
- Automatic audio recording fallback + Gemini transcription for browsers without live recognition.
- Gemini chat responses with conversational memory.
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

- `GEMINI_CHAT_MODEL`: Defaults to `gemini-2.5-pro`.
- `GEMINI_TRANSCRIBE_MODEL`: Defaults to `gemini-2.0-flash`.

## 3. Deploy to Vercel

1. Push this folder to GitHub.
2. Import the repository in Vercel.
3. In Vercel project settings, add:

- `GEMINI_API_KEY`
- Optional model overrides (`GEMINI_CHAT_MODEL`, `GEMINI_TRANSCRIBE_MODEL`)

4. Deploy.
5. Open your Vercel URL from laptop and phone.

## 4. Browser Notes

- Best voice capture experience: Chrome/Edge.
- On browsers that do not support live speech recognition, Raven records audio and transcribes via Gemini.
- Voice playback depends on browser speech synthesis voices installed on the device.

## 5. Project Structure

- `app/page.tsx`: Voice UI and client interactions.
- `app/api/chat/route.ts`: Gemini conversational reply endpoint.
- `app/api/transcribe/route.ts`: Gemini transcription endpoint for recorded audio.
- `lib/gemini.ts`: Gemini client and model configuration.
- `app/manifest.ts`: PWA manifest data.
