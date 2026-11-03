document.addEventListener("DOMContentLoaded", () => {
"use strict";

// ==========================================
// ELEMENTS
// ==========================================

const $ = id => document.getElementById(id);

const messageInput = $("messageInput");
const sendBtn = $("sendBtn");
const messagesContainer = $("messagesContainer");
const welcomeScreen = $("welcomeScreen");
const chatArea = $("chatArea");
const newChatBtn = $("newChatBtn");
const clearChatBtn = $("clearChatBtn");
const voiceBtn = $("voiceBtn");
const sidebar = $("sidebar");
const menuBtn = $("menuBtn");
const closeSidebar = $("closeSidebar");
const historyEl = $("chatHistory");
const inputHint = document.querySelector(".input-hint");

if (!messageInput || !sendBtn || !messagesContainer || !welcomeScreen || !chatArea) {
    console.error("Rex Ai: required elements are missing from the page.");
    return;
}

// ==========================================
// SETTINGS & STATE
// ==========================================

const STORAGE_KEY = "rexai.chats.v1";
const THEME_KEY = "rexai.theme";
const MAX_CHATS = 30;
const MAX_HISTORY_SENT = 20;
const MAX_INPUT_LENGTH = 4000;
const REQUEST_TIMEOUT_MS = 60000;

const sendIdleHTML = sendBtn.innerHTML;
const hintDefault = inputHint ? inputHint.textContent : "";

let chats = loadChats();
let activeChatId = null;
let isLoading = false;
let csrfToken = null;
let abortController = null;
let stickToBottom = true;

messageInput.maxLength = MAX_INPUT_LENGTH;
sendBtn.setAttribute("aria-label", "Send message");

// ==========================================
// THEME (dark / light toggle, injected into the top bar)
// ==========================================

function getSavedTheme() {
    try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; }
    catch { return "dark"; }
}

function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", theme === "light" ? "#f3f6fb" : "#060a12");
    if (themeBtn) {
        themeBtn.textContent = theme === "light" ? "☾" : "☀";
        themeBtn.title = theme === "light" ? "Switch to dark theme" : "Switch to light theme";
        themeBtn.setAttribute("aria-label", themeBtn.title);
    }
}

const themeBtn = document.createElement("button");
themeBtn.type = "button";
themeBtn.className = "top-action theme-toggle";

const topbar = document.querySelector(".topbar");
if (topbar && clearChatBtn) {
    const right = document.createElement("div");
    right.className = "topbar-right";
    topbar.insertBefore(right, clearChatBtn);
    right.append(themeBtn, clearChatBtn);
}

themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch {}
});

applyTheme(getSavedTheme());

// ==========================================
// STORAGE
// ==========================================

function loadChats() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
        if (!Array.isArray(raw)) return [];
        return raw
            .filter(c => c && typeof c.id === "number" && Array.isArray(c.messages))
            .slice(0, MAX_CHATS);
    } catch {
        return [];
    }
}

function saveChats() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
    } catch (error) {
        console.warn("Could not save chats:", error);
    }
}

const getActiveChat = () => chats.find(c => c.id === activeChatId) || null;
const getMessages = () => getActiveChat()?.messages ?? [];

// ==========================================
// SECURITY TOKEN
// ==========================================

async function fetchCsrfToken() {
    const response = await fetch("/api/csrf-token", { credentials: "same-origin" });
    const data = await response.json();
    if (!response.ok || !data.csrf_token) throw new Error("Could not initialize security token.");
    csrfToken = data.csrf_token;
    return csrfToken;
}

async function initialize() {
    try {
        await fetchCsrfToken();
    } catch (error) {
        console.error("Initialization error:", error);
        showToast("Could not initialize Rex Ai. Refresh the page.");
    }
}

// ==========================================
// TOAST
// ==========================================

let toastEl = null;
let toastTimer = null;

function showToast(message) {
    if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.className = "toast";
        toastEl.setAttribute("role", "status");
        toastEl.setAttribute("aria-live", "polite");
        document.body.appendChild(toastEl);
    }

    toastEl.textContent = message;
    requestAnimationFrame(() => toastEl.classList.add("show"));

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2800);
}

// ==========================================
// CLIPBOARD
// ==========================================

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        try {
            const area = document.createElement("textarea");
            area.value = text;
            area.style.cssText = "position:fixed;opacity:0;";
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand("copy");
            area.remove();
            return ok;
        } catch {
            return false;
        }
    }
}

// ==========================================
// MARKDOWN
// ==========================================

