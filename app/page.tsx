"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  actionNeedsConfirmation,
  type AgentAction,
  describeAgentAction,
} from "@/lib/agent-actions";

type ChatRole = "user" | "assistant";
type InputSource = "voice" | "text";

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0?: { transcript?: string };
};

type SpeechRecognitionEventLike = {
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
type ActionRunMode = "manual" | "autopilot";

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  source: InputSource;
  createdAt: string;
}

interface QueuedAction {
  id: string;
  action: AgentAction;
  status: "pending" | "running" | "done" | "failed";
  detail?: string;
  createdAt: string;
}

const MAX_CONTEXT_MESSAGES = 12;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") {
    return null;
  }

  const extendedWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };

  return (
    extendedWindow.SpeechRecognition ??
    extendedWindow.webkitSpeechRecognition ??
    null
  );
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatClockTime(isoDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoDate));
}

function openUrlInNewTab(url: string): boolean {
  const popup = window.open("", "_blank");

  if (!popup) {
    return false;
  }

  try {
    popup.opener = null;
  } catch {
    // Ignore browsers that disallow writing opener.
  }

  popup.location.href = url;
  return true;
}

function getVoiceCaptureErrorMessage(
  errorCode: string | undefined,
  hasRecorderFallback: boolean,
): string {
  switch (errorCode) {
    case "network":
      return hasRecorderFallback
        ? "Live speech recognition service is unreachable (network). Raven switched to recorder mode. Tap the orb again to record and transcribe with Gemini."
        : "Live speech recognition service is unreachable (network). Check internet, VPN, firewall, and browser privacy settings.";
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone permission is blocked for this site. Allow microphone access and try again.";
    case "audio-capture":
      return "No microphone input device is available.";
    case "no-speech":
      return "No speech was detected. Please try speaking closer to the microphone.";
    case "aborted":
      return "Voice capture was cancelled.";
    default:
      return errorCode
        ? `Voice capture error: ${errorCode}.`
        : "Voice capture failed unexpectedly.";
  }
}

