
const $ = (selector) => document.querySelector(selector);

const messages = $("#messages");
const input = $("#input");
const sendButton = $("#send");
const form = $("#form");

let conversationId = null;
let activeRequest = null;
let requestCounter = 0;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function renderText(value) {
  return escapeHtml(value)
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}

function updateSendButton() {
  if (activeRequest) {
    sendButton.textContent = "■";
    sendButton.type = "button";
    sendButton.title = "Stop generating";
    sendButton.setAttribute("aria-label", "Stop generating");
    sendButton.classList.add("stop");
  } else {
    sendButton.textContent = "↑";
    sendButton.type = "submit";
    sendButton.title = "Send message";
    sendButton.setAttribute("aria-label", "Send message");
    sendButton.classList.remove("stop");
  }
}

function addMessage(role, content = "") {
  const welcome = $(".welcome");
  if (welcome) welcome.remove();

  const element = document.createElement("div");
  element.className = `message ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = renderText(content);

  element.appendChild(bubble);
  messages.appendChild(element);

  scrollToBottom();
  return element;
}


async function loadConversations() {
  try {
    const response = await fetch("/api/conversations");

    if (!response.ok) {
      throw new Error("Could not load conversations");
    }

    const data = await response.json();

    $("#conversations").innerHTML = data.map(conversation => `
      <div class="conversation-row">
        <button
          type="button"
          data-id="${escapeHtml(conversation.id)}"
          class="conversation-open ${
            conversation.id === conversationId ? "active" : ""
          }"
          title="${escapeHtml(conversation.title)}"
        >
          ${escapeHtml(conversation.title)}
        </button>

        <div class="conversation-menu-wrap">
          <button
            type="button"
            class="conversation-menu-toggle"
            data-menu-id="${escapeHtml(conversation.id)}"
            aria-label="Conversation options"
            aria-expanded="false"
            title="Conversation options"
          >⋯</button>

          <div class="conversation-menu" hidden>
            <button
              type="button"
              class="conversation-delete"
              data-delete-id="${escapeHtml(conversation.id)}"
            >
              <span>🗑</span> Delete chat
            </button>
          </div>
        </div>
      </div>
    `).join("");

  } catch (error) {
    console.error("Conversation loading failed:", error);
  }
}


async function deleteChat(id) {
  const confirmed = window.confirm(
    "Delete this conversation permanently? Its messages and saved claims will also be deleted."
  );

  if (!confirmed) return;

  const deletingActiveChat = id === conversationId;

  // Stop generation before deleting the active conversation.
  if (deletingActiveChat) {
    ++requestCounter;
    stopGeneration();
  }

  try {
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(id)}`,
      {
        method: "DELETE"
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not delete conversation.");
    }

    if (deletingActiveChat) {
      resetToNewChat();
    } else {
      await loadConversations();
    }

  } catch (error) {
    console.error("Chat deletion failed:", error);
    alert(error.message || "Could not delete conversation.");
  }
}


function stopGeneration() {
  const request = activeRequest;
  if (!request) return;

  // Detach the old request immediately so a new message can start.
  activeRequest = null;

  request.controller.abort();

  if (request.status?.isConnected) {
    request.status.textContent = "Generation stopped.";
  }

  updateSendButton();
  input.focus();
}

function resetToNewChat() {
  stopGeneration();

  conversationId = null;

  messages.innerHTML = `
    <div class="welcome">
      <div class="spark">✳</div>
      <h2>Ask once. Pick up where you left off.</h2>
      <p>
        I remember our conversations and re-check
        information when the world changes.
      </p>
      <div class="suggestions">
        <button
          type="button"
          data-prompt="What are the best Postgres hosting options for a side project right now?"
        >
          Compare Postgres hosting
        </button>
        <button
          type="button"
          data-prompt="What changed recently in the AI coding tools market?"
        >
          What's changed recently?
        </button>
        <button
          type="button"
          data-prompt="Explain how PostgreSQL indexes work."
        >
          Explain a concept
        </button>
      </div>
    </div>
  `;

  input.value = "";
  input.focus();
  loadConversations();
}

async function openConversation(id) {
  stopGeneration();

  // Prevent an older history request from replacing a newer chat.
  const navigationId = ++requestCounter;

  conversationId = id;
  messages.innerHTML = "";

  try {
    const response = await fetch(
      `/api/history/${encodeURIComponent(id)}`
    );

    if (!response.ok) throw new Error("Could not load history");

    const data = await response.json();

    if (navigationId !== requestCounter) return;

    messages.innerHTML = "";

    for (const message of data.messages || []) {
      addMessage(
        message.role === "user" ? "user" : "assistant",
        message.content
      );
    }

    await loadConversations();
  } catch (error) {
    if (navigationId !== requestCounter) return;
    addMessage("assistant", `Unable to load chat: ${error.message}`);
  }
}

