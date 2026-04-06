const STORAGE_KEY = "yuimessenger.currentUser";
const QUICK_REACTIONS = ["👍", "❤️", "🎉", "👀"];

const state = {
  currentUser: null,
  users: [],
  chats: [],
  friendships: [],
  notifications: [],
  selectedChat: null,
  selectedMessages: [],
  selectedAuditLogs: [],
  socket: null,
  refreshTimer: null
};

const elements = {
  authView: document.querySelector("#auth-view"),
  appView: document.querySelector("#app-view"),
  authLog: document.querySelector("#auth-log"),
  supportPill: document.querySelector("#support-pill"),
  resumeSessionButton: document.querySelector("#resume-session-button"),
  createUserForm: document.querySelector("#create-user-form"),
  registerPasskeyForm: document.querySelector("#register-passkey-form"),
  loginPasskeyForm: document.querySelector("#login-passkey-form"),
  currentUserName: document.querySelector("#current-user-name"),
  currentUserId: document.querySelector("#current-user-id"),
  presenceSelect: document.querySelector("#presence-select"),
  chatCount: document.querySelector("#chat-count"),
  friendCount: document.querySelector("#friend-count"),
  unreadCount: document.querySelector("#unread-count"),
  chatList: document.querySelector("#chat-list"),
  refreshButton: document.querySelector("#refresh-button"),
  logoutButton: document.querySelector("#logout-button"),
  chatEmpty: document.querySelector("#chat-empty"),
  chatRoom: document.querySelector("#chat-room"),
  chatKind: document.querySelector("#chat-kind"),
  chatTitle: document.querySelector("#chat-title"),
  chatMeta: document.querySelector("#chat-meta"),
  messageList: document.querySelector("#message-list"),
  messageForm: document.querySelector("#message-form"),
  messageInput: document.querySelector("#message-input"),
  markReadButton: document.querySelector("#mark-read-button"),
  toggleNotificationsButton: document.querySelector("#toggle-notifications-button"),
  friendRequestForm: document.querySelector("#friend-request-form"),
  friendRequestUserId: document.querySelector("#friend-request-user-id"),
  friendRequestList: document.querySelector("#friend-request-list"),
  friendList: document.querySelector("#friend-list"),
  dmForm: document.querySelector("#dm-form"),
  dmTargetSelect: document.querySelector("#dm-target-select"),
  groupForm: document.querySelector("#group-form"),
  groupTitleInput: document.querySelector("#group-title-input"),
  groupMemberOptions: document.querySelector("#group-member-options"),
  auditLogList: document.querySelector("#audit-log-list"),
  toast: document.querySelector("#toast")
};

const { startRegistration, startAuthentication, browserSupportsWebAuthn } = window.SimpleWebAuthnBrowser;

init();

function init() {
  const webAuthnSupported = browserSupportsWebAuthn();
  setSupportState(webAuthnSupported);
  logMessage(
    webAuthnSupported
      ? "このブラウザは WebAuthn に対応しています。パスキー認証を利用できます。"
      : "このブラウザは WebAuthn に対応していません。パスキー操作は完了できません。"
  );

  bindEvents();

  const storedUser = readStoredUser();
  if (storedUser) {
    elements.resumeSessionButton.hidden = false;
    elements.resumeSessionButton.textContent = `${storedUser.displayName} として続ける`;
  }
}

function bindEvents() {
  elements.createUserForm.addEventListener("submit", handleCreateUser);
  elements.registerPasskeyForm.addEventListener("submit", handleRegisterPasskey);
  elements.loginPasskeyForm.addEventListener("submit", handleLoginPasskey);
  elements.resumeSessionButton.addEventListener("click", async () => {
    const storedUser = readStoredUser();
    if (!storedUser) {
      return;
    }
    await startSession(storedUser, false);
  });

  elements.logoutButton.addEventListener("click", logout);
  elements.refreshButton.addEventListener("click", () => refreshApp(true));
  elements.presenceSelect.addEventListener("change", handlePresenceChange);
  elements.friendRequestForm.addEventListener("submit", handleFriendRequest);
  elements.dmForm.addEventListener("submit", handleCreateDm);
  elements.groupForm.addEventListener("submit", handleCreateGroup);
  elements.markReadButton.addEventListener("click", handleMarkRead);
  elements.toggleNotificationsButton.addEventListener("click", handleToggleNotifications);
  elements.messageForm.addEventListener("submit", handleSendMessage);
  elements.messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      elements.messageForm.requestSubmit();
    }
  });
}