function renderMarkdown(element, content) {
    if (!window.marked || !window.DOMPurify) {
        element.textContent = content;
        return;
    }

    const html = marked.parse(content, { breaks: true, gfm: true });
    element.innerHTML = DOMPurify.sanitize(html);

    element.querySelectorAll("pre").forEach(pre => {
        const code = pre.querySelector("code");
        if (code && window.hljs) hljs.highlightElement(code);

        // language label (top-left of the code block)
        const lang = (code?.className.match(/language-([\w+#-]+)/) || [])[1];
        if (lang) {
            const label = document.createElement("span");
            label.className = "code-lang";
            label.textContent = lang;
            pre.appendChild(label);
        }

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "code-copy";
        btn.textContent = "Copy";
        btn.addEventListener("click", async () => {
            const ok = await copyText((code || pre).textContent);
            btn.textContent = ok ? "Copied ✓" : "Failed";
            setTimeout(() => (btn.textContent = "Copy"), 1600);
        });
        pre.appendChild(btn);
    });

    element.querySelectorAll("a").forEach(link => {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
    });
}

// ==========================================
// SCROLLING
// ==========================================

const scrollDownBtn = document.createElement("button");
scrollDownBtn.type = "button";
scrollDownBtn.className = "scroll-down-btn";
scrollDownBtn.setAttribute("aria-label", "Scroll to latest message");
scrollDownBtn.textContent = "↓";
(chatArea.parentElement || document.body).appendChild(scrollDownBtn);

function isNearBottom() {
    return chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 120;
}

function scrollToBottom(force = false, smooth = true) {
    if (!force && !stickToBottom) return;
    requestAnimationFrame(() => {
        chatArea.scrollTo({ top: chatArea.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    });
}

chatArea.addEventListener("scroll", () => {
    stickToBottom = isNearBottom();
    scrollDownBtn.classList.toggle("show", !stickToBottom && messagesContainer.style.display !== "none");
}, { passive: true });

scrollDownBtn.addEventListener("click", () => {
    stickToBottom = true;
    scrollToBottom(true);
});

// ==========================================
// SIDEBAR (with overlay for mobile)
// ==========================================

const overlay = document.createElement("div");
overlay.className = "sidebar-overlay";
document.body.appendChild(overlay);

function openSidebar() {
    sidebar?.classList.add("open");
    overlay.classList.add("show");
}

function hideSidebar() {
    sidebar?.classList.remove("open");
    overlay.classList.remove("show");
}

menuBtn?.addEventListener("click", openSidebar);
closeSidebar?.addEventListener("click", hideSidebar);
overlay.addEventListener("click", hideSidebar);

// ==========================================
// INPUT (auto-resize, ready state, character counter)
// ==========================================

function autoResize() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + "px";

    const length = messageInput.value.length;
    sendBtn.classList.toggle("is-ready", length > 0);

    if (inputHint) {
        if (length > MAX_INPUT_LENGTH * 0.8) {
            inputHint.textContent = `${length} / ${MAX_INPUT_LENGTH}`;
            inputHint.classList.add("warn");
        } else {
            inputHint.textContent = hintDefault;
            inputHint.classList.remove("warn");
        }
    }
}

messageInput.addEventListener("input", autoResize);

// ==========================================
// MESSAGES
// ==========================================

function addMessage(role, content, { animate = true, isError = false, reveal = false } = {}) {
    const message = document.createElement("div");
    message.className = `message ${role}${isError ? " error" : ""}`;

    if (animate) {
        message.style.opacity = "0";
        message.style.transform = "translateY(16px)";
    }

    if (role === "assistant") {
        const avatar = document.createElement("div");
        avatar.className = "message-avatar";
        avatar.textContent = "R";
        avatar.setAttribute("aria-hidden", "true");
        message.appendChild(avatar);
    }

    const messageContent = document.createElement("div");
    messageContent.className = "message-content";

    if (role === "assistant") {
        const name = document.createElement("div");
        name.className = "message-name";
        name.textContent = "REX AI";
        messageContent.appendChild(name);
    }

    const text = document.createElement("div");
    text.className = "message-text";

    if (role === "assistant" && !isError) {
        renderMarkdown(text, content);
        if (reveal) {
            // each block (paragraph, list, code...) fades in one after another
            text.classList.add("reveal");
            [...text.children].forEach((el, i) => el.style.setProperty("--i", Math.min(i, 14)));
        }
    } else {
        text.textContent = content;
    }

    messageContent.appendChild(text);

    if (role === "assistant" && !isError) {
        const actions = document.createElement("div");
        actions.className = "message-actions";

        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", async () => {
            const ok = await copyText(content);
            showToast(ok ? "Response copied!" : "Could not copy response.");
            if (ok) {
                copyBtn.textContent = "Copied ✓";
                setTimeout(() => (copyBtn.textContent = "Copy"), 1600);
            }
        });

        actions.appendChild(copyBtn);
        messageContent.appendChild(actions);
    }

    message.appendChild(messageContent);
    messagesContainer.appendChild(message);

    if (animate) {
        requestAnimationFrame(() => {
            message.style.transition =
                "opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1), transform 0.45s cubic-bezier(0.22, 1, 0.36, 1)";
            message.style.opacity = "1";
            message.style.transform = "translateY(0)";
        });
    }

    return message;
}

// Only the latest good assistant reply gets a Regenerate button.
function refreshRegenerateButton() {
    messagesContainer.querySelectorAll(".regen-btn").forEach(btn => btn.remove());
    if (isLoading) return;

    const last = messagesContainer.lastElementChild;
    if (!last || !last.classList.contains("assistant") || last.classList.contains("error")) return;

    const actions = last.querySelector(".message-actions");
    if (!actions) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "regen-btn";
    btn.textContent = "↻ Regenerate";
    btn.addEventListener("click", regenerate);
    actions.appendChild(btn);
}

// ==========================================
// TYPING INDICATOR
// ==========================================

function showTyping() {
    removeTyping(true);

    const typing = document.createElement("div");
    typing.className = "message assistant";
    typing.id = "typingIndicator";
    typing.innerHTML = `
        <div class="message-avatar" aria-hidden="true">R</div>
        <div class="message-content">
            <div class="message-name">REX AI</div>
            <div class="typing-indicator" role="status" aria-label="Rex Ai is thinking">
                <span></span><span></span><span></span>
            </div>
        </div>
    `;
    messagesContainer.appendChild(typing);
    scrollToBottom(true);
}

function removeTyping(immediate = false) {
    const typing = $("typingIndicator");
    if (!typing) return;

    if (immediate) {
        typing.remove();
        return;
    }

    typing.id = "";
    typing.style.transition = "opacity 0.25s ease, transform 0.25s ease";
    typing.style.opacity = "0";
    typing.style.transform = "translateY(8px)";
    setTimeout(() => typing.remove(), 260);
}

// ==========================================
// WELCOME SCREEN / VIEW STATE
// ==========================================

function showChatView() {
    welcomeScreen.style.display = "none";
    messagesContainer.style.display = "block";
}

function showWelcomeView() {
    messagesContainer.replaceChildren();
    messagesContainer.style.display = "none";
    scrollDownBtn.classList.remove("show");

    welcomeScreen.style.display = "flex";
    welcomeScreen.style.animation = "none";
    void welcomeScreen.offsetWidth;
    welcomeScreen.style.animation = "";
}

// ==========================================
// CHAT HISTORY (saved in the browser)
// ==========================================

function renderHistory() {
    if (!historyEl) return;
    historyEl.replaceChildren();

    if (chats.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-history";
        empty.textContent = "Your conversations will show up here.";
        historyEl.appendChild(empty);
        return;
    }

    chats.forEach((chat, i) => {
        const row = document.createElement("div");
        row.className = "history-row" + (chat.id === activeChatId ? " active" : "");

        const item = document.createElement("button");
        item.type = "button";
        item.className = "history-item";
        item.textContent = chat.title;
        item.title = chat.title;
        item.addEventListener("click", () => openChat(chat.id));

        const del = document.createElement("button");
        del.type = "button";
        del.className = "history-delete";
        del.textContent = "×";
        del.setAttribute("aria-label", `Delete chat: ${chat.title}`);
        del.addEventListener("click", event => {
            event.stopPropagation();
            deleteChat(chat.id);
        });

        row.append(item, del);
        row.style.opacity = "0";
        row.style.transform = "translateX(-8px)";
        historyEl.appendChild(row);

        setTimeout(() => {
            row.style.transition = "opacity 0.3s ease, transform 0.3s ease";
            row.style.opacity = "1";
            row.style.transform = "translateX(0)";
        }, i * 25);
    });
}

function openChat(id) {
    if (isLoading) {
        showToast("Wait for the reply to finish, or press stop.");
        return;
    }

    const chat = chats.find(c => c.id === id);
    if (!chat) return;

    activeChatId = id;
    messagesContainer.replaceChildren();
    showChatView();

    chat.messages.forEach(m => addMessage(m.role, m.content, { animate: false }));
    refreshRegenerateButton();

    stickToBottom = true;
    scrollToBottom(true, false);
    renderHistory();
    hideSidebar();
}

function deleteChat(id) {
    if (isLoading && id === activeChatId) return;

    chats = chats.filter(c => c.id !== id);
    saveChats();

    if (id === activeChatId) {
        activeChatId = null;
        showWelcomeView();
    }
    renderHistory();
}

function resetChat() {
    if (isLoading) return;

    activeChatId = null;
    showWelcomeView();
    renderHistory();

    messageInput.value = "";
    autoResize();
    messageInput.focus();
    hideSidebar();
}

// ==========================================
// API
// ==========================================

async function requestReply(message, history, signal, retried = false) {
    const response = await fetch("/api/chat", {
        method: "POST",
        credentials: "same-origin",
        signal,
        headers: {
            "Content-Type": "application/json",
            "X-CSRFToken": csrfToken
        },
        body: JSON.stringify({ message, history })
    });

    let data = {};
    try {
        data = await response.json();
    } catch {
        // server returned something that isn't JSON (e.g. an HTML error page)
    }

    // token expired? get a fresh one and try once more
    if ((response.status === 400 || response.status === 403) && !retried) {
        await fetchCsrfToken();
        return requestReply(message, history, signal, true);
    }

    if (!response.ok) {
        throw new Error(data.error || `Server error (${response.status}).`);
    }
    if (!data.reply) {
        throw new Error("Rex Ai returned an empty response.");
    }
    return data.reply;
}

// ==========================================
// LOADING STATE (send button turns into stop)
// ==========================================

function setLoading(state) {
    isLoading = state;

    if (state) {
        sendBtn.classList.add("is-stop");
        sendBtn.textContent = "■";
        sendBtn.setAttribute("aria-label", "Stop generating");
    } else {
        sendBtn.classList.remove("is-stop");
        sendBtn.innerHTML = sendIdleHTML;
        sendBtn.setAttribute("aria-label", "Send message");
    }
    sendBtn.disabled = false;
}

// ==========================================
// SEND
// ==========================================

async function sendMessage(customMessage = null) {
    const message = (customMessage !== null ? customMessage : messageInput.value).trim();
    if (!message || isLoading) return;

    if (message.length > MAX_INPUT_LENGTH) {
        showToast(`Message is too long (max ${MAX_INPUT_LENGTH} characters).`);
        return;
    }

    if (!navigator.onLine) {
        showToast("You're offline. Check your connection.");
        return;
    }

    if (!csrfToken) {
        try {
            await fetchCsrfToken();
        } catch {
            showToast("Rex Ai is still initializing. Try again.");
            return;
        }
    }

    showChatView();
    addMessage("user", message);

    if (customMessage === null) {
        messageInput.value = "";
        autoResize();
    }

    stickToBottom = true;
    setLoading(true);
    refreshRegenerateButton();
    showTyping();

    abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort("timeout"), REQUEST_TIMEOUT_MS);

    const history = getMessages().slice(-MAX_HISTORY_SENT);

    try {
        const reply = await requestReply(message, history, abortController.signal);
        removeTyping();

        addMessage("assistant", reply, { reveal: true });

        // create the chat only once we have a successful reply
        let chat = getActiveChat();
        if (!chat) {
            chat = { id: Date.now(), title: message.slice(0, 40), updated: Date.now(), messages: [] };
            chats.unshift(chat);
            chats = chats.slice(0, MAX_CHATS);
            activeChatId = chat.id;
        }

        chat.messages.push(
            { role: "user", content: message },
            { role: "assistant", content: reply }
        );
        chat.updated = Date.now();

        chats.sort((a, b) => b.updated - a.updated);

        saveChats();
        renderHistory();
    } catch (error) {
        removeTyping();

        if (error.name === "AbortError") {
            const timedOut = abortController.signal.reason === "timeout";
            addMessage("assistant", timedOut
                ? "That took too long. Please try again."
                : "Generation stopped.", { isError: true });
        } else {
            console.error("Chat error:", error);
            addMessage("assistant", "Sorry, something went wrong: " + error.message, { isError: true });
        }
    } finally {
        clearTimeout(timeout);
        abortController = null;
        setLoading(false);
        refreshRegenerateButton();
        scrollToBottom();
        if (customMessage === null) messageInput.focus();
    }
}

function regenerate() {
    if (isLoading) return;

    const chat = getActiveChat();
    if (!chat || chat.messages.length < 2) return;

    const lastUser = chat.messages[chat.messages.length - 2];
    if (!lastUser || lastUser.role !== "user") return;

    chat.messages.splice(-2);
    saveChats();

    [...messagesContainer.querySelectorAll(".message")].slice(-2).forEach(node => node.remove());

    sendMessage(lastUser.content);
}

// ==========================================
// EVENT LISTENERS
// ==========================================

sendBtn.addEventListener("click", () => {
    if (isLoading) {
        abortController?.abort("user");
        return;
    }
    sendMessage();
});

messageInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendMessage();
    }
});

