const crypto = require("crypto");

const USER_ID_PATTERN = /^(?![_-])[A-Za-z0-9_-]{3,32}(?<![_-])$/;

const ROLE_PERMISSIONS = [
  "canDeleteMessages",
  "canKickMembers",
  "canEditGroupName",
  "canInviteMembers",
  "canManageRoles",
  "canViewAuditLogs",
  "canDeleteAuditLogs"
];

class AppStore {
  constructor() {
    this.users = [];
    this.friendships = [];
    this.chats = [];
    this.messages = [];
    this.reactions = [];
    this.auditLogs = [];
    this.passkeys = [];
    this.presenceStates = new Map();
    this.notificationSettings = [];
    this.readStates = [];
    this.passkeyChallenges = {
      registration: new Map(),
      authentication: new Map()
    };
    this.counters = {
      user: 1,
      friendship: 1,
      chat: 1,
      role: 1,
      message: 1,
      reaction: 1,
      auditLog: 1
    };
  }

  createUser({ userId, displayName }) {
    this.assertUserId(userId);

    if (!displayName || typeof displayName !== "string") {
      throw new Error("displayName is required");
    }

    if (this.findUserByUserId(userId)) {
      throw new Error("userId already exists");
    }

    const user = {
      id: this.nextId("user"),
      userId,
      displayName,
      webauthnUserID: `wa-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString()
    };

    this.users.push(user);
    this.presenceStates.set(user.id, {
      userId: user.id,
      status: "offline",
      isVisible: true,
      isManual: false,
      updatedAt: new Date().toISOString()
    });
    return user;
  }

  listUsers() {
    return this.users;
  }

  listPasskeysForUser(userId) {
    const user = this.requireUser(userId);
    return this.passkeys.filter((passkey) => passkey.userId === user.id);
  }

  getPresence(userId) {
    const user = this.requireUser(userId);
    return this.presenceStates.get(user.id);
  }

  updatePresence({ userId, status, isVisible, isManual }) {
    const user = this.requireUser(userId);
    const current = this.getPresence(user.id);
    const nextStatus = status || current.status;

    if (!["online", "offline", "away"].includes(nextStatus)) {
      throw new Error("status must be online, offline, or away");
    }

    const next = {
      ...current,
      status: nextStatus,
      isVisible: typeof isVisible === "boolean" ? isVisible : current.isVisible,
      isManual: typeof isManual === "boolean" ? isManual : current.isManual,
      updatedAt: new Date().toISOString()
    };

    this.presenceStates.set(user.id, next);
    return next;
  }

  setNotificationSetting({
    actorUserId,
    scopeType,
    scopeId,
    enabled
  }) {
    const actor = this.requireUser(actorUserId);

    if (!["dm", "group"].includes(scopeType)) {
      throw new Error("scopeType must be dm or group");
    }

    const chat = this.requireChat(scopeId);

    if (chat.kind !== scopeType) {
      throw new Error("scopeType does not match chat kind");
    }

    if (!chat.memberIds.includes(actor.id)) {
      throw new Error("actor is not a member of this chat");
    }

    let setting = this.notificationSettings.find((entry) => {
      return entry.userId === actor.id && entry.scopeType === scopeType && entry.scopeId === chat.id;
    });

    if (!setting) {
      setting = {
        userId: actor.id,
        scopeType,
        scopeId: chat.id,
        enabled: true,
        updatedAt: new Date().toISOString()
      };
      this.notificationSettings.push(setting);
    }

    setting.enabled = Boolean(enabled);
    setting.updatedAt = new Date().toISOString();
    return setting;
  }

  listNotificationSettings(userId) {
    const user = this.requireUser(userId);
    return this.notificationSettings.filter((entry) => entry.userId === user.id);
  }

  getUnreadSummary(userId) {
    const user = this.requireUser(userId);
    const chatIds = this.chats
      .filter((chat) => chat.memberIds.includes(user.id))
      .map((chat) => chat.id);

    return chatIds.map((chatId) => {
      const lastReadMessageId = this.getReadState(chatId, user.id)?.lastReadMessageId || 0;
      const unreadCount = this.messages.filter((message) => {
        return (
          message.chatId === chatId &&
          message.senderUserId !== user.id &&
          message.id > lastReadMessageId &&
          !this.blockedUserIdsFor(user.id).has(message.senderUserId)
        );
      }).length;

      const chat = this.requireChat(chatId);
      return {
        chatId,
        kind: chat.kind,
        unreadCount
      };
    });
  }

  markChatRead({ chatId, actorUserId, lastReadMessageId }) {
    const actor = this.requireUser(actorUserId);
    const chat = this.requireChat(chatId);

    if (!chat.memberIds.includes(actor.id)) {
      throw new Error("actor is not a member of this chat");
    }

    let state = this.getReadState(chat.id, actor.id);

    if (!state) {
      state = {
        chatId: chat.id,
        userId: actor.id,
        lastReadMessageId: 0,
        updatedAt: new Date().toISOString()
      };
      this.readStates.push(state);
    }

    state.lastReadMessageId = Number(lastReadMessageId || 0);
    state.updatedAt = new Date().toISOString();
    return state;
  }

  saveRegistrationChallenge(userId, challenge) {
    const user = this.requireUser(userId);
    this.passkeyChallenges.registration.set(user.id, challenge);
    return challenge;
  }

  readRegistrationChallenge(userId) {
    const user = this.requireUser(userId);
    return this.passkeyChallenges.registration.get(user.id) || null;
  }

  clearRegistrationChallenge(userId) {
    const user = this.requireUser(userId);
    this.passkeyChallenges.registration.delete(user.id);
  }

  saveAuthenticationChallenge(userId, challenge) {
    const user = this.requireUser(userId);
    this.passkeyChallenges.authentication.set(user.id, challenge);
    return challenge;
  }

  readAuthenticationChallenge(userId) {
    const user = this.requireUser(userId);
    return this.passkeyChallenges.authentication.get(user.id) || null;
  }

  clearAuthenticationChallenge(userId) {
    const user = this.requireUser(userId);
    this.passkeyChallenges.authentication.delete(user.id);
  }

  addPasskey({
    userId,
    credentialId,
    publicKey,
    counter,
    transports = [],
    deviceType,
    backedUp
  }) {
    const user = this.requireUser(userId);

    const existing = this.passkeys.find((passkey) => passkey.credentialId === credentialId);
    if (existing) {
      throw new Error("passkey already registered");
    }

    const passkey = {
      id: crypto.randomUUID(),
      userId: user.id,
      webauthnUserID: user.webauthnUserID,
      credentialId,
      publicKey,
      counter,
      transports,
      deviceType,
      backedUp,
      createdAt: new Date().toISOString()
    };

    this.passkeys.push(passkey);
    return passkey;
  }

  findPasskeyByCredentialId(credentialId) {
    return this.passkeys.find((passkey) => passkey.credentialId === credentialId) || null;
  }

  updatePasskeyCounter(credentialId, counter) {
    const passkey = this.findPasskeyByCredentialId(credentialId);

    if (!passkey) {
      throw new Error("passkey not found");
    }

    passkey.counter = counter;
    passkey.updatedAt = new Date().toISOString();
    return passkey;
  }

  createFriendRequest({ requesterUserId, addresseeUserId }) {
    const requester = this.requireUser(requesterUserId);
    const addressee = this.requireUser(addresseeUserId);

    if (requester.id === addressee.id) {
      throw new Error("cannot friend yourself");
    }

    if (this.isBlockedBetween(requester.id, addressee.id)) {
      throw new Error("friend request not allowed because one user blocked the other");
    }

    if (this.findFriendshipPair(requester.id, addressee.id)) {
      throw new Error("friendship or request already exists");
    }

    const friendship = {
      id: this.nextId("friendship"),
      requesterUserId: requester.id,
      addresseeUserId: addressee.id,
      status: "pending",
      createdAt: new Date().toISOString()
    };

    this.friendships.push(friendship);
    return friendship;
  }

  respondToFriendRequest({ requestId, actorUserId, action }) {
    const actor = this.requireUser(actorUserId);
    const friendship = this.friendships.find((entry) => entry.id === Number(requestId));

    if (!friendship || friendship.status !== "pending") {
      throw new Error("pending friend request not found");
    }

    if (friendship.addresseeUserId !== actor.id) {
      throw new Error("only the addressee can respond");
    }

    if (!["accepted", "rejected"].includes(action)) {
      throw new Error("action must be accepted or rejected");
    }

    if (action === "accepted") {
      friendship.status = "accepted";
      friendship.acceptedAt = new Date().toISOString();
      return friendship;
    }

    this.friendships = this.friendships.filter((entry) => entry.id !== friendship.id);
    return { id: friendship.id, status: "rejected" };
  }

  blockUser({ actorUserId, targetUserId }) {
    const actor = this.requireUser(actorUserId);
    const target = this.requireUser(targetUserId);

    if (actor.id === target.id) {
      throw new Error("cannot block yourself");
    }

    const existing = this.findDirectedFriendship(actor.id, target.id);

    if (existing) {
      existing.status = "blocked";
      existing.blockedByUserId = actor.id;
      existing.updatedAt = new Date().toISOString();
      return existing;
    }

    const friendship = {
      id: this.nextId("friendship"),
      requesterUserId: actor.id,
      addresseeUserId: target.id,
      status: "blocked",
      blockedByUserId: actor.id,
      createdAt: new Date().toISOString()
    };

    this.friendships.push(friendship);
    return friendship;
  }

  listFriendshipsForUser(userId) {
    const user = this.requireUser(userId);

    return this.friendships
      .filter((entry) => entry.requesterUserId === user.id || entry.addresseeUserId === user.id)
      .map((entry) => ({
        ...entry,
        requester: this.findUserById(entry.requesterUserId),
        addressee: this.findUserById(entry.addresseeUserId)
      }));
  }

  createDirectMessageChat({ actorUserId, targetUserId }) {
    const actor = this.requireUser(actorUserId);
    const target = this.requireUser(targetUserId);

    if (this.isBlockedBetween(actor.id, target.id)) {
      throw new Error("cannot create DM because one user blocked the other");
    }

    const areFriends = this.friendships.some((entry) => {
      const samePair =
        (entry.requesterUserId === actor.id && entry.addresseeUserId === target.id) ||
        (entry.requesterUserId === target.id && entry.addresseeUserId === actor.id);

      return samePair && entry.status === "accepted";
    });

    if (!areFriends) {
      throw new Error("direct messages require an accepted friendship");
    }

    const existing = this.chats.find((chat) => {
      if (chat.kind !== "dm") {
        return false;
      }

      const ids = chat.memberIds.slice().sort((a, b) => a - b);
      return ids.length === 2 && ids[0] === Math.min(actor.id, target.id) && ids[1] === Math.max(actor.id, target.id);
    });

    if (existing) {
      return existing;
    }

    const chat = {
      id: this.nextId("chat"),
      kind: "dm",
      title: null,
      createdByUserId: actor.id,
      memberIds: [actor.id, target.id],
      roles: [],
      createdAt: new Date().toISOString()
    };

    this.chats.push(chat);
    return chat;
  }

  createGroupChat({ actorUserId, title, memberUserIds = [] }) {
    const actor = this.requireUser(actorUserId);

    if (!title || typeof title !== "string") {
      throw new Error("title is required");
    }

    const uniqueMemberIds = [...new Set([actor.id, ...memberUserIds.map((value) => this.requireUser(value).id)])];

    const invalidMemberId = uniqueMemberIds.find((memberId) => memberId !== actor.id && !this.areFriends(actor.id, memberId));

    if (invalidMemberId) {
      throw new Error("only friends can be invited to a group");
    }

    const adminRole = {
      id: this.nextId("role"),
      name: "Admin",
      memberIds: [actor.id],
      permissions: this.permissionsFromList(ROLE_PERMISSIONS)
    };

    const chat = {
      id: this.nextId("chat"),
      kind: "group",
      title,
      createdByUserId: actor.id,
      memberIds: uniqueMemberIds,
      roles: [adminRole],
      createdAt: new Date().toISOString()
    };

    this.chats.push(chat);
    this.writeAuditLog({
      chatId: chat.id,
      actorUserId: actor.id,
      eventType: "group.created",
      payload: { title, memberIds: uniqueMemberIds }
    });
    return chat;
  }

  addGroupRole({ chatId, actorUserId, name, permissions }) {
    const actor = this.requireUser(actorUserId);
    const chat = this.requireGroupChat(chatId);

    if (!this.canManageRoles(chat, actor.id)) {
      throw new Error("actor cannot manage roles");
    }

    const role = {
      id: this.nextId("role"),
      name,
      memberIds: [],
      permissions: this.permissionsFromList(permissions || [])
    };

    chat.roles.push(role);
    this.writeAuditLog({
      chatId: chat.id,
      actorUserId: actor.id,
      eventType: "role.created",
      payload: { roleId: role.id, name, permissions: role.permissions }
    });
    return role;
  }

  assignRole({ chatId, roleId, actorUserId, targetUserId }) {
    const actor = this.requireUser(actorUserId);
    const target = this.requireUser(targetUserId);
    const chat = this.requireGroupChat(chatId);
    const role = chat.roles.find((entry) => entry.id === Number(roleId));

    if (!role) {
      throw new Error("role not found");
    }

    if (!chat.memberIds.includes(target.id)) {
      throw new Error("target user is not in the group");
    }

    if (!this.canManageRoles(chat, actor.id)) {
      throw new Error("actor cannot manage roles");
    }

    if (!role.memberIds.includes(target.id)) {
      role.memberIds.push(target.id);
    }

    this.writeAuditLog({
      chatId: chat.id,
      actorUserId: actor.id,
      eventType: "role.assigned",
      payload: { roleId: role.id, targetUserId: target.id }
    });
    return role;
  }

  createMessage({ chatId, actorUserId, body }) {
    const actor = this.requireUser(actorUserId);
    const chat = this.requireChat(chatId);

    if (!chat.memberIds.includes(actor.id)) {
      throw new Error("actor is not a member of this chat");
    }

    if (!body || typeof body !== "string") {
      throw new Error("body is required");
    }

    const message = {
      id: this.nextId("message"),
      chatId: chat.id,
      senderUserId: actor.id,
      body,
      deletedAt: null,
      createdAt: new Date().toISOString()
    };

    this.messages.push(message);
    return message;
  }

  listMessages({ chatId, viewerUserId }) {
    const viewer = this.requireUser(viewerUserId);
    const chat = this.requireChat(chatId);

    if (!chat.memberIds.includes(viewer.id)) {
      throw new Error("viewer is not a member of this chat");
    }

    const blockedUserIds = this.blockedUserIdsFor(viewer.id);

    return this.messages
      .filter((message) => message.chatId === chat.id)
      .filter((message) => !blockedUserIds.has(message.senderUserId))
      .map((message) => ({
        ...message,
        reactions: this.reactions.filter((reaction) => reaction.messageId === message.id)
      }));
  }

  deleteMessage({ chatId, messageId, actorUserId }) {
    const actor = this.requireUser(actorUserId);
    const chat = this.requireChat(chatId);
    const message = this.messages.find(
      (entry) => entry.id === Number(messageId) && entry.chatId === Number(chat.id)
    );

    if (!message) {
      throw new Error("message not found");
    }

    const isSender = message.senderUserId === actor.id;
    const canModerate = chat.kind === "group" && this.canDeleteMessages(chat, actor.id);

    if (!isSender && !canModerate) {
      throw new Error("actor cannot delete this message");
    }

    if (!message.deletedAt) {
      message.deletedAt = new Date().toISOString();
      message.body = "[deleted]";
      this.writeAuditLog({
        chatId: chat.id,
        actorUserId: actor.id,
        eventType: "message.deleted",
        payload: { messageId: message.id }
      });
    }

    return message;
  }

  addReaction({ chatId, messageId, actorUserId, emoji }) {
    const actor = this.requireUser(actorUserId);
    const chat = this.requireChat(chatId);
    const message = this.messages.find(
      (entry) => entry.id === Number(messageId) && entry.chatId === Number(chat.id)
    );

    if (!message) {
      throw new Error("message not found");
    }

    if (!chat.memberIds.includes(actor.id)) {
      throw new Error("actor is not a member of this chat");
    }

    if (!emoji || typeof emoji !== "string") {
      throw new Error("emoji is required");
    }

    const existing = this.reactions.find(
      (entry) => entry.messageId === message.id && entry.userId === actor.id && entry.emoji === emoji
    );

    if (existing) {
      return existing;
    }

    const reaction = {
      id: this.nextId("reaction"),
      messageId: message.id,
      userId: actor.id,
      emoji,
      createdAt: new Date().toISOString()
    };

    this.reactions.push(reaction);
    return reaction;
  }

  removeReaction({ chatId, messageId, actorUserId, emoji }) {
    const actor = this.requireUser(actorUserId);
    const chat = this.requireChat(chatId);
    const message = this.messages.find(
      (entry) => entry.id === Number(messageId) && entry.chatId === Number(chat.id)
    );

    if (!message) {
      throw new Error("message not found");
    }

    const beforeCount = this.reactions.length;

    this.reactions = this.reactions.filter((entry) => {
      return !(entry.messageId === message.id && entry.userId === actor.id && entry.emoji === emoji);
    });

    return { removed: beforeCount !== this.reactions.length };
  }

  listAuditLogs({ chatId, actorUserId }) {
    const actor = this.requireUser(actorUserId);
    const chat = this.requireGroupChat(chatId);

    if (!this.canViewAuditLogs(chat, actor.id)) {
      throw new Error("actor cannot view audit logs");
    }

    return this.auditLogs.filter((entry) => entry.chatId === chat.id);
  }

  writeAuditLog({ chatId, actorUserId, eventType, payload }) {
    this.auditLogs.push({
      id: this.nextId("auditLog"),
      chatId,
      actorUserId,
      eventType,
      payload,
      createdAt: new Date().toISOString()
    });
  }

  canDeleteMessages(chat, userId) {
    return this.hasPermission(chat, userId, "canDeleteMessages");
  }

  canManageRoles(chat, userId) {
    return this.hasPermission(chat, userId, "canManageRoles");
  }

  canViewAuditLogs(chat, userId) {
    return this.hasPermission(chat, userId, "canViewAuditLogs");
  }

  hasPermission(chat, userId, permission) {
    return chat.roles.some((role) => role.memberIds.includes(userId) && role.permissions[permission]);
  }

  blockedUserIdsFor(userId) {
    const blockedIds = new Set();

    for (const entry of this.friendships) {
      if (entry.status !== "blocked") {
        continue;
      }

      if (entry.requesterUserId === userId) {
        blockedIds.add(entry.addresseeUserId);
      }

      if (entry.addresseeUserId === userId) {
        blockedIds.add(entry.requesterUserId);
      }
    }

    return blockedIds;
  }

  areFriends(firstUserId, secondUserId) {
    return this.friendships.some((entry) => {
      if (entry.status !== "accepted") {
        return false;
      }

      return (
        (entry.requesterUserId === firstUserId && entry.addresseeUserId === secondUserId) ||
        (entry.requesterUserId === secondUserId && entry.addresseeUserId === firstUserId)
      );
    });
  }

  isBlockedBetween(firstUserId, secondUserId) {
    return this.friendships.some((entry) => {
      if (entry.status !== "blocked") {
        return false;
      }

      return (
        (entry.requesterUserId === firstUserId && entry.addresseeUserId === secondUserId) ||
        (entry.requesterUserId === secondUserId && entry.addresseeUserId === firstUserId)
      );
    });
  }

  permissionsFromList(permissionList) {
    return ROLE_PERMISSIONS.reduce((permissions, permission) => {
      permissions[permission] = permissionList.includes(permission);
      return permissions;
    }, {});
  }

  assertUserId(userId) {
    if (!USER_ID_PATTERN.test(userId || "")) {
      throw new Error("userId must be 3-32 chars and use alphanumeric, hyphen, underscore");
    }
  }

  requireUser(userId) {
    const normalizedUserId = Number(userId);
    const byNumericId = Number.isFinite(normalizedUserId) ? this.findUserById(normalizedUserId) : null;
    const user = byNumericId || this.findUserByUserId(userId);

    if (!user) {
      throw new Error("user not found");
    }

    return user;
  }

  requireChat(chatId) {
    const chat = this.chats.find((entry) => entry.id === Number(chatId));

    if (!chat) {
      throw new Error("chat not found");
    }

    return chat;
  }

  requireGroupChat(chatId) {
    const chat = this.requireChat(chatId);

    if (chat.kind !== "group") {
      throw new Error("group chat not found");
    }

    return chat;
  }

  findUserById(id) {
    return this.users.find((user) => user.id === Number(id)) || null;
  }

  findUserByUserId(userId) {
    return this.users.find((user) => user.userId === userId) || null;
  }

  findFriendshipPair(firstUserId, secondUserId) {
    return this.friendships.find((entry) => {
      return (
        (entry.requesterUserId === firstUserId && entry.addresseeUserId === secondUserId) ||
        (entry.requesterUserId === secondUserId && entry.addresseeUserId === firstUserId)
      );
    });
  }

  findDirectedFriendship(requesterUserId, addresseeUserId) {
    return this.friendships.find((entry) => {
      return entry.requesterUserId === requesterUserId && entry.addresseeUserId === addresseeUserId;
    });
  }

  getReadState(chatId, userId) {
    return this.readStates.find((entry) => entry.chatId === Number(chatId) && entry.userId === Number(userId)) || null;
  }

  nextId(key) {
    const value = this.counters[key];
    this.counters[key] += 1;
    return value;
  }
}

module.exports = {
  AppStore,
  ROLE_PERMISSIONS
};