async function handleCreateUser(event) {
  event.preventDefault();

  try {
    const form = new FormData(event.currentTarget);
    const payload = {
      userId: form.get("userId"),
      displayName: form.get("displayName")
    };
    const result = await postJSON("/api/users", payload);
    logMessage(["ユーザーを作成しました。", result]);
    showToast("ユーザーを作成しました。続けてパスキー登録を行えます。");
  } catch (error) {
    handleError(error, "ユーザー作成に失敗しました。");
  }
}

async function handleRegisterPasskey(event) {
  event.preventDefault();

  try {
    const form = new FormData(event.currentTarget);
    const userId = form.get("userId");
    const options = await postJSON("/api/passkeys/register/options", { userId });
    const response = await startRegistration({ optionsJSON: options });
    const verification = await postJSON("/api/passkeys/register/verify", { userId, response });

    logMessage(["パスキーを登録しました。", verification]);
    showToast("パスキー登録が完了しました。");
  } catch (error) {
    handleError(error, "パスキー登録に失敗しました。");
  }
}

async function handleLoginPasskey(event) {
  event.preventDefault();

  try {
    const form = new FormData(event.currentTarget);
    const userId = form.get("userId");
    const options = await postJSON("/api/passkeys/authenticate/options", { userId });
    const response = await startAuthentication({ optionsJSON: options });
    const verification = await postJSON("/api/passkeys/authenticate/verify", { userId, response });

    logMessage(["ログインに成功しました。", verification]);
    await startSession(verification.user, true);
  } catch (error) {
    handleError(error, "ログインに失敗しました。");
  }
}

async function startSession(user, announce) {
  state.currentUser = user;
  writeStoredUser(user);
  elements.resumeSessionButton.hidden = false;
  elements.resumeSessionButton.textContent = `${user.displayName} として続ける`;
  toggleView(true);
  connectWebSocket();
  await refreshApp(false);

  if (announce) {
    showToast(`${user.displayName} としてログインしました。`);
  }
}

async function refreshApp(manual) {
  if (!state.currentUser) {
    return;
  }

  try {
    const [users, chats, friendships, notifications, presence] = await Promise.all([
      getJSON("/api/users"),
      getJSON(`/api/users/${state.currentUser.id}/chats`),
      getJSON(`/api/users/${state.currentUser.id}/friendships`),
      getJSON(`/api/users/${state.currentUser.id}/notifications`),
      getJSON(`/api/users/${state.currentUser.id}/presence`)
    ]);

    state.users = users;
    state.chats = chats;
    state.friendships = friendships;
    state.notifications = notifications;
    elements.presenceSelect.value = presence.status;

    syncCurrentUser();
    renderSidebar();
    renderFriends();
    renderChatList();

    if (!state.selectedChat && state.chats.length > 0) {
      state.selectedChat = state.chats[0];
    } else if (state.selectedChat) {
      state.selectedChat = state.chats.find((chat) => chat.id === state.selectedChat.id) || null;
    }

    if (state.selectedChat) {
      await loadSelectedChat(state.selectedChat.id);
    } else {
      renderChatRoom();
    }

    if (manual) {
      showToast("最新の状態に更新しました。");
    }
  } catch (error) {
    if (String(error.message || "").includes("user not found")) {
      logout();
      return;
    }
    handleError(error, "画面の更新に失敗しました。");
  }
}

async function loadSelectedChat(chatId) {
  if (!state.currentUser) {
    return;
  }

  try {
    const chat = await getJSON(`/api/chats/${chatId}`);
    const messages = await getJSON(`/api/chats/${chatId}/messages?viewerUserId=${state.currentUser.id}`);

    state.selectedChat = chat;
    state.selectedMessages = messages;
    state.selectedAuditLogs = [];

    if (chat.kind === "group" && canViewAuditLogs(chat)) {
      state.selectedAuditLogs = await getJSON(`/api/chats/${chatId}/audit-logs?actorUserId=${state.currentUser.id}`);
    }

    renderChatList();
    renderChatRoom();
    renderAuditLogs();
    maybeMarkNewestMessageRead();
  } catch (error) {
    handleError(error, "チャットを読み込めませんでした。");
  }
}