document.querySelectorAll(".suggestion-card").forEach(card => {
    card.addEventListener("click", () => {
        const prompt = card.dataset.prompt;
        if (prompt) sendMessage(prompt);
    });
});

newChatBtn?.addEventListener("click", resetChat);
clearChatBtn?.addEventListener("click", resetChat);

// ==========================================
// VOICE PREVIEW (speaker button in the composer)
// ==========================================

let voicePreviewAudio = null;
let voicePreviewUrl = null;

async function previewRexFemaleVoice() {
    if (voicePreviewAudio && !voicePreviewAudio.paused) {
        voicePreviewAudio.pause();
        voicePreviewAudio.currentTime = 0;
        showToast("Voice preview stopped.");
        return;
    }

    if (voiceBtn) voiceBtn.disabled = true;
    try {
        if (!csrfToken) await fetchCsrfToken();

        const response = await fetch("/api/voice/speak", {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
                "X-CSRFToken": csrfToken
            },
            body: JSON.stringify({
                text: "Hi, I'm Rex Ai. It's lovely to talk with you. What would you like to explore today?"
            })
        });

        if (!response.ok) {
            let message = "Could not generate the voice preview.";
            try {
                const errorData = await response.json();
                message = errorData.error || message;
            } catch (_) {}
            throw new Error(message);
        }

        const audioBlob = await response.blob();
        if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
        voicePreviewUrl = URL.createObjectURL(audioBlob);
        voicePreviewAudio = new Audio(voicePreviewUrl);
        voicePreviewAudio.addEventListener("ended", () => {
            if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
            voicePreviewUrl = null;
            voicePreviewAudio = null;
        }, { once: true });
        await voicePreviewAudio.play();
        showToast("Rex Ai's female voice is playing.");
    } catch (error) {
        console.error("Rex Ai voice preview error:", error);
        showToast(error.message || "Voice preview failed.");
    } finally {
        if (voiceBtn) voiceBtn.disabled = false;
    }
}