function processSseChunk(chunk, request) {
  const event = chunk.match(/^event:\s*(.+)$/m)?.[1];
  const raw = chunk.match(/^data:\s*(.+)$/m)?.[1];

  if (!raw || !event) return;

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  if (activeRequest !== request) return;

  switch (event) {
    case "meta":
      conversationId = data.conversationId;
      break;

    case "status":
      request.status.textContent = data.message || "Working…";
      break;

    case "delta":
      // The current backend sends accumulated answer text.
      request.bubble.innerHTML = renderText(data.text || "");
      request.status.remove();
      break;

    case "sources": {
      const sources = data.sources || [];

      if (sources.length) {
        const container = document.createElement("div");
        container.className = "sources";

        for (const source of sources) {
          if (!/^https?:\/\//i.test(source.url || "")) continue;

          const link = document.createElement("a");
          link.href = source.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent =
            `[${source.id}] ${String(source.title || "Source").slice(0, 48)}`;

          container.appendChild(link);
        }

        request.element.appendChild(container);
      }

      break;
    }

    case "error":
      throw new Error(data.message || "The request failed");

    case "done":
      request.status.remove();
      break;
  }
}

async function sendMessage(text) {
  const message = String(text || "").trim();

  if (!message) return;

  // Stop the previous request if one is still running.
  if (activeRequest) stopGeneration();

  const navigationId = ++requestCounter;
  const controller = new AbortController();

  addMessage("user", message);
  input.value = "";

  const answer = addMessage("assistant", "");
  const bubble = answer.querySelector(".bubble");

  const status = document.createElement("div");
  status.className = "status";
  status.textContent = "Thinking…";
  answer.appendChild(status);

  const request = {
    controller,
    navigationId,
    element: answer,
    bubble,
    status
  };

  activeRequest = request;
  updateSendButton();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message,
        conversationId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      let errorMessage = "Request failed";

      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {}

      throw new Error(errorMessage);
    }

    if (!response.body) {
      throw new Error("Streaming response is unavailable");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();

      if (done) break;
      if (activeRequest !== request) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";

      for (const chunk of chunks) {
        processSseChunk(chunk, request);
      }

      scrollToBottom();
    }

    if (activeRequest === request) {
      status.remove();
      await loadConversations();
    }
  } catch (error) {
    if (activeRequest !== request) return;

    if (error.name === "AbortError") {
      status.textContent = "Generation stopped.";
    } else {
      status.textContent = `Couldn't finish: ${error.message}`;
      console.error("Chat error:", error);
    }
  } finally {
    if (activeRequest === request) {
      activeRequest = null;
      updateSendButton();
      input.focus();
    }
  }
}

// Enter sends; Shift + Enter inserts a newline.
input.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    sendMessage(input.value);
  }
});

// Arrow button sends through the form.
form.addEventListener("submit", (event) => {
  event.preventDefault();

  if (activeRequest) {
    stopGeneration();
    return;
  }

  sendMessage(input.value);
});

// Stop button cancels the current request.
sendButton.addEventListener("click", (event) => {
  if (activeRequest) {
    event.preventDefault();
    stopGeneration();
  }
});

// Start a clean conversation.
$("#newChat").addEventListener("click", () => {
  ++requestCounter;
  resetToNewChat();
});

// Load a saved conversation.

$("#conversations").addEventListener("click", (event) => {
  // Toggle the three-dot menu.
  const menuButton = event.target.closest("[data-menu-id]");

  if (menuButton) {
    const row = menuButton.closest(".conversation-row");
    const menu = row.querySelector(".conversation-menu");
    const isOpening = menu.hidden;

    // Close any other open menus.
    $("#conversations")
      .querySelectorAll(".conversation-menu")
      .forEach(item => {
        item.hidden = true;
      });

    $("#conversations")
      .querySelectorAll(".conversation-menu-toggle")
      .forEach(item => {
        item.setAttribute("aria-expanded", "false");
      });

    menu.hidden = !isOpening;
    menuButton.setAttribute(
      "aria-expanded",
      String(isOpening)
    );

    return;
  }

  // Delete a conversation.
  const deleteButton = event.target.closest("[data-delete-id]");

  if (deleteButton) {
    deleteChat(deleteButton.dataset.deleteId);
    return;
  }

  // Open a conversation.
  const chatButton = event.target.closest("button[data-id]");

  if (chatButton) {
    openConversation(chatButton.dataset.id);
  }
});

// Close menus when clicking outside the conversation list.
document.addEventListener("click", event => {
  if (event.target.closest("#conversations")) return;

  document.querySelectorAll(".conversation-menu").forEach(menu => {
    menu.hidden = true;
  });

  document.querySelectorAll(".conversation-menu-toggle").forEach(button => {
    button.setAttribute("aria-expanded", "false");
  });
});


// Handle suggested prompts, including those recreated by New Chat.
messages.addEventListener("click", (event) => {
  const button = event.target.closest("[data-prompt]");

  if (button) {
    sendMessage(button.dataset.prompt);
  }
});

updateSendButton();
loadConversations();