async function handlePresenceChange(event) {
  if (!state.currentUser) {
    return;
  }

  try {
    await patchJSON(`/api/users/${state.currentUser.id}/presence`, {
      status: event.currentTarget.value,
      isVisible: true,
      isManual: true
    });
    showToast("ステータスを更新しました。");
  } catch (error) {
    handleError(error, "ステータス更新に失敗しました。");
  }
}

async function handleFriendRequest(event) {
  event.preventDefault();

  try {
    await postJSON("/api/friend-requests", {
      requesterUserId: state.currentUser.id,
      addresseeUserId: elements.friendRequestUserId.value.trim()
    });
    elements.friendRequestUserId.value = "";
    showToast("フレンド申請を送りました。");
    await refreshApp(false);
  } catch (error) {
    handleError(error, "フレンド申請に失敗しました。");
  }
}

async function handleCreateDm(event) {
  event.preventDefault();

  try {
    const targetUserId = elements.dmTargetSelect.value;
    if (!targetUserId) {
      throw new Error("DM の相手を選択してください");
    }
    const chat = await postJSON("/api/chats/dm", {
      actorUserId: state.currentUser.id,
      targetUserId
    });
    await refreshApp(false);
    await loadSelectedChat(chat.id);
    showToast("DM を開きました。");
  } catch (error) {
    handleError(error, "DM を作成できませんでした。");
  }
}

async function handleCreateGroup(event) {
  event.preventDefault();

  try {
    const memberUserIds = Array.from(document.querySelectorAll("input[name='group-member']:checked"))
      .map((input) => Number(input.value));
    const title = elements.groupTitleInput.value.trim();

    if (!title) {
      throw new Error("グループ名を入力してください");
    }

    const chat = await postJSON("/api/chats/group", {
      actorUserId: state.currentUser.id,
      title,
      memberUserIds
    });

    elements.groupTitleInput.value = "";
    document.querySelectorAll("input[name='group-member']").forEach((input) => {
      input.checked = false;
    });

    await refreshApp(false);
    await loadSelectedChat(chat.id);
    showToast("グループを作成しました。");
  } catch (error) {
    handleError(error, "グループ作成に失敗しました。");
  }
}

async function handleSendMessage(event) {
  event.preventDefault();

  if (!state.selectedChat) {
    return;
  }

  const body = elements.messageInput.value.trim();
  if (!body) {
    return;
  }

  try {
    await postJSON(`/api/chats/${state.selectedChat.id}/messages`, {
      actorUserId: state.currentUser.id,
      body
    });
    elements.messageInput.value = "";
    await loadSelectedChat(state.selectedChat.id);
  } catch (error) {
    handleError(error, "メッセージ送信に失敗しました。");
  }
}

async function handleMarkRead() {
  if (!state.selectedChat || state.selectedMessages.length === 0) {
    return;
  }

  try {
    const lastMessage = state.selectedMessages[state.selectedMessages.length - 1];
    await postJSON(`/api/chats/${state.selectedChat.id}/read-state`, {
      actorUserId: state.currentUser.id,
      lastReadMessageId: lastMessage.id
    });
    await refreshApp(false);
    showToast("既読状態を更新しました。");
  } catch (error) {
    handleError(error, "既読更新に失敗しました。");
  }
}

async function handleToggleNotifications() {
  if (!state.selectedChat) {
    return;
  }

  try {
    const current = notificationSettingForSelectedChat();
    await postJSON(`/api/users/${state.currentUser.id}/notifications`, {
      scopeType: state.selectedChat.kind,
      scopeId: state.selectedChat.id,
      enabled: !(current?.enabled ?? true)
    });
    await refreshApp(false);
    showToast("通知設定を更新しました。");
  } catch (error) {
    handleError(error, "通知設定の更新に失敗しました。");
  }
}

