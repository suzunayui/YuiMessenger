const crypto = require("crypto");

const USER_ID_PATTERN = /^(?![_-])[A-Za-z0-9_-]{3,32}(?<![_-])$/;
const ROLE_PERMISSIONS = ["canDeleteMessages", "canKickMembers", "canEditGroupName", "canInviteMembers", "canManageRoles", "canViewAuditLogs", "canDeleteAuditLogs"];

class AppStore {
  constructor(pool) {
    this.pool = pool;
  }

  async createUser({ userId, displayName }) {
    this.assertUserId(userId);
    if (!displayName || typeof displayName !== "string") {
      throw new Error("displayName is required");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO users (user_id, display_name, webauthn_user_id)
         VALUES ($1, $2, $3)
         RETURNING id, user_id, display_name, webauthn_user_id, created_at`,
        [userId, displayName, `wa-${crypto.randomUUID()}`]
      );
      const user = mapUser(inserted.rows[0]);
      await client.query(
        `INSERT INTO presence_states (user_id, status, is_visible, is_manual)
         VALUES ($1, 'offline', TRUE, FALSE)`,
        [user.id]
      );
      await client.query("COMMIT");
      return user;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        throw new Error("userId already exists");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listUsers() {
    const result = await this.pool.query(
      `SELECT id, user_id, display_name, webauthn_user_id, created_at
       FROM users ORDER BY id ASC`
    );
    return result.rows.map(mapUser);
  }

  async requireUser(userId) {
    const numeric = Number(userId);
    const result = Number.isFinite(numeric)
      ? await this.pool.query(`SELECT id, user_id, display_name, webauthn_user_id, created_at FROM users WHERE id = $1`, [numeric])
      : await this.pool.query(`SELECT id, user_id, display_name, webauthn_user_id, created_at FROM users WHERE user_id = $1`, [String(userId)]);
    if (result.rowCount === 0) {
      throw new Error("user not found");
    }
    return mapUser(result.rows[0]);
  }

  async listPasskeysForUser(userId) {
    const user = await this.requireUser(userId);
    const result = await this.pool.query(`SELECT * FROM passkeys WHERE user_id = $1 ORDER BY created_at ASC`, [user.id]);
    return result.rows.map(mapPasskey);
  }

  async saveRegistrationChallenge(userId, challenge) {
    return this.saveChallenge(userId, "registration", challenge);
  }

  async readRegistrationChallenge(userId) {
    return this.readChallenge(userId, "registration");
  }

  async clearRegistrationChallenge(userId) {
    return this.clearChallenge(userId, "registration");
  }

  async saveAuthenticationChallenge(userId, challenge) {
    return this.saveChallenge(userId, "authentication", challenge);
  }

  async readAuthenticationChallenge(userId) {
    return this.readChallenge(userId, "authentication");
  }

  async clearAuthenticationChallenge(userId) {
    return this.clearChallenge(userId, "authentication");
  }

  async addPasskey({ userId, credentialId, publicKey, counter, transports = [], deviceType, backedUp }) {
    const user = await this.requireUser(userId);
    try {
      const result = await this.pool.query(
        `INSERT INTO passkeys (
           id, user_id, webauthn_user_id, credential_id, public_key, counter, transports, device_type, backed_up
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         RETURNING *`,
        [crypto.randomUUID(), user.id, user.webauthnUserID, credentialId, publicKey, counter, JSON.stringify(transports), deviceType || null, Boolean(backedUp)]
      );
      return mapPasskey(result.rows[0]);
    } catch (error) {
      if (error.code === "23505") {
        throw new Error("passkey already registered");
      }
      throw error;
    }
  }

  async findPasskeyByCredentialId(credentialId) {
    const result = await this.pool.query(`SELECT * FROM passkeys WHERE credential_id = $1`, [credentialId]);
    return result.rowCount === 0 ? null : mapPasskey(result.rows[0]);
  }

  async updatePasskeyCounter(credentialId, counter) {
    const result = await this.pool.query(
      `UPDATE passkeys SET counter = $2, updated_at = NOW() WHERE credential_id = $1 RETURNING *`,
      [credentialId, counter]
    );
    if (result.rowCount === 0) {
      throw new Error("passkey not found");
    }
    return mapPasskey(result.rows[0]);
  }

  async getPresence(userId) {
    const user = await this.requireUser(userId);
    const result = await this.pool.query(
      `SELECT user_id, status, is_visible, is_manual, updated_at FROM presence_states WHERE user_id = $1`,
      [user.id]
    );
    if (result.rowCount === 0) {
      throw new Error("presence not found");
    }
    return mapPresence(result.rows[0]);
  }

  async updatePresence({ userId, status, isVisible, isManual }) {
    const user = await this.requireUser(userId);
    const current = await this.getPresence(user.id);
    const nextStatus = status || current.status;
    if (!["online", "offline", "away"].includes(nextStatus)) {
      throw new Error("status must be online, offline, or away");
    }
    const result = await this.pool.query(
      `UPDATE presence_states
       SET status = $2, is_visible = $3, is_manual = $4, updated_at = NOW()
       WHERE user_id = $1
       RETURNING user_id, status, is_visible, is_manual, updated_at`,
      [user.id, nextStatus, typeof isVisible === "boolean" ? isVisible : current.isVisible, typeof isManual === "boolean" ? isManual : current.isManual]
    );
    return mapPresence(result.rows[0]);
  }

  async setNotificationSetting({ actorUserId, scopeType, scopeId, enabled }) {
    const actor = await this.requireUser(actorUserId);
    if (!["dm", "group"].includes(scopeType)) {
      throw new Error("scopeType must be dm or group");
    }
    const chat = await this.requireChat(scopeId);
    if (chat.kind !== scopeType) {
      throw new Error("scopeType does not match chat kind");
    }
    if (!chat.memberIds.includes(actor.id)) {
      throw new Error("actor is not a member of this chat");
    }
    const result = await this.pool.query(
      `INSERT INTO notification_settings (user_id, scope_type, scope_id, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, scope_type, scope_id)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
       RETURNING user_id, scope_type, scope_id, enabled, updated_at`,
      [actor.id, scopeType, chat.id, Boolean(enabled)]
    );
    return mapNotificationSetting(result.rows[0]);
  }

  async listNotificationSettings(userId) {
    const user = await this.requireUser(userId);
    const result = await this.pool.query(
      `SELECT user_id, scope_type, scope_id, enabled, updated_at
       FROM notification_settings WHERE user_id = $1 ORDER BY scope_type, scope_id`,
      [user.id]
    );
    return result.rows.map(mapNotificationSetting);
  }

  async listChatsForUser(userId) {
    const user = await this.requireUser(userId);
    const blockedIds = await this.blockedUserIdsFor(user.id);
    const result = await this.pool.query(
      `SELECT c.id, c.kind, c.title, c.created_by_user_id, c.created_at
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id
       WHERE cm.user_id = $1
       ORDER BY c.id DESC`,
      [user.id]
    );

    const chats = [];
    for (const row of result.rows) {
      const chat = await this.requireChat(row.id);
      const readState = await this.getReadState(chat.id, user.id);
      const lastMessageResult = blockedIds.length > 0
        ? await this.pool.query(
            `SELECT id, chat_id, sender_user_id, body, deleted_at, created_at
             FROM messages
             WHERE chat_id = $1 AND NOT (sender_user_id = ANY($2::bigint[]))
             ORDER BY id DESC
             LIMIT 1`,
            [chat.id, blockedIds]
          )
        : await this.pool.query(
            `SELECT id, chat_id, sender_user_id, body, deleted_at, created_at
             FROM messages
             WHERE chat_id = $1
             ORDER BY id DESC
             LIMIT 1`,
            [chat.id]
          );

      const unreadResult = blockedIds.length > 0
        ? await this.pool.query(
            `SELECT COUNT(*)::int AS unread_count
             FROM messages
             WHERE chat_id = $1 AND sender_user_id <> $2 AND id > $3 AND NOT (sender_user_id = ANY($4::bigint[]))`,
            [chat.id, user.id, readState?.lastReadMessageId || 0, blockedIds]
          )
        : await this.pool.query(
            `SELECT COUNT(*)::int AS unread_count
             FROM messages
             WHERE chat_id = $1 AND sender_user_id <> $2 AND id > $3`,
            [chat.id, user.id, readState?.lastReadMessageId || 0]
          );

      chats.push({
        ...chat,
        lastMessage: lastMessageResult.rowCount > 0 ? mapMessage(lastMessageResult.rows[0], []) : null,
        unreadCount: unreadResult.rows[0].unread_count
      });
    }

    return chats;
  }

  async getUnreadSummary(userId) {
    const user = await this.requireUser(userId);
    const blockedIds = await this.blockedUserIdsFor(user.id);
    const memberResult = await this.pool.query(
      `SELECT c.id, c.kind
       FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
       WHERE cm.user_id = $1 ORDER BY c.id`,
      [user.id]
    );
    const summaries = [];
    for (const row of memberResult.rows) {
      const readState = await this.getReadState(row.id, user.id);
      const unreadResult = blockedIds.length > 0
        ? await this.pool.query(
            `SELECT COUNT(*)::int AS unread_count
             FROM messages
             WHERE chat_id = $1 AND sender_user_id <> $2 AND id > $3 AND NOT (sender_user_id = ANY($4::bigint[]))`,
            [row.id, user.id, readState?.lastReadMessageId || 0, blockedIds]
          )
        : await this.pool.query(
            `SELECT COUNT(*)::int AS unread_count
             FROM messages
             WHERE chat_id = $1 AND sender_user_id <> $2 AND id > $3`,
            [row.id, user.id, readState?.lastReadMessageId || 0]
          );
      summaries.push({ chatId: Number(row.id), kind: row.kind, unreadCount: unreadResult.rows[0].unread_count });
    }
    return summaries;
  }

  async markChatRead({ chatId, actorUserId, lastReadMessageId }) {
    const actor = await this.requireUser(actorUserId);
    const chat = await this.requireChat(chatId);
    if (!chat.memberIds.includes(actor.id)) {
      throw new Error("actor is not a member of this chat");
    }
    const result = await this.pool.query(
      `INSERT INTO read_states (chat_id, user_id, last_read_message_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (chat_id, user_id)
       DO UPDATE SET last_read_message_id = EXCLUDED.last_read_message_id, updated_at = NOW()
       RETURNING chat_id, user_id, last_read_message_id, updated_at`,
      [chat.id, actor.id, Number(lastReadMessageId || 0)]
    );
    return mapReadState(result.rows[0]);
  }

  async createFriendRequest({ requesterUserId, addresseeUserId }) {
    const requester = await this.requireUser(requesterUserId);
    const addressee = await this.requireUser(addresseeUserId);
    if (requester.id === addressee.id) {
      throw new Error("cannot friend yourself");
    }
    if (await this.isBlockedBetween(requester.id, addressee.id)) {
      throw new Error("friend request not allowed because one user blocked the other");
    }
    if (await this.findFriendshipPair(requester.id, addressee.id)) {
      throw new Error("friendship or request already exists");
    }
    const result = await this.pool.query(
      `INSERT INTO friendships (requester_user_id, addressee_user_id, status)
       VALUES ($1, $2, 'pending')
       RETURNING *`,
      [requester.id, addressee.id]
    );
    return mapFriendship(result.rows[0]);
  }

  async respondToFriendRequest({ requestId, actorUserId, action }) {
    const actor = await this.requireUser(actorUserId);
    const result = await this.pool.query(`SELECT * FROM friendships WHERE id = $1`, [Number(requestId)]);
    if (result.rowCount === 0 || result.rows[0].status !== "pending") {
      throw new Error("pending friend request not found");
    }
    const friendship = result.rows[0];
    if (Number(friendship.addressee_user_id) !== actor.id) {
      throw new Error("only the addressee can respond");
    }
    if (!["accepted", "rejected"].includes(action)) {
      throw new Error("action must be accepted or rejected");
    }
    if (action === "accepted") {
      const updated = await this.pool.query(
        `UPDATE friendships
         SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [friendship.id]
      );
      return mapFriendship(updated.rows[0]);
    }
    await this.pool.query(`DELETE FROM friendships WHERE id = $1`, [friendship.id]);
    return { id: Number(friendship.id), status: "rejected" };
  }

  async blockUser({ actorUserId, targetUserId }) {
    const actor = await this.requireUser(actorUserId);
    const target = await this.requireUser(targetUserId);
    if (actor.id === target.id) {
      throw new Error("cannot block yourself");
    }
    const existing = await this.findDirectedFriendship(actor.id, target.id);
    if (existing) {
      const updated = await this.pool.query(
        `UPDATE friendships
         SET status = 'blocked', blocked_by_user_id = $2, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [existing.id, actor.id]
      );
      return mapFriendship(updated.rows[0]);
    }
    const inserted = await this.pool.query(
      `INSERT INTO friendships (requester_user_id, addressee_user_id, status, blocked_by_user_id)
       VALUES ($1, $2, 'blocked', $1)
       RETURNING *`,
      [actor.id, target.id]
    );
    return mapFriendship(inserted.rows[0]);
  }

  async listFriendshipsForUser(userId) {
    const user = await this.requireUser(userId);
    const result = await this.pool.query(
      `SELECT f.*,
              ru.user_id AS requester_user_id_text,
              ru.display_name AS requester_display_name,
              au.user_id AS addressee_user_id_text,
              au.display_name AS addressee_display_name
       FROM friendships f
       JOIN users ru ON ru.id = f.requester_user_id
       JOIN users au ON au.id = f.addressee_user_id
       WHERE f.requester_user_id = $1 OR f.addressee_user_id = $1
       ORDER BY f.id`,
      [user.id]
    );
    return result.rows.map((row) => ({
      ...mapFriendship(row),
      requester: { id: Number(row.requester_user_id), userId: row.requester_user_id_text, displayName: row.requester_display_name },
      addressee: { id: Number(row.addressee_user_id), userId: row.addressee_user_id_text, displayName: row.addressee_display_name }
    }));
  }

  async createDirectMessageChat({ actorUserId, targetUserId }) {
    const actor = await this.requireUser(actorUserId);
    const target = await this.requireUser(targetUserId);
    if (await this.isBlockedBetween(actor.id, target.id)) {
      throw new Error("cannot create DM because one user blocked the other");
    }
    if (!(await this.areFriends(actor.id, target.id))) {
      throw new Error("direct messages require an accepted friendship");
    }
    const existing = await this.pool.query(
      `SELECT c.id
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id
       WHERE c.kind = 'dm'
       GROUP BY c.id
       HAVING COUNT(*) = 2 AND BOOL_OR(cm.user_id = $1) AND BOOL_OR(cm.user_id = $2)`,
      [actor.id, target.id]
    );
    if (existing.rowCount > 0) {
      return this.requireChat(existing.rows[0].id);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const chatInsert = await client.query(
        `INSERT INTO chats (kind, title, created_by_user_id)
         VALUES ('dm', NULL, $1)
         RETURNING id`,
        [actor.id]
      );
      const chatId = chatInsert.rows[0].id;
      await client.query(`INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)`, [chatId, actor.id, target.id]);
      await client.query("COMMIT");
      return this.requireChat(chatId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createGroupChat({ actorUserId, title, memberUserIds = [] }) {
    const actor = await this.requireUser(actorUserId);
    if (!title || typeof title !== "string") {
      throw new Error("title is required");
    }
    const resolvedMembers = [];
    for (const value of memberUserIds) {
      const user = await this.requireUser(value);
      resolvedMembers.push(user.id);
    }
    const uniqueMemberIds = [...new Set([actor.id, ...resolvedMembers])];
    for (const memberId of uniqueMemberIds) {
      if (memberId !== actor.id && !(await this.areFriends(actor.id, memberId))) {
        throw new Error("only friends can be invited to a group");
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const chatInsert = await client.query(
        `INSERT INTO chats (kind, title, created_by_user_id)
         VALUES ('group', $1, $2)
         RETURNING id`,
        [title, actor.id]
      );
      const chatId = chatInsert.rows[0].id;
      for (const memberId of uniqueMemberIds) {
        await client.query(`INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)`, [chatId, memberId]);
      }
      const roleInsert = await client.query(
        `INSERT INTO group_roles (
           chat_id, name, can_delete_messages, can_kick_members, can_edit_group_name,
           can_invite_members, can_manage_roles, can_view_audit_logs, can_delete_audit_logs
         )
         VALUES ($1, 'Admin', TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE)
         RETURNING id`,
        [chatId]
      );
      await client.query(`INSERT INTO group_role_members (role_id, user_id) VALUES ($1, $2)`, [roleInsert.rows[0].id, actor.id]);
      await client.query(
        `INSERT INTO audit_logs (chat_id, actor_user_id, event_type, payload)
         VALUES ($1, $2, 'group.created', $3::jsonb)`,
        [chatId, actor.id, JSON.stringify({ title, memberIds: uniqueMemberIds })]
      );
      await client.query("COMMIT");
      return this.requireChat(chatId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async requireChat(chatId) {
    const chatResult = await this.pool.query(
      `SELECT id, kind, title, created_by_user_id, created_at FROM chats WHERE id = $1`,
      [Number(chatId)]
    );
    if (chatResult.rowCount === 0) {
      throw new Error("chat not found");
    }
    const chat = chatResult.rows[0];
    const members = await this.pool.query(`SELECT user_id FROM chat_members WHERE chat_id = $1 ORDER BY user_id`, [chat.id]);
    const roles = chat.kind === "group" ? await this.listRolesForChat(chat.id) : [];
    return {
      id: Number(chat.id),
      kind: chat.kind,
      title: chat.title,
      createdByUserId: chat.created_by_user_id ? Number(chat.created_by_user_id) : null,
      memberIds: members.rows.map((row) => Number(row.user_id)),
      roles,
      createdAt: chat.created_at.toISOString()
    };
  }

  async requireGroupChat(chatId) {
    const chat = await this.requireChat(chatId);
    if (chat.kind !== "group") {
      throw new Error("group chat not found");
    }
    return chat;
  }

  async addGroupRole({ chatId, actorUserId, name, permissions }) {
    const actor = await this.requireUser(actorUserId);
    const chat = await this.requireGroupChat(chatId);
    if (!(await this.canManageRoles(chat, actor.id))) {
      throw new Error("actor cannot manage roles");
    }
    const permissionMap = this.permissionsFromList(permissions || []);
    const result = await this.pool.query(
      `INSERT INTO group_roles (
         chat_id, name, can_delete_messages, can_kick_members, can_edit_group_name,
         can_invite_members, can_manage_roles, can_view_audit_logs, can_delete_audit_logs
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [chat.id, name, permissionMap.canDeleteMessages, permissionMap.canKickMembers, permissionMap.canEditGroupName, permissionMap.canInviteMembers, permissionMap.canManageRoles, permissionMap.canViewAuditLogs, permissionMap.canDeleteAuditLogs]
    );
    await this.writeAuditLog({ chatId: chat.id, actorUserId: actor.id, eventType: "role.created", payload: { roleId: result.rows[0].id, name, permissions: permissionMap } });
    return this.getRoleById(result.rows[0].id);
  }

  async assignRole({ chatId, roleId, actorUserId, targetUserId }) {
    const actor = await this.requireUser(actorUserId);
    const target = await this.requireUser(targetUserId);
    const chat = await this.requireGroupChat(chatId);
    const role = await this.getRoleById(roleId);
    if (!role || role.chatId !== chat.id) {
      throw new Error("role not found");
    }
    if (!chat.memberIds.includes(target.id)) {
      throw new Error("target user is not in the group");
    }
    if (!(await this.canManageRoles(chat, actor.id))) {
      throw new Error("actor cannot manage roles");
    }
    await this.pool.query(`INSERT INTO group_role_members (role_id, user_id) VALUES ($1, $2) ON CONFLICT (role_id, user_id) DO NOTHING`, [role.id, target.id]);
    await this.writeAuditLog({ chatId: chat.id, actorUserId: actor.id, eventType: "role.assigned", payload: { roleId: role.id, targetUserId: target.id } });
    return this.getRoleById(role.id);
  }

  async createMessage({ chatId, actorUserId, body }) {
    const actor = await this.requireUser(actorUserId);
    const chat = await this.requireChat(chatId);
    if (!chat.memberIds.includes(actor.id)) {
      throw new Error("actor is not a member of this chat");
    }
    if (!body || typeof body !== "string") {
      throw new Error("body is required");
    }
    const result = await this.pool.query(
      `INSERT INTO messages (chat_id, sender_user_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, chat_id, sender_user_id, body, deleted_at, created_at`,
      [chat.id, actor.id, body]
    );
    return mapMessage(result.rows[0], []);
  }

  async listMessages({ chatId, viewerUserId }) {
    const viewer = await this.requireUser(viewerUserId);
    const chat = await this.requireChat(chatId);
    if (!chat.memberIds.includes(viewer.id)) {
      throw new Error("viewer is not a member of this chat");
    }
    const blockedIds = await this.blockedUserIdsFor(viewer.id);
    const result = blockedIds.length > 0
      ? await this.pool.query(
          `SELECT id, chat_id, sender_user_id, body, deleted_at, created_at
           FROM messages
           WHERE chat_id = $1 AND NOT (sender_user_id = ANY($2::bigint[]))
           ORDER BY id ASC`,
          [chat.id, blockedIds]
        )
      : await this.pool.query(
          `SELECT id, chat_id, sender_user_id, body, deleted_at, created_at
           FROM messages
           WHERE chat_id = $1
           ORDER BY id ASC`,
          [chat.id]
        );
    const messageIds = result.rows.map((row) => Number(row.id));
    const reactions = messageIds.length > 0 ? await this.getReactionsForMessages(messageIds) : new Map();
    return result.rows.map((row) => mapMessage(row, reactions.get(Number(row.id)) || []));
  }

  async deleteMessage({ chatId, messageId, actorUserId }) {
    const actor = await this.requireUser(actorUserId);
    const chat = await this.requireChat(chatId);
    const result = await this.pool.query(
      `SELECT id, chat_id, sender_user_id, body, deleted_at, created_at
       FROM messages
       WHERE id = $1 AND chat_id = $2`,
      [Number(messageId), Number(chat.id)]
    );
    if (result.rowCount === 0) {
      throw new Error("message not found");
    }
    const message = result.rows[0];
    const isSender = Number(message.sender_user_id) === actor.id;
    const canModerate = chat.kind === "group" && (await this.canDeleteMessages(chat, actor.id));
    if (!isSender && !canModerate) {
      throw new Error("actor cannot delete this message");
    }
    const updated = await this.pool.query(
      `UPDATE messages SET deleted_at = COALESCE(deleted_at, NOW()), body = '[deleted]' WHERE id = $1
       RETURNING id, chat_id, sender_user_id, body, deleted_at, created_at`,
      [message.id]
    );
    await this.writeAuditLog({ chatId: chat.id, actorUserId: actor.id, eventType: "message.deleted", payload: { messageId: Number(message.id) } });
    return mapMessage(updated.rows[0], []);
  }

  async addReaction({ chatId, messageId, actorUserId, emoji }) {
    const actor = await this.requireUser(actorUserId);
    const chat = await this.requireChat(chatId);
    if (!chat.memberIds.includes(actor.id)) {
      throw new Error("actor is not a member of this chat");
    }
    if (!emoji || typeof emoji !== "string") {
      throw new Error("emoji is required");
    }
    const message = await this.pool.query(`SELECT id FROM messages WHERE id = $1 AND chat_id = $2`, [Number(messageId), chat.id]);
    if (message.rowCount === 0) {
      throw new Error("message not found");
    }
    const result = await this.pool.query(
      `INSERT INTO message_reactions (message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id, emoji) DO UPDATE SET emoji = EXCLUDED.emoji
       RETURNING id, message_id, user_id, emoji, created_at`,
      [Number(messageId), actor.id, emoji]
    );
    return mapReaction(result.rows[0]);
  }

  async removeReaction({ chatId, messageId, actorUserId, emoji }) {
    const actor = await this.requireUser(actorUserId);
    const chat = await this.requireChat(chatId);
    if (!chat.memberIds.includes(actor.id)) {
      throw new Error("actor is not a member of this chat");
    }
    const deleted = await this.pool.query(`DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`, [Number(messageId), actor.id, emoji]);
    return { removed: deleted.rowCount > 0 };
  }

  async listAuditLogs({ chatId, actorUserId }) {
    const actor = await this.requireUser(actorUserId);
    const chat = await this.requireGroupChat(chatId);
    if (!(await this.canViewAuditLogs(chat, actor.id))) {
      throw new Error("actor cannot view audit logs");
    }
    const result = await this.pool.query(
      `SELECT id, chat_id, actor_user_id, event_type, payload, created_at
       FROM audit_logs
       WHERE chat_id = $1
       ORDER BY id DESC`,
      [chat.id]
    );
    return result.rows.map(mapAuditLog);
  }

  async writeAuditLog({ chatId, actorUserId, eventType, payload }) {
    await this.pool.query(
      `INSERT INTO audit_logs (chat_id, actor_user_id, event_type, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [chatId, actorUserId, eventType, JSON.stringify(payload || {})]
    );
  }

  async canDeleteMessages(chat, userId) {
    return this.hasPermission(chat.id, userId, "can_delete_messages");
  }

  async canManageRoles(chat, userId) {
    return this.hasPermission(chat.id, userId, "can_manage_roles");
  }

  async canViewAuditLogs(chat, userId) {
    return this.hasPermission(chat.id, userId, "can_view_audit_logs");
  }

  async hasPermission(chatId, userId, columnName) {
    const result = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1
         FROM group_roles gr
         JOIN group_role_members grm ON grm.role_id = gr.id
         WHERE gr.chat_id = $1 AND grm.user_id = $2 AND ${columnName} = TRUE
       ) AS allowed`,
      [chatId, userId]
    );
    return result.rows[0].allowed;
  }

  async blockedUserIdsFor(userId) {
    const result = await this.pool.query(
      `SELECT requester_user_id, addressee_user_id
       FROM friendships
       WHERE status = 'blocked' AND (requester_user_id = $1 OR addressee_user_id = $1)`,
      [userId]
    );
    return result.rows.map((row) => Number(row.requester_user_id) === Number(userId) ? Number(row.addressee_user_id) : Number(row.requester_user_id));
  }

  async areFriends(firstUserId, secondUserId) {
    const result = await this.pool.query(
      `SELECT 1
       FROM friendships
       WHERE status = 'accepted'
         AND ((requester_user_id = $1 AND addressee_user_id = $2) OR (requester_user_id = $2 AND addressee_user_id = $1))
       LIMIT 1`,
      [firstUserId, secondUserId]
    );
    return result.rowCount > 0;
  }

  async isBlockedBetween(firstUserId, secondUserId) {
    const result = await this.pool.query(
      `SELECT 1
       FROM friendships
       WHERE status = 'blocked'
         AND ((requester_user_id = $1 AND addressee_user_id = $2) OR (requester_user_id = $2 AND addressee_user_id = $1))
       LIMIT 1`,
      [firstUserId, secondUserId]
    );
    return result.rowCount > 0;
  }

  async findFriendshipPair(firstUserId, secondUserId) {
    const result = await this.pool.query(
      `SELECT * FROM friendships
       WHERE (requester_user_id = $1 AND addressee_user_id = $2) OR (requester_user_id = $2 AND addressee_user_id = $1)
       LIMIT 1`,
      [firstUserId, secondUserId]
    );
    return result.rowCount === 0 ? null : mapFriendship(result.rows[0]);
  }

  async findDirectedFriendship(requesterUserId, addresseeUserId) {
    const result = await this.pool.query(
      `SELECT * FROM friendships WHERE requester_user_id = $1 AND addressee_user_id = $2 LIMIT 1`,
      [requesterUserId, addresseeUserId]
    );
    return result.rowCount === 0 ? null : mapFriendship(result.rows[0]);
  }

  async getReadState(chatId, userId) {
    const result = await this.pool.query(
      `SELECT chat_id, user_id, last_read_message_id, updated_at
       FROM read_states
       WHERE chat_id = $1 AND user_id = $2`,
      [Number(chatId), Number(userId)]
    );
    return result.rowCount === 0 ? null : mapReadState(result.rows[0]);
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

  async saveChallenge(userId, challengeType, challenge) {
    const user = await this.requireUser(userId);
    await this.pool.query(
      `INSERT INTO webauthn_challenges (user_id, challenge_type, challenge)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, challenge_type)
       DO UPDATE SET challenge = EXCLUDED.challenge, created_at = NOW()`,
      [user.id, challengeType, challenge]
    );
    return challenge;
  }

  async readChallenge(userId, challengeType) {
    const user = await this.requireUser(userId);
    const result = await this.pool.query(`SELECT challenge FROM webauthn_challenges WHERE user_id = $1 AND challenge_type = $2`, [user.id, challengeType]);
    return result.rowCount === 0 ? null : result.rows[0].challenge;
  }

  async clearChallenge(userId, challengeType) {
    const user = await this.requireUser(userId);
    await this.pool.query(`DELETE FROM webauthn_challenges WHERE user_id = $1 AND challenge_type = $2`, [user.id, challengeType]);
  }

  async getReactionsForMessages(messageIds) {
    const result = await this.pool.query(
      `SELECT id, message_id, user_id, emoji, created_at
       FROM message_reactions
       WHERE message_id = ANY($1::bigint[])
       ORDER BY id ASC`,
      [messageIds]
    );
    const grouped = new Map();
    for (const row of result.rows) {
      const reaction = mapReaction(row);
      const list = grouped.get(reaction.messageId) || [];
      list.push(reaction);
      grouped.set(reaction.messageId, list);
    }
    return grouped;
  }

  async listRolesForChat(chatId) {
    const roles = await this.pool.query(`SELECT * FROM group_roles WHERE chat_id = $1 ORDER BY id ASC`, [chatId]);
    const memberships = await this.pool.query(
      `SELECT grm.role_id, grm.user_id
       FROM group_role_members grm
       JOIN group_roles gr ON gr.id = grm.role_id
       WHERE gr.chat_id = $1
       ORDER BY grm.role_id, grm.user_id`,
      [chatId]
    );
    const membersByRole = new Map();
    for (const row of memberships.rows) {
      const roleId = Number(row.role_id);
      const memberIds = membersByRole.get(roleId) || [];
      memberIds.push(Number(row.user_id));
      membersByRole.set(roleId, memberIds);
    }
    return roles.rows.map((row) => mapRole(row, membersByRole.get(Number(row.id)) || []));
  }

  async getRoleById(roleId) {
    const roleResult = await this.pool.query(`SELECT * FROM group_roles WHERE id = $1`, [Number(roleId)]);
    if (roleResult.rowCount === 0) {
      return null;
    }
    const memberships = await this.pool.query(`SELECT user_id FROM group_role_members WHERE role_id = $1 ORDER BY user_id`, [Number(roleId)]);
    return mapRole(roleResult.rows[0], memberships.rows.map((row) => Number(row.user_id)));
  }
}

function mapUser(row) {
  return { id: Number(row.id), userId: row.user_id, displayName: row.display_name, webauthnUserID: row.webauthn_user_id, createdAt: row.created_at.toISOString() };
}

function mapPasskey(row) {
  return { id: row.id, userId: Number(row.user_id), webauthnUserID: row.webauthn_user_id, credentialId: row.credential_id, publicKey: row.public_key, counter: Number(row.counter), transports: Array.isArray(row.transports) ? row.transports : [], deviceType: row.device_type, backedUp: row.backed_up, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at ? row.updated_at.toISOString() : null };
}

function mapPresence(row) {
  return { userId: Number(row.user_id), status: row.status, isVisible: row.is_visible, isManual: row.is_manual, updatedAt: row.updated_at.toISOString() };
}

function mapNotificationSetting(row) {
  return { userId: Number(row.user_id), scopeType: row.scope_type, scopeId: Number(row.scope_id), enabled: row.enabled, updatedAt: row.updated_at.toISOString() };
}

function mapReadState(row) {
  return { chatId: Number(row.chat_id), userId: Number(row.user_id), lastReadMessageId: Number(row.last_read_message_id), updatedAt: row.updated_at.toISOString() };
}

function mapFriendship(row) {
  return { id: Number(row.id), requesterUserId: Number(row.requester_user_id), addresseeUserId: Number(row.addressee_user_id), status: row.status, blockedByUserId: row.blocked_by_user_id ? Number(row.blocked_by_user_id) : null, createdAt: row.created_at.toISOString(), acceptedAt: row.accepted_at ? row.accepted_at.toISOString() : null, updatedAt: row.updated_at ? row.updated_at.toISOString() : null };
}

function mapRole(row, memberIds) {
  return { id: Number(row.id), chatId: Number(row.chat_id), name: row.name, memberIds, permissions: { canDeleteMessages: row.can_delete_messages, canKickMembers: row.can_kick_members, canEditGroupName: row.can_edit_group_name, canInviteMembers: row.can_invite_members, canManageRoles: row.can_manage_roles, canViewAuditLogs: row.can_view_audit_logs, canDeleteAuditLogs: row.can_delete_audit_logs } };
}

function mapMessage(row, reactions) {
  return { id: Number(row.id), chatId: Number(row.chat_id), senderUserId: row.sender_user_id ? Number(row.sender_user_id) : null, body: row.body, deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null, createdAt: row.created_at.toISOString(), reactions };
}

function mapReaction(row) {
  return { id: Number(row.id), messageId: Number(row.message_id), userId: Number(row.user_id), emoji: row.emoji, createdAt: row.created_at.toISOString() };
}

function mapAuditLog(row) {
  return { id: Number(row.id), chatId: row.chat_id ? Number(row.chat_id) : null, actorUserId: row.actor_user_id ? Number(row.actor_user_id) : null, eventType: row.event_type, payload: row.payload, createdAt: row.created_at.toISOString() };
}

module.exports = { AppStore, ROLE_PERMISSIONS };