voiceBtn?.addEventListener("click", previewRexFemaleVoice);

// ==========================================
// FULL-SCREEN VOICE ASSISTANT
// ==========================================

const jarvisScreen = $("jarvisScreen");
const jarvisBack = $("jarvisBack");
const jarvisShortcut = $("voiceShortcut");

function openJarvisMode() {
    if (!jarvisScreen) return;
    hideSidebar();
    jarvisScreen.classList.add("is-open");
    jarvisScreen.setAttribute("aria-hidden", "false");
    document.body.classList.add("jarvis-active");
    jarvisBack?.focus();
}

function closeJarvisMode() {
    if (!jarvisScreen) return;
    if (jarvisActive) stopJarvisSession();
    jarvisScreen.classList.remove("is-open");
    jarvisScreen.setAttribute("aria-hidden", "true");
    document.body.classList.remove("jarvis-active");
    jarvisShortcut?.focus();
}

jarvisShortcut?.addEventListener("click", openJarvisMode);
jarvisBack?.addEventListener("click", closeJarvisMode);

// record -> transcribe -> chat -> speak -> listen again
const jarvisMic = $("jarvisMic");
const jarvisStop = $("jarvisStop");
const jarvisStatus = $("jarvisStatus");
const jarvisPrompt = $("jarvisPrompt");
const jarvisTranscript = $("jarvisTranscript");
const jarvisCaption = $("jarvisControlCaption");
const jarvisComposer = $("jarvisComposer");
const jarvisTextInput = $("jarvisTextInput");
const jarvisSend = $("jarvisSend");
let jarvisActive = false;
let jarvisRecording = false;
let jarvisRecorder = null;
let jarvisStream = null;
let jarvisChunks = [];
let jarvisConversationId = null;
let jarvisAudio = null;
let jarvisAudioUrl = null;
let jarvisTurnBusy = false;
let jarvisAutoListen = false;
let jarvisDiscardRecording = false;
let jarvisTurnId = 0;