function renderSidebar() {
  const acceptedFriends = acceptedFriendships();
  const unreadTotal = state.chats.reduce((sum, chat) => sum + Number(chat.unreadCount || 0), 0);

  elements.currentUserName.textContent = state.currentUser.displayName;
  elements.currentUserId.textContent = `@${state.currentUser.userId}`;
  elements.chatCount.textContent = String(state.chats.length);
  elements.friendCount.textContent = String(acceptedFriends.length);
  elements.unreadCount.textContent = String(unreadTotal);
}

function renderChatList() {
  if (state.chats.length === 0) {
    elements.chatList.innerHTML = `<p class="muted-line">まだ参加中のチャットはありません。</p>`;
    return;
  }

  elements.chatList.innerHTML = state.chats.map((chat) => {
    const title = chatDisplayName(chat);
    const lastMessage = chat.lastMessage ? escapeHtml(chat.lastMessage.body) : "まだメッセージがありません";
    const unread = Number(chat.unreadCount || 0);
    const activeClass = state.selectedChat?.id === chat.id ? "active" : "";

    return `
      <button class="chat-list-item ${activeClass}" type="button" data-chat-id="${chat.id}">
        <div class="list-title-row">
          <strong>${escapeHtml(title)}</strong>
          ${unread > 0 ? `<span class="count-badge">${unread}</span>` : ""}
        </div>
        <p class="item-meta">${escapeHtml(chat.kind === "group" ? "グループ" : "DM")}</p>
        <p class="item-meta">${lastMessage}</p>
      </button>
    `;
  }).join("");

  elements.chatList.querySelectorAll("[data-chat-id]").forEach((button) => {
    button.addEventListener("click", () => loadSelectedChat(Number(button.dataset.chatId)));
  });
}

function renderFriends() {
  const pending = pendingFriendships();
  const friends = acceptedFriendships();

  elements.friendRequestList.innerHTML = pending.length > 0
    ? pending.map(renderFriendRequestCard).join("")
    : `<p class="muted-line">保留中の申請はありません。</p>`;

  elements.friendList.innerHTML = friends.length > 0
    ? friends.map(renderFriendCard).join("")
    : `<p class="muted-line">フレンドがまだいません。</p>`;

  elements.friendRequestList.querySelectorAll("[data-respond-request]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await postJSON(`/api/friend-requests/${button.dataset.requestId}/respond`, {
          actorUserId: state.currentUser.id,
          action: button.dataset.action
        });
        await refreshApp(false);
        showToast(button.dataset.action === "accepted" ? "フレンド申請を承認しました。" : "フレンド申請を拒否しました。");
      } catch (error) {
        handleError(error, "申請の処理に失敗しました。");
      }
    });
  });

  elements.friendList.querySelectorAll("[data-open-dm]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const chat = await postJSON("/api/chats/dm", {
          actorUserId: state.currentUser.id,
          targetUserId: Number(button.dataset.targetUserId)
        });
        await refreshApp(false);
        await loadSelectedChat(chat.id);
      } catch (error) {
        handleError(error, "DM を開けませんでした。");
      }
    });
  });

  renderChatCreationOptions(friends);
}

function renderChatCreationOptions(friends) {
  elements.dmTargetSelect.innerHTML = friends.length > 0
    ? `<option value="">相手を選択</option>${friends.map((friend) => {
        const other = friendshipOtherUser(friend);
        return `<option value="${other.id}">${escapeHtml(other.displayName)} (@${escapeHtml(other.userId)})</option>`;
      }).join("")}`
    : `<option value="">フレンドが必要です</option>`;

  elements.groupMemberOptions.innerHTML = friends.length > 0
    ? friends.map((friend) => {
        const other = friendshipOtherUser(friend);
        return `
          <label class="checkbox-row">
            <input type="checkbox" name="group-member" value="${other.id}">
            <span>${escapeHtml(other.displayName)} (@${escapeHtml(other.userId)})</span>
          </label>
        `;
      }).join("")
    : `<p class="muted-line">グループに追加できるフレンドがいません。</p>`;
}