function blobToBase64(audioBlob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : "";

      if (!base64) {
        reject(new Error("Could not convert audio to base64."));
        return;
      }

      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Failed to read audio blob."));
    reader.readAsDataURL(audioBlob);
  });
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [lastTranscript, setLastTranscript] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [voicePlaybackEnabled, setVoicePlaybackEnabled] = useState(true);
  const [supportsLiveRecognition, setSupportsLiveRecognition] = useState(false);
  const [supportsRecorderFallback, setSupportsRecorderFallback] =
    useState(false);
  const [preferRecorderFallback, setPreferRecorderFallback] = useState(false);
  const [usingRecorderFallback, setUsingRecorderFallback] = useState(false);
  const [queuedActions, setQueuedActions] = useState<QueuedAction[]>([]);
  const [autopilotEnabled, setAutopilotEnabled] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const pendingTranscriptRef = useRef("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const chatScrollerRef = useRef<HTMLDivElement | null>(null);
  const voicePlaybackRef = useRef(voicePlaybackEnabled);

  const isBusy = isListening || isThinking;
  const quickPrompts = useMemo(
    () => [
      "Find nearby coffee shops and open maps.",
      "Search the web for today's AI news.",
      "Set a 20-minute focus timer and motivate me.",
    ],
    [],
  );

  useEffect(() => {
    voicePlaybackRef.current = voicePlaybackEnabled;
  }, [voicePlaybackEnabled]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    setSupportsLiveRecognition(Boolean(getSpeechRecognitionCtor()));
    setPreferRecorderFallback(false);
    setSupportsRecorderFallback(
      Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia),
    );
  }, []);

  useEffect(() => {
    const scroller = chatScrollerRef.current;
    if (!scroller) {
      return;
    }

    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, isThinking]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());

      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  async function transcribeWithGemini(audioBlob: Blob): Promise<string> {
    setIsThinking(true);
    setErrorMessage("");

    try {
      const audioBase64 = await blobToBase64(audioBlob);
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audioBase64,
          mimeType: audioBlob.type || "audio/webm",
        }),
      });

      const payload: { transcript?: string; error?: string } =
        await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Transcription failed.");
      }

      const transcript = (payload.transcript ?? "").trim();
      if (!transcript) {
        throw new Error("No speech was detected in your recording.");
      }

      setLastTranscript(transcript);
      return transcript;
    } finally {
      setIsThinking(false);
    }
  }

  function speakReply(text: string): void {
    if (!voicePlaybackEnabled) {
      return;
    }

    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.96;
    utterance.pitch = 1;
    utterance.lang = "en-US";

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  async function executeAgentAction(
    action: AgentAction,
    runMode: ActionRunMode,
  ): Promise<string> {
    switch (action.kind) {
      case "open_url": {
        if (action.newTab === false) {
          window.location.assign(action.url);
          return `Opened ${action.url} in current tab.`;
        }

        const opened = openUrlInNewTab(action.url);
        if (!opened) {
          throw new Error(
            runMode === "autopilot"
              ? "Popup blocked for automatic action. Tap Run to open it manually."
              : "Popup blocked. Allow popups and try again.",
          );
        }

        return `Opened ${action.url}`;
      }
      case "web_search": {
        const url = `https://www.google.com/search?q=${encodeURIComponent(action.query)}`;
        const opened = openUrlInNewTab(url);

        if (!opened) {
          throw new Error(
            runMode === "autopilot"
              ? "Popup blocked for automatic action. Tap Run to open it manually."
              : "Popup blocked. Allow popups and try again.",
          );
        }

        return `Searching web for: ${action.query}`;
      }
      case "open_map": {
        const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(action.query)}`;
        const opened = openUrlInNewTab(url);

        if (!opened) {
          throw new Error(
            runMode === "autopilot"
              ? "Popup blocked for automatic action. Tap Run to open it manually."
              : "Popup blocked. Allow popups and try again.",
          );
        }

        return `Opening map for: ${action.query}`;
      }
      case "send_email": {
        const queryParams = new URLSearchParams();
        if (action.subject) {
          queryParams.set("subject", action.subject);
        }
        if (action.body) {
          queryParams.set("body", action.body);
        }

        const query = queryParams.toString();
        const to = encodeURIComponent(action.to ?? "");
        const mailtoUrl = `mailto:${to}${query ? `?${query}` : ""}`;

        window.location.href = mailtoUrl;
        return "Opened your email composer.";
      }
      case "call_phone": {
        window.location.href = `tel:${action.phoneNumber}`;
        return `Opening dialer for ${action.phoneNumber}`;
      }
      case "send_sms": {
        const bodyPart = action.body
          ? `?body=${encodeURIComponent(action.body)}`
          : "";
        window.location.href = `sms:${action.phoneNumber}${bodyPart}`;
        return `Opening messages for ${action.phoneNumber}`;
      }
      case "copy_text": {
        if (!navigator.clipboard?.writeText) {
          throw new Error("Clipboard API is unavailable in this browser.");
        }

        await navigator.clipboard.writeText(action.text);
        return "Copied text to clipboard.";
      }
      case "share_text": {
        if (navigator.share) {
          await navigator.share({ text: action.text });
          return "Share sheet opened.";
        }

        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(action.text);
          return "Share API unavailable. Copied text instead.";
        }

        throw new Error("Share API is unavailable in this browser.");
      }
      case "set_timer": {
        const timerLabel = action.label?.trim() || "Raven timer";
        const completionMessage = `${timerLabel} is complete.`;

        window.setTimeout(() => {
          setMessages((currentMessages) => [
            ...currentMessages,
            {
              id: createMessageId(),
              role: "assistant",
              text: completionMessage,
              source: "text",
              createdAt: new Date().toISOString(),
            },
          ]);

          if (voicePlaybackRef.current) {
            const utterance = new SpeechSynthesisUtterance(completionMessage);
            utterance.rate = 0.96;
            utterance.pitch = 1;
            utterance.lang = "en-US";
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(utterance);
          }

          if (
            "Notification" in window &&
            Notification.permission === "granted"
          ) {
            new Notification("Raven Timer", { body: completionMessage });
          }
        }, action.seconds * 1000);

        if ("Notification" in window && Notification.permission === "default") {
          void Notification.requestPermission();
        }

        return `Timer set for ${action.seconds} seconds.`;
      }
      default:
        throw new Error("Unsupported action kind.");
    }
  }

  async function runQueuedAction(
    queuedActionId: string,
    action: AgentAction,
    runMode: ActionRunMode = "manual",
  ): Promise<void> {
    setErrorMessage("");

    setQueuedActions((currentActions) =>
      currentActions.map((queuedAction) =>
        queuedAction.id === queuedActionId
          ? { ...queuedAction, status: "running", detail: "" }
          : queuedAction,
      ),
    );

    try {
      const detail = await executeAgentAction(action, runMode);
      setQueuedActions((currentActions) =>
        currentActions.map((queuedAction) =>
          queuedAction.id === queuedActionId
            ? { ...queuedAction, status: "done", detail }
            : queuedAction,
        ),
      );

      setErrorMessage("");
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Action execution failed.";

      setQueuedActions((currentActions) =>
        currentActions.map((queuedAction) =>
          queuedAction.id === queuedActionId
            ? { ...queuedAction, status: "failed", detail }
            : queuedAction,
        ),
      );

      setErrorMessage(detail);
    }
  }

  function clearCompletedActions(): void {
    setQueuedActions((currentActions) =>
      currentActions.filter((action) => action.status !== "done"),
    );
  }

  function getActionStatusLabel(status: QueuedAction["status"]): string {
    switch (status) {
      case "pending":
        return "Pending";
      case "running":
        return "Running";
      case "done":
        return "Done";
      case "failed":
        return "Failed";
      default:
        return "Pending";
    }
  }

  async function submitPrompt(
    rawText: string,
    source: InputSource,
  ): Promise<void> {
    const text = rawText.trim();
    if (!text || isThinking) {
      return;
    }

    setErrorMessage("");

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      text,
      source,
      createdAt: new Date().toISOString(),
    };

    const historyForApi = [...messages, userMessage]
      .slice(-MAX_CONTEXT_MESSAGES)
      .map(({ role, text: messageText }) => ({ role, text: messageText }));

    setMessages((currentMessages) => [...currentMessages, userMessage]);

    if (source === "voice") {
      setLastTranscript(text);
    }

    setDraft("");
    setIsThinking(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: text,
          history: historyForApi,
        }),
      });

      const payload: {
        reply?: string;
        actions?: AgentAction[];
        model?: string;
        error?: string;
      } = await response.json();

      if (!response.ok) {
        throw new Error(
          payload.error ?? "Gemini could not generate a response.",
        );
      }

      const reply = (payload.reply ?? "").trim();
      if (!reply) {
        throw new Error("Gemini returned an empty response.");
      }

      const assistantMessage: ChatMessage = {
        id: createMessageId(),
        role: "assistant",
        text: reply,
        source: "text",
        createdAt: new Date().toISOString(),
      };

      setMessages((currentMessages) => [...currentMessages, assistantMessage]);

      const plannedActions = Array.isArray(payload.actions)
        ? payload.actions
        : [];

      if (plannedActions.length > 0) {
        const newQueuedActions: QueuedAction[] = plannedActions.map(
          (action) => ({
            id: createMessageId(),
            action,
            status: "pending",
            createdAt: new Date().toISOString(),
          }),
        );

        setQueuedActions((currentActions) => [
          ...newQueuedActions,
          ...currentActions,
        ]);

        if (autopilotEnabled) {
          newQueuedActions.forEach((queuedAction) => {
            if (!actionNeedsConfirmation(queuedAction.action)) {
              void runQueuedAction(
                queuedAction.id,
                queuedAction.action,
                "autopilot",
              );
            }
          });
        }
      }

      speakReply(reply);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected assistant error.";
      setErrorMessage(message);
    } finally {
      setIsThinking(false);
    }
  }

  async function startRecorderFallback(): Promise<void> {
    if (!supportsRecorderFallback || isThinking) {
      return;
    }

    try {
      setErrorMessage("");
      pendingTranscriptRef.current = "";

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const preferredMime = MediaRecorder.isTypeSupported(
        "audio/webm;codecs=opus",
      )
        ? "audio/webm;codecs=opus"
        : "";

      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;
      mediaChunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          mediaChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setErrorMessage("Recording failed. Please try again.");
        setIsListening(false);
        setUsingRecorderFallback(false);
      };

      recorder.onstop = async () => {
        setIsListening(false);
        setUsingRecorderFallback(false);

        const audioBlob = new Blob(mediaChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });

        mediaChunksRef.current = [];
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;

        if (!audioBlob.size) {
          setErrorMessage("No audio was captured.");
          return;
        }

        try {
          const transcript = await transcribeWithGemini(audioBlob);
          await submitPrompt(transcript, "voice");
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Audio processing failed.";
          setErrorMessage(message);
        }
      };

      recorder.start();
      setUsingRecorderFallback(true);
      setIsListening(true);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Microphone permission was denied or unavailable.";
      setErrorMessage(message);
      setIsListening(false);
      setUsingRecorderFallback(false);
    }
  }

  function startLiveRecognition(): void {
    const RecognitionCtor = getSpeechRecognitionCtor();
    if (!RecognitionCtor || isThinking) {
      return;
    }

    setErrorMessage("");
    pendingTranscriptRef.current = "";
    setLiveTranscript("");

    const recognition = new RecognitionCtor();
    recognitionRef.current = recognition;
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let interim = "";
      let finalText = "";

      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const fragment = result[0]?.transcript?.trim() ?? "";

        if (!fragment) {
          continue;
        }

        if (result.isFinal) {
          finalText = `${finalText} ${fragment}`.trim();
        } else {
          interim = `${interim} ${fragment}`.trim();
        }
      }

      setLiveTranscript(interim);

      if (finalText) {
        pendingTranscriptRef.current = finalText;
      }
    };

    recognition.onerror = (event: { error?: string }) => {
      const errorCode = event.error;
      if (errorCode === "network" && supportsRecorderFallback) {
        setPreferRecorderFallback(true);
      }

      setErrorMessage(
        getVoiceCaptureErrorMessage(errorCode, supportsRecorderFallback),
      );
      setIsListening(false);
      setLiveTranscript("");
    };

    recognition.onend = () => {
      setIsListening(false);
      setLiveTranscript("");

      const transcript = pendingTranscriptRef.current.trim();
      pendingTranscriptRef.current = "";

      if (transcript) {
        void submitPrompt(transcript, "voice");
      }
    };

    recognition.start();
    setIsListening(true);
  }

  function stopListening(): void {
    recognitionRef.current?.stop();

    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop();
    }

    if (!usingRecorderFallback) {
      setIsListening(false);
    }
  }

  async function handleOrbClick(): Promise<void> {
    if (isListening) {
      stopListening();
      return;
    }

    if (preferRecorderFallback && supportsRecorderFallback) {
      await startRecorderFallback();
      return;
    }

    if (supportsLiveRecognition) {
      startLiveRecognition();
      return;
    }

    if (supportsRecorderFallback) {
      await startRecorderFallback();
      return;
    }

    setErrorMessage(
      "Voice input is not supported by this browser. You can still type prompts below.",
    );
  }

  async function handleTextSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    await submitPrompt(draft, "text");
  }

  const statusText = isListening
    ? usingRecorderFallback
      ? "Recording... tap again to stop."
      : "Listening... speak naturally."
    : isThinking
      ? "Thinking and drafting your response..."
      : "Tap to start voice mode";

  return (
    <div className="app-shell">
      <div className="mesh mesh-1" />
      <div className="mesh mesh-2" />

      <main className="assistant-grid">
        <section className="assistant-panel">
          <p className="eyebrow">Gemini Pro Voice Agent</p>
          <h1>Raven</h1>
          <p className="subtitle">
            A private, personal voice assistant you can run on your laptop and
            phone through one Vercel URL.
          </p>

          <div className="orb-frame">
            <button
              type="button"
              className={`orb ${isListening ? "listening" : ""} ${isThinking ? "thinking" : ""}`}
              onClick={() => {
                void handleOrbClick();
              }}
              aria-pressed={isListening}
              aria-label="Toggle voice capture"
              disabled={isThinking && !isListening}
            >
              <span className="orb-core" />
            </button>
            <p className="status-text">{statusText}</p>
          </div>

          <label className="voice-toggle">
            <input
              type="checkbox"
              checked={voicePlaybackEnabled}
              onChange={(event) =>
                setVoicePlaybackEnabled(event.target.checked)
              }
            />
            <span>Play assistant replies aloud</span>
          </label>

          <div className="transcript-card">
            <h2>Live Transcript</h2>
            <p>
              {isListening
                ? liveTranscript || "Listening for your voice..."
                : lastTranscript ||
                  "Your latest spoken prompt will appear here."}
            </p>
          </div>

          <form className="prompt-form" onSubmit={handleTextSubmit}>
            <label htmlFor="typedPrompt">
              Type when voice is not convenient
            </label>
            <div className="prompt-row">
              <input
                id="typedPrompt"
                type="text"
                placeholder="Ask me anything..."
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={isBusy}
                autoComplete="off"
              />
              <button type="submit" disabled={!draft.trim() || isBusy}>
                Send
              </button>
            </div>
          </form>

          {errorMessage ? (
            <p className="error-banner" role="alert">
              {errorMessage}
            </p>
          ) : null}

          {supportsLiveRecognition && preferRecorderFallback ? (
            <p className="compat-note">
              Live speech recognition is temporarily unreachable on this
              network. Raven will record audio and use Gemini transcription for
              voice input.
            </p>
          ) : null}

          {!supportsLiveRecognition ? (
            <p className="compat-note">
              Live speech recognition is unavailable in this browser. Raven will
              record audio and ask Gemini to transcribe it after you stop.
            </p>
          ) : null}

          <section className="action-center">
            <div className="action-head">
              <h2>Action Center</h2>
              <button
                type="button"
                className="clear-actions"
                onClick={clearCompletedActions}
                disabled={queuedActions.every(
                  (action) => action.status !== "done",
                )}
              >
                Clear Done
              </button>
            </div>

            <label className="voice-toggle">
              <input
                type="checkbox"
                checked={autopilotEnabled}
                onChange={(event) => setAutopilotEnabled(event.target.checked)}
              />
              <span>Autopilot safe actions</span>
            </label>

            <p className="action-subtitle">
              Raven can plan and run actions on this device. Sensitive actions
              stay manual unless you run them.
            </p>

            {queuedActions.length === 0 ? (
              <p className="action-empty">No planned actions yet.</p>
            ) : (
              <ul className="action-list">
                {queuedActions.map((queuedAction) => (
                  <li
                    key={queuedAction.id}
                    className={`action-item ${queuedAction.status}`}
                  >
                    <p className="action-title">
                      {describeAgentAction(queuedAction.action)}
                    </p>

                    {queuedAction.detail ? (
                      <p className="action-detail">{queuedAction.detail}</p>
                    ) : null}

                    <div className="action-controls">
                      <span className={`action-status ${queuedAction.status}`}>
                        {getActionStatusLabel(queuedAction.status)}
                      </span>

                      {queuedAction.status !== "done" &&
                      queuedAction.status !== "running" ? (
                        <button
                          type="button"
                          onClick={() => {
                            void runQueuedAction(
                              queuedAction.id,
                              queuedAction.action,
                              "manual",
                            );
                          }}
                          disabled={isThinking}
                        >
                          Run
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <ul className="quick-prompts">
            {quickPrompts.map((prompt) => (
              <li key={prompt}>
                <button
                  type="button"
                  onClick={() => {
                    void submitPrompt(prompt, "text");
                  }}
                  disabled={isBusy}
                >
                  {prompt}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="chat-panel">
          <header>
            <h2>Conversation</h2>
            <span>{messages.length} messages</span>
          </header>

          <div className="chat-scroll" ref={chatScrollerRef}>
            {messages.length === 0 ? (
              <article className="empty-chat">
                Say hello to Raven. Voice and text prompts both work.
              </article>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`message ${message.role}`}>
                  <div className="message-meta">
                    <strong>{message.role === "user" ? "You" : "Raven"}</strong>
                    <time dateTime={message.createdAt}>
                      {formatClockTime(message.createdAt)}
                    </time>
                  </div>
                  <p>{message.text}</p>
                </article>
              ))
            )}

            {isThinking ? (
              <article className="message assistant pending">
                <div className="message-meta">
                  <strong>Raven</strong>
                  <span>...</span>
                </div>
                <p>Thinking...</p>
              </article>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
}