function jarvisState(state, prompt) {
    if (jarvisStatus) jarvisStatus.textContent = state;
    if (jarvisPrompt && prompt) jarvisPrompt.textContent = prompt;
    jarvisScreen?.classList.remove("is-listening", "is-thinking", "is-speaking");
    if (state === "LISTENING") jarvisScreen?.classList.add("is-listening");
    if (state === "THINKING") jarvisScreen?.classList.add("is-thinking");
    if (state === "SPEAKING") jarvisScreen?.classList.add("is-speaking");
}

function jarvisTranscriptLine(role, content) {
    // the empty-state placeholder in index.html is a class, not an id
    jarvisTranscript?.querySelector(".jarvis-transcript-empty")?.remove();

    const line = document.createElement("div");
    line.className = `jarvis-line ${role}`;
    const label = document.createElement("span");
    label.className = "jarvis-line-label";
    label.textContent = role === "user" ? "YOU" : "REX AI";
    const body = document.createElement("p");
    body.textContent = content;
    line.append(label, body);
    jarvisTranscript?.appendChild(line);
    if (jarvisTranscript) jarvisTranscript.scrollTop = jarvisTranscript.scrollHeight;
}

function stopJarvisAudio() {
    if (jarvisAudio) { jarvisAudio.pause(); jarvisAudio.src = ""; jarvisAudio = null; }
    if (jarvisAudioUrl) { URL.revokeObjectURL(jarvisAudioUrl); jarvisAudioUrl = null; }
}