function renderChatRoom() {
  if (!state.selectedChat) {
    elements.chatEmpty.hidden = false;
    elements.chatRoom.hidden = true;
    elements.auditLogList.innerHTML = `<p class="muted-line">グループを選ぶと監査ログを表示します。</p>`;
    return;
  }

  elements.chatEmpty.hidden = true;
  elements.chatRoom.hidden = false;
  elements.chatKind.textContent = state.selectedChat.kind === "group" ? "グループチャット" : "ダイレクトメッセージ";
  elements.chatTitle.textContent = chatDisplayName(state.selectedChat);

  const members = state.selectedChat.memberIds.map((id) => userById(id)?.displayName || `ユーザー ${id}`);
  const notificationSetting = notificationSettingForSelectedChat();
  const hasNotifications = notificationSetting?.enabled ?? true;

  elements.chatMeta.innerHTML = `
    <div class="chat-meta-item">
      <span class="mini-label">参加メンバー</span>
      <p class="meta-line">${escapeHtml(members.join(" / "))}</p>
    </div>
    <div class="chat-meta-item">
      <span class="mini-label">通知</span>
      <p class="meta-line">${hasNotifications ? "受け取る" : "ミュート中"}</p>
    </div>
    <div class="chat-meta-item">
      <span class="mini-label">メッセージ数</span>
      <p class="meta-line">${state.selectedMessages.length} 件</p>
    </div>
  `;

  elements.toggleNotificationsButton.textContent = hasNotifications ? "通知をミュート" : "通知を再開";

  if (state.selectedMessages.length === 0) {
    elements.messageList.innerHTML = `<p class="muted-line">まだメッセージがありません。最初の一言を送ってみましょう。</p>`;
  } else {
    elements.messageList.innerHTML = state.selectedMessages.map((message) => {
      const sender = message.senderUserId ? userById(message.senderUserId) : null;
      const ownClass = message.senderUserId === state.currentUser.id ? "own" : "";
      const canDelete = canDeleteMessage(message);

      return `
        <article class="message-card ${ownClass}">
          <div class="message-row">
            <div>
              <strong>${escapeHtml(sender?.displayName || "不明なユーザー")}</strong>
              <p class="item-meta">@${escapeHtml(sender?.userId || "fumei")}</p>
            </div>
            <p class="item-meta">${formatDateTime(message.createdAt)}</p>
          </div>
          <p class="message-body">${escapeHtml(message.body)}</p>
          <div class="reaction-row">
            ${renderReactionSummary(message)}
          </div>
          <div class="action-row">
            ${QUICK_REACTIONS.map((emoji) => {
              const active = hasReactionFromCurrentUser(message, emoji) ? "true" : "false";
              return `<button class="reaction-button" type="button" data-message-reaction="${message.id}" data-emoji="${emoji}" data-active="${active}">${emoji}</button>`;
            }).join("")}
            ${canDelete ? `<button class="tiny-button" type="button" data-delete-message="${message.id}">削除</button>` : ""}
          </div>
        </article>
      `;
    }).join("");
  }

  elements.messageList.querySelectorAll("[data-message-reaction]").forEach((button) => {
    button.addEventListener("click", () => handleToggleReaction(Number(button.dataset.messageReaction), button.dataset.emoji, button.dataset.active === "true"));
  });

  elements.messageList.querySelectorAll("[data-delete-message]").forEach((button) => {
    button.addEventListener("click", () => handleDeleteMessage(Number(button.dataset.deleteMessage)));
  });
}

function renderAuditLogs() {
  if (!state.selectedChat || state.selectedChat.kind !== "group") {
    elements.auditLogList.innerHTML = `<p class="muted-line">グループを選ぶと監査ログを表示します。</p>`;
    return;
  }

  if (!canViewAuditLogs(state.selectedChat)) {
    elements.auditLogList.innerHTML = `<p class="muted-line">このグループの監査ログを見る権限がありません。</p>`;
    return;
  }

  if (state.selectedAuditLogs.length === 0) {
    elements.auditLogList.innerHTML = `<p class="muted-line">まだ監査ログはありません。</p>`;
    return;
  }

  elements.auditLogList.innerHTML = state.selectedAuditLogs.map((log) => {
    const actor = log.actorUserId ? userById(log.actorUserId) : null;
    return `
      <article class="audit-card">
        <div class="item-header">
          <strong>${escapeHtml(log.eventType)}</strong>
          <p class="item-meta">${formatDateTime(log.createdAt)}</p>
        </div>
        <p class="item-meta">${escapeHtml(actor?.displayName || "システム")}</p>
        <pre class="json-log">${escapeHtml(JSON.stringify(log.payload, null, 2))}</pre>
      </article>
    `;
  }).join("");
}

async function handleToggleReaction(messageId, emoji, isActive) {
  try {
    if (isActive) {
      await deleteJSON(`/api/chats/${state.selectedChat.id}/messages/${messageId}/reactions?actorUserId=${state.currentUser.id}&emoji=${encodeURIComponent(emoji)}`);
    } else {
      await postJSON(`/api/chats/${state.selectedChat.id}/messages/${messageId}/reactions`, {
        actorUserId: state.currentUser.id,
        emoji
      });
    }

    await loadSelectedChat(state.selectedChat.id);
  } catch (error) {
    handleError(error, "リアクション更新に失敗しました。");
  }
}

async function handleDeleteMessage(messageId) {
  try {
    await deleteJSON(`/api/chats/${state.selectedChat.id}/messages/${messageId}?actorUserId=${state.currentUser.id}`);
    await loadSelectedChat(state.selectedChat.id);
    showToast("メッセージを削除しました。");
  } catch (error) {
    handleError(error, "メッセージ削除に失敗しました。");
  }
}

function renderFriendRequestCard(friendship) {
  const incoming = friendship.addresseeUserId === state.currentUser.id;
  const other = friendshipOtherUser(friendship);

  return `
    <article class="request-card">
      <div class="item-header">
        <strong>${escapeHtml(other.displayName)}</strong>
        <span class="status-badge ${incoming ? "status-away" : "status-online"}">${incoming ? "受信" : "送信済み"}</span>
      </div>
      <p class="item-meta">@${escapeHtml(other.userId)}</p>
      ${incoming ? `
        <div class="action-row">
          <button class="tiny-button" type="button" data-respond-request="true" data-request-id="${friendship.id}" data-action="accepted">承認</button>
          <button class="tiny-button" type="button" data-respond-request="true" data-request-id="${friendship.id}" data-action="rejected">拒否</button>
        </div>
      ` : ""}
    </article>
  `;
}

function renderFriendCard(friendship) {
  const other = friendshipOtherUser(friendship);

  return `
    <article class="friend-card">
      <div class="item-header">
        <strong>${escapeHtml(other.displayName)}</strong>
        <span class="status-badge status-away">フレンド</span>
      </div>
      <p class="item-meta">@${escapeHtml(other.userId)}</p>
      <div class="action-row">
        <button class="tiny-button" type="button" data-open-dm="true" data-target-user-id="${other.id}">DM を開く</button>
      </div>
    </article>
  `;
}

function renderReactionSummary(message) {
  if (!message.reactions || message.reactions.length === 0) {
    return `<span class="item-meta">リアクションはまだありません。</span>`;
  }

  const grouped = new Map();
  for (const reaction of message.reactions) {
    const count = grouped.get(reaction.emoji) || 0;
    grouped.set(reaction.emoji, count + 1);
  }

  return Array.from(grouped.entries()).map(([emoji, count]) => {
    return `<span class="tiny-button">${emoji} ${count}</span>`;
  }).join("");
}

function toggleView(showApp) {
  elements.authView.hidden = showApp;
  elements.appView.hidden = !showApp;
}