function stopJarvisSession() {
    jarvisActive = false;
    jarvisAutoListen = false;
    jarvisRecording = false;
    jarvisTurnBusy = false;
    jarvisTurnId++;
    jarvisDiscardRecording = true;
    if (jarvisRecorder && jarvisRecorder.state !== "inactive") jarvisRecorder.stop();
    jarvisRecorder = null;
    jarvisStream?.getTracks().forEach(track => track.stop());
    jarvisStream = null;
    stopJarvisAudio();
    if (jarvisMic) { jarvisMic.disabled = false; jarvisMic.classList.remove("recording"); }
    if (jarvisStop) jarvisStop.disabled = true;
    if (jarvisCaption) jarvisCaption.textContent = "TAP THE MICROPHONE TO START · OR TYPE BELOW";
    jarvisState("SYSTEM STANDBY", "Your voice session has ended.");
}

async function startJarvisRecording() {
    if (!jarvisActive || jarvisTurnBusy) return;
    try {
        const activeStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        jarvisStream = activeStream;
        const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(type => window.MediaRecorder && MediaRecorder.isTypeSupported(type));
        const recordingChunks = [];
        jarvisChunks = recordingChunks;
        jarvisDiscardRecording = false;
        jarvisRecorder = mime ? new MediaRecorder(activeStream, { mimeType: mime }) : new MediaRecorder(activeStream);
        jarvisRecorder.ondataavailable = event => { if (event.data && event.data.size) recordingChunks.push(event.data); };
        const activeRecorder = jarvisRecorder;
        activeRecorder.onstop = () => {
            activeStream.getTracks().forEach(track => track.stop());
            if (jarvisStream === activeStream) jarvisStream = null;
            const blob = new Blob(recordingChunks, { type: activeRecorder.mimeType || "audio/webm" });
            if (jarvisRecorder === activeRecorder) jarvisRecorder = null;
            jarvisRecording = false;
            if (jarvisDiscardRecording) { jarvisDiscardRecording = false; return; }
            if (jarvisActive && blob.size) processJarvisRecording(blob);
        };
        jarvisRecorder.start(250);
        jarvisRecording = true;
        if (jarvisMic) jarvisMic.disabled = false;
        jarvisMic?.classList.add("recording");
        jarvisState("LISTENING", "I'm listening. Tap the microphone when you've finished speaking.");
        if (jarvisCaption) jarvisCaption.textContent = "TAP MICROPHONE WHEN YOU'RE DONE";
    } catch (error) {
        console.error("Microphone error:", error);
        showToast("Microphone access is needed. Allow it in your browser settings.");
        stopJarvisSession();
    }
}

function cleanTextForSpeech(markdown) {
    if (!markdown) return "";
    let text = String(markdown);

    text = text.replace(/```[\s\S]*?```/g, "\nI've included a code example in the chat.\n");
    text = text.replace(/~~~[\s\S]*?~~~/g, "\nI've included a code example in the chat.\n");

    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1");
    text = text.replace(/<https?:\/\/[^>]+>/g, " ");
    text = text.replace(/https?:\/\/\S+/gi, " ");

    text = text.replace(/`([^`]+)`/g, "$1");

    text = text.replace(/^\s{0,3}#{1,6}\s*(.+?)\s*#*\s*$/gm, "\n$1.\n");
    text = text.replace(/^\s*>\s?/gm, "");
    text = text.replace(/^\s*(?:[-*_]\s*){3,}$/gm, "\n");

    text = text.replace(/^\s*(\d+)[.)]\s+/gm, "Item $1: ");
    text = text.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "");
    text = text.replace(/^\s*[-*+]\s+/gm, "");

    text = text.replace(/\*\*(.*?)\*\*/gs, "$1");
    text = text.replace(/__(.*?)__/gs, "$1");
    text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1");
    text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1");
    text = text.replace(/~~(.*?)~~/gs, "$1");

    text = text.replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, "");
    text = text.replace(/^\s*\|/gm, "").replace(/\|\s*$/gm, "");
    text = text.replace(/\s*\|\s*/g, ", ");

    text = text.replace(/<[^>]*>/g, " ");
    text = text.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, " and ")
        .replace(/&lt;/gi, " less than ").replace(/&gt;/gi, " greater than ")
        .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");

    text = text.replace(/(^|\s)#(?=[\p{L}\p{N}_])/gu, "$1");
    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/[ \t*#_`]+\n/g, "\n");
    text = text.replace(/\n[ \t]+/g, "\n");
    text = text.replace(/\n{3,}/g, "\n\n");
    return text.trim();
}

async function speakJarvisReply(markdown, turnId = jarvisTurnId) {
    const cleaned = cleanTextForSpeech(markdown);
    if (!cleaned) return;

    // Orpheus accepts at most 200 characters per request.
    const paragraphs = cleaned.split(/\n{1,}/).map(part => part.trim()).filter(Boolean);
    const chunks = [];
    for (const paragraph of paragraphs) {
        let remaining = paragraph;
        while (remaining.length > 195) {
            let cut = -1;
            for (const boundary of [". ", "? ", "! ", "; ", ": ", ", ", " "]) {
                const candidate = remaining.lastIndexOf(boundary, 190);
                if (candidate >= 80) { cut = candidate + (boundary === " " ? 0 : 1); break; }
            }
            if (cut < 1) cut = 190;
            chunks.push(remaining.slice(0, cut).trim());
            remaining = remaining.slice(cut).trim();
        }
        if (remaining) chunks.push(remaining);
    }

    for (let index = 0; index < chunks.length; index++) {
        if (turnId !== jarvisTurnId) return;
        const response = await fetch("/api/voice/speak", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken },
            body: JSON.stringify({ text: chunks[index] })
        });
        if (!response.ok) {
            let message = "Rex couldn't generate voice audio.";
            try { message = (await response.json()).error || message; } catch (_) {}
            throw new Error(message);
        }
        const blob = await response.blob();
        if (turnId !== jarvisTurnId) return;
        stopJarvisAudio();
        jarvisAudioUrl = URL.createObjectURL(blob);
        jarvisAudio = new Audio(jarvisAudioUrl);
        jarvisState("SPEAKING", "Speaking your complete answer...");
        await new Promise((resolve, reject) => {
            jarvisAudio.onended = resolve;
            jarvisAudio.onerror = () => reject(new Error("Audio playback failed."));
            jarvisAudio.play().catch(reject);
        });
        stopJarvisAudio();
        if (index < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 180));
        }
    }
}

async function sendJarvisMessage(message, source = "typed") {
    const text = String(message || "").trim();
    if (!text) return;
    if (jarvisTurnBusy && jarvisStatus?.textContent === "THINKING") {
        showToast("Rex is still preparing the previous answer. Please wait a moment.");
        return;
    }

    const turnId = ++jarvisTurnId;
    stopJarvisAudio();
    if (jarvisRecording && jarvisRecorder?.state === "recording") {
        jarvisDiscardRecording = true;
        try { jarvisRecorder.stop(); } catch (_) {}
        jarvisRecording = false;
        jarvisMic?.classList.remove("recording");
    }
    jarvisTurnBusy = true;
    if (jarvisSend) jarvisSend.disabled = true;
    jarvisTranscriptLine("user", text);
    jarvisState("THINKING", "Let me think that through...");
    if (jarvisCaption) jarvisCaption.textContent = source === "voice" ? "PROCESSING YOUR VOICE" : "PROCESSING YOUR MESSAGE";

    try {
        if (!csrfToken) await fetchCsrfToken();
        const chatResponse = await fetch("/api/chat", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken },
            body: JSON.stringify({ message: text, conversation_id: jarvisConversationId })
        });
        const chatData = await chatResponse.json();
        if (!chatResponse.ok) throw new Error(chatData.error || "Rex couldn't answer that.");
        if (turnId !== jarvisTurnId) return;
        jarvisConversationId = chatData.conversation_id;
        jarvisTranscriptLine("assistant", chatData.reply);
        await speakJarvisReply(chatData.reply, turnId);
        if (turnId !== jarvisTurnId) return;
        jarvisTurnBusy = false;
        if (jarvisCaption) jarvisCaption.textContent = jarvisAutoListen ? "READY — I'M LISTENING AGAIN" : "YOU CAN TYPE OR TAP THE MICROPHONE TO CONTINUE";
        if (jarvisAutoListen && jarvisActive) await startJarvisRecording();
        else jarvisState("STANDING BY", "Your answer is ready. Type another message or start the microphone.");
    } catch (error) {
        if (turnId !== jarvisTurnId) return;
        console.error("Voice message error:", error);
        jarvisState("VOICE SYSTEM NOTICE", error.message || "Something went wrong.");
        if (jarvisCaption) jarvisCaption.textContent = "YOU CAN TRY AGAIN OR TYPE A MESSAGE";
        showToast(error.message || "Rex couldn't complete that request.");
    } finally {
        if (turnId === jarvisTurnId) {
            jarvisTurnBusy = false;
            if (jarvisSend) jarvisSend.disabled = false;
        }
    }
}