function connectWebSocket() {
  if (state.socket) {
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  state.socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

  state.socket.addEventListener("message", () => {
    scheduleRefresh();
  });

  state.socket.addEventListener("close", () => {
    state.socket = null;
    window.setTimeout(() => {
      if (state.currentUser) {
        connectWebSocket();
      }
    }, 1500);
  });
}

function scheduleRefresh() {
  window.clearTimeout(state.refreshTimer);
  state.refreshTimer = window.setTimeout(() => {
    refreshApp(false);
  }, 250);
}

function logout() {
  if (state.socket) {
    state.socket.close();
    state.socket = null;
  }

  state.currentUser = null;
  state.users = [];
  state.chats = [];
  state.friendships = [];
  state.notifications = [];
  state.selectedChat = null;
  state.selectedMessages = [];
  state.selectedAuditLogs = [];

  clearStoredUser();
  toggleView(false);
  elements.chatList.innerHTML = "";
  elements.friendList.innerHTML = "";
  elements.friendRequestList.innerHTML = "";
  elements.auditLogList.innerHTML = "";
  elements.resumeSessionButton.hidden = true;
  showToast("ログアウトしました。");
}

function notificationSettingForSelectedChat() {
  if (!state.selectedChat) {
    return null;
  }

  return state.notifications.find((setting) => (
    setting.scopeType === state.selectedChat.kind && setting.scopeId === state.selectedChat.id
  )) || null;
}

function maybeMarkNewestMessageRead() {
  if (!state.selectedChat || state.selectedMessages.length === 0) {
    return;
  }

  const lastMessage = state.selectedMessages[state.selectedMessages.length - 1];
  postJSON(`/api/chats/${state.selectedChat.id}/read-state`, {
    actorUserId: state.currentUser.id,
    lastReadMessageId: lastMessage.id
  }).then(() => {
    state.chats = state.chats.map((chat) => (
      chat.id === state.selectedChat.id ? { ...chat, unreadCount: 0 } : chat
    ));
    renderSidebar();
    renderChatList();
  }).catch(() => {
    // Read-state update is non-critical for rendering.
  });
}

function syncCurrentUser() {
  const latest = state.users.find((user) => user.id === state.currentUser.id);
  if (latest) {
    state.currentUser = latest;
    writeStoredUser(latest);
  }
}

function readStoredUser() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_error) {
    return null;
  }
}

function writeStoredUser(user) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
}

function clearStoredUser() {
  window.localStorage.removeItem(STORAGE_KEY);
}

function pendingFriendships() {
  return state.friendships.filter((friendship) => friendship.status === "pending");
}

function acceptedFriendships() {
  return state.friendships.filter((friendship) => friendship.status === "accepted");
}

function friendshipOtherUser(friendship) {
  const otherId = friendship.requesterUserId === state.currentUser.id
    ? friendship.addresseeUserId
    : friendship.requesterUserId;

  return friendship.requester?.id === otherId
    ? friendship.requester
    : friendship.addressee;
}

function chatDisplayName(chat) {
  if (chat.kind === "group") {
    return chat.title || `グループ ${chat.id}`;
  }

  const otherId = chat.memberIds.find((id) => id !== state.currentUser.id);
  const user = userById(otherId);
  return user ? `${user.displayName}` : `DM ${chat.id}`;
}

function userById(userId) {
  return state.users.find((user) => user.id === Number(userId)) || null;
}

function canViewAuditLogs(chat) {
  return chat.roles.some((role) => role.memberIds.includes(state.currentUser.id) && role.permissions.canViewAuditLogs);
}

function canDeleteMessage(message) {
  if (message.senderUserId === state.currentUser.id) {
    return true;
  }

  return state.selectedChat?.kind === "group" && state.selectedChat.roles.some((role) => (
    role.memberIds.includes(state.currentUser.id) && role.permissions.canDeleteMessages
  ));
}

function hasReactionFromCurrentUser(message, emoji) {
  return message.reactions.some((reaction) => reaction.userId === state.currentUser.id && reaction.emoji === emoji);
}

function setSupportState(isSupported) {
  elements.supportPill.textContent = isSupported
    ? "このブラウザはパスキーに対応しています"
    : "このブラウザはパスキーに対応していません";
  elements.supportPill.classList.add(isSupported ? "is-supported" : "is-unsupported");
}

function logMessage(value) {
  const lines = Array.isArray(value) ? value : [value];
  elements.authLog.textContent = lines
    .map((item) => (typeof item === "string" ? item : JSON.stringify(item, null, 2)))
    .join("\n\n");
}

function showToast(message) {
  elements.toast.hidden = false;
  elements.toast.textContent = message;
  window.clearTimeout(showToast.timerId);
  showToast.timerId = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 2600);
}

function handleError(error, fallbackMessage) {
  const message = error.message || fallbackMessage;
  logMessage([fallbackMessage, message]);
  showToast(message);
}

async function getJSON(url) {
  const response = await fetch(url);
  return handleResponse(response);
}

async function postJSON(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return handleResponse(response);
}

async function patchJSON(url, payload) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return handleResponse(response);
}

async function deleteJSON(url) {
  const response = await fetch(url, { method: "DELETE" });
  return handleResponse(response);
}

async function handleResponse(response) {
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "リクエストに失敗しました");
  }

  return data;
}

function formatDateTime(value) {
  return new Date(value).toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