async function processJarvisRecording(blob) {
    if (!jarvisActive || jarvisTurnBusy) return;
    jarvisTurnBusy = true;
    jarvisMic?.classList.remove("recording");
    if (jarvisCaption) jarvisCaption.textContent = "PROCESSING YOUR VOICE";
    jarvisState("THINKING", "Converting your speech into text...");
    try {
        if (!csrfToken) await fetchCsrfToken();
        const form = new FormData();
        const ext = blob.type.includes("mp4") ? "m4a" : "webm";
        form.append("audio", blob, `rex-voice.${ext}`);
        const stt = await fetch("/api/voice/transcribe", {
            method: "POST", credentials: "same-origin", headers: { "X-CSRFToken": csrfToken }, body: form
        });
        const sttData = await stt.json();
        if (!stt.ok) throw new Error(sttData.error || "Speech recognition failed.");
        const spokenText = (sttData.text || "").trim();
        if (!spokenText) throw new Error("I didn't catch that. Please try speaking again.");
        jarvisTurnBusy = false;
        await sendJarvisMessage(spokenText, "voice");
    } catch (error) {
        console.error("Transcription error:", error);
        jarvisTurnBusy = false;
        jarvisState("VOICE SYSTEM NOTICE", error.message || "Speech recognition failed.");
        if (jarvisCaption) jarvisCaption.textContent = "TAP THE MICROPHONE TO TRY AGAIN, OR TYPE BELOW";
        showToast(error.message || "I couldn't understand that recording.");
        if (jarvisAutoListen && jarvisActive) setTimeout(() => startJarvisRecording(), 500);
    }
}

jarvisComposer?.addEventListener("submit", event => {
    event.preventDefault();
    const text = jarvisTextInput?.value || "";
    if (!text.trim()) return;
    jarvisTextInput.value = "";
    jarvisTextInput.style.height = "auto";
    sendJarvisMessage(text, "typed");
});
jarvisTextInput?.addEventListener("input", () => {
    jarvisTextInput.style.height = "auto";
    jarvisTextInput.style.height = `${Math.min(jarvisTextInput.scrollHeight, 120)}px`;
});
jarvisTextInput?.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        jarvisComposer?.requestSubmit();
    }
});

jarvisMic?.addEventListener("click", async () => {
    if (!jarvisActive) {
        jarvisActive = true;
        jarvisAutoListen = true;
        jarvisMic.disabled = true;
        if (jarvisStop) jarvisStop.disabled = false;
        jarvisState("INITIALIZING", "Requesting microphone access...");
        try {
            if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access requires localhost or a secure HTTPS connection.");
            if (!csrfToken) await fetchCsrfToken();
            await startJarvisRecording();
        } catch (error) {
            jarvisState("UNABLE TO START", error.message);
            jarvisActive = false;
            jarvisMic.disabled = false;
            if (jarvisStop) jarvisStop.disabled = true;
        }
        return;
    }
    if (jarvisRecording && jarvisRecorder?.state === "recording") {
        jarvisRecording = false;
        jarvisMic.disabled = true;
        jarvisRecorder.stop();
    } else if (jarvisActive && !jarvisTurnBusy) {
        jarvisAutoListen = true;
        await startJarvisRecording();
    }
});
jarvisStop?.addEventListener("click", stopJarvisSession);

// ==========================================
// KEYBOARD SHORTCUTS
// ==========================================
//   ⌘/Ctrl + K  new chat      /  focus the message box      Esc  close sidebar / voice mode

function isTypingTarget(el) {
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        resetChat();
    } else if (event.key === "/" && !isTypingTarget(document.activeElement) && !jarvisScreen?.classList.contains("is-open")) {
        event.preventDefault();
        messageInput.focus();
    } else if (event.key === "Escape") {
        if (jarvisScreen?.classList.contains("is-open")) {
            closeJarvisMode();
        } else {
            hideSidebar();
        }
    }
});

window.addEventListener("offline", () => showToast("You're offline."));
window.addEventListener("online", () => showToast("Back online."));

// ==========================================
// START
// ==========================================

renderHistory();
autoResize();
initialize();

// focus the box on desktop only (focusing on phones pops the keyboard open)
if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    messageInput.focus({ preventScroll: true });
}

});
