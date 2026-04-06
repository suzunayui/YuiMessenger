const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require("@simplewebauthn/server");
const { isoUint8Array } = require("@simplewebauthn/server/helpers");
const { AppStore, ROLE_PERMISSIONS } = require("./store");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL;
const rpID = process.env.RP_ID || "localhost";
const rpName = process.env.RP_NAME || "YuiMessenger";
const expectedOrigin = process.env.EXPECTED_ORIGIN || `http://${rpID}:${port}`;

app.use(express.json());
app.use(express.static("public"));

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({
  connectionString: databaseUrl
});

const store = new AppStore(pool);

app.get("/api/health", async (_req, res) => {
  const status = { app: "ok", database: "ok", websocket: "ok" };
  if (pool) {
    try {
      await pool.query("SELECT 1");
    } catch (error) {
      status.database = "error";
      status.error = error.message;
    }
  }

  res.json(status);
});

app.get("/api/spec-summary", (_req, res) => {
  res.json({
    name: "YuiMessenger",
    auth: "passkey-only",
    database: "Postgres",
    realtime: ["websocket", "presence", "typing", "notifications"],
    features: ["friends", "direct-messages", "groups", "roles", "reactions"],
    rolePermissions: ROLE_PERMISSIONS
  });
});

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendBadRequest(res, error);
    }
  };
}

app.get("/api/users", wrap(async (_req, res) => {
  res.json(await store.listUsers());
}));

app.post("/api/users", wrap(async (req, res) => {
  res.status(201).json(await store.createUser(req.body));
}));

app.get("/api/users/:userId/passkeys", wrap(async (req, res) => {
  res.json(await store.listPasskeysForUser(req.params.userId));
}));

app.get("/api/users/:userId/presence", wrap(async (req, res) => {
  res.json(await store.getPresence(req.params.userId));
}));

app.patch("/api/users/:userId/presence", wrap(async (req, res) => {
  const presence = await store.updatePresence({
    userId: req.params.userId,
    status: req.body.status,
    isVisible: req.body.isVisible,
    isManual: req.body.isManual
  });
  broadcast({ type: "presence.updated", payload: presence });
  res.json(presence);
}));

app.get("/api/users/:userId/notifications", wrap(async (req, res) => {
  res.json(await store.listNotificationSettings(req.params.userId));
}));

app.post("/api/users/:userId/notifications", wrap(async (req, res) => {
  res.json(await store.setNotificationSetting({
    actorUserId: req.params.userId,
    scopeType: req.body.scopeType,
    scopeId: req.body.scopeId,
    enabled: req.body.enabled
  }));
}));

app.get("/api/users/:userId/chats", wrap(async (req, res) => {
  res.json(await store.listChatsForUser(req.params.userId));
}));

app.get("/api/users/:userId/unreads", wrap(async (req, res) => {
  res.json(await store.getUnreadSummary(req.params.userId));
}));

app.post("/api/passkeys/register/options", wrap(async (req, res) => {
  const user = await store.requireUser(req.body.userId);
  const userPasskeys = await store.listPasskeysForUser(user.id);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.userId,
    userDisplayName: user.displayName,
    userID: isoUint8Array.fromUTF8String(user.webauthnUserID),
    timeout: 60000,
    attestationType: "none",
    excludeCredentials: userPasskeys.map((passkey) => ({ id: passkey.credentialId, transports: passkey.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: [-7, -257]
  });
  await store.saveRegistrationChallenge(user.id, options.challenge);
  res.json(options);
}));

app.post("/api/passkeys/register/verify", wrap(async (req, res) => {
  const user = await store.requireUser(req.body.userId);
  const expectedChallenge = await store.readRegistrationChallenge(user.id);
  if (!expectedChallenge) {
    throw new Error("registration challenge not found");
  }
  const verification = await verifyRegistrationResponse({
    response: req.body.response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID: rpID,
    requireUserVerification: true
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("passkey registration could not be verified");
  }
  const info = verification.registrationInfo;
  const passkey = await store.addPasskey({
    userId: user.id,
    credentialId: info.credential.id,
    publicKey: info.credential.publicKey,
    counter: info.credential.counter,
    transports: req.body.response.response.transports || [],
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp
  });
  await store.clearRegistrationChallenge(user.id);
  res.json({ verified: true, passkey: serializePasskey(passkey) });
}));

app.post("/api/passkeys/authenticate/options", wrap(async (req, res) => {
  const user = await store.requireUser(req.body.userId);
  const userPasskeys = await store.listPasskeysForUser(user.id);
  if (userPasskeys.length === 0) {
    throw new Error("no passkeys registered for this user");
  }
  const options = await generateAuthenticationOptions({
    rpID,
    timeout: 60000,
    allowCredentials: userPasskeys.map((passkey) => ({ id: passkey.credentialId, transports: passkey.transports })),
    userVerification: "required"
  });
  await store.saveAuthenticationChallenge(user.id, options.challenge);
  res.json(options);
}));

app.post("/api/passkeys/authenticate/verify", wrap(async (req, res) => {
  const user = await store.requireUser(req.body.userId);
  const expectedChallenge = await store.readAuthenticationChallenge(user.id);
  if (!expectedChallenge) {
    throw new Error("authentication challenge not found");
  }
  const passkey = await store.findPasskeyByCredentialId(req.body.response.id);
  if (!passkey || passkey.userId !== user.id) {
    throw new Error("passkey not found for this user");
  }
  const verification = await verifyAuthenticationResponse({
    response: req.body.response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID: rpID,
    credential: { id: passkey.credentialId, publicKey: passkey.publicKey, counter: passkey.counter, transports: passkey.transports },
    requireUserVerification: true
  });
  if (!verification.verified) {
    throw new Error("passkey authentication could not be verified");
  }
  await store.updatePasskeyCounter(passkey.credentialId, verification.authenticationInfo.newCounter);
  await store.clearAuthenticationChallenge(user.id);
  res.json({ verified: true, user: { id: user.id, userId: user.userId, displayName: user.displayName } });
}));

app.get("/api/users/:userId/friendships", wrap(async (req, res) => {
  res.json(await store.listFriendshipsForUser(req.params.userId));
}));

app.post("/api/friend-requests", wrap(async (req, res) => {
  res.status(201).json(await store.createFriendRequest(req.body));
}));

app.post("/api/friend-requests/:requestId/respond", wrap(async (req, res) => {
  res.json(await store.respondToFriendRequest({
    requestId: req.params.requestId,
    actorUserId: req.body.actorUserId,
    action: req.body.action
  }));
}));

app.post("/api/blocks", wrap(async (req, res) => {
  res.status(201).json(await store.blockUser(req.body));
}));

app.post("/api/chats/dm", wrap(async (req, res) => {
  res.status(201).json(await store.createDirectMessageChat(req.body));
}));

app.post("/api/chats/group", wrap(async (req, res) => {
  res.status(201).json(await store.createGroupChat(req.body));
}));

app.get("/api/chats/:chatId", wrap(async (req, res) => {
  res.json(await store.requireChat(req.params.chatId));
}));

app.post("/api/chats/:chatId/roles", wrap(async (req, res) => {
  res.status(201).json(await store.addGroupRole({
    chatId: req.params.chatId,
    actorUserId: req.body.actorUserId,
    name: req.body.name,
    permissions: req.body.permissions || []
  }));
}));

app.post("/api/chats/:chatId/roles/:roleId/assign", wrap(async (req, res) => {
  res.json(await store.assignRole({
    chatId: req.params.chatId,
    roleId: req.params.roleId,
    actorUserId: req.body.actorUserId,
    targetUserId: req.body.targetUserId
  }));
}));

app.get("/api/chats/:chatId/messages", wrap(async (req, res) => {
  res.json(await store.listMessages({
    chatId: req.params.chatId,
    viewerUserId: req.query.viewerUserId
  }));
}));

app.post("/api/chats/:chatId/read-state", wrap(async (req, res) => {
  res.json(await store.markChatRead({
    chatId: req.params.chatId,
    actorUserId: req.body.actorUserId,
    lastReadMessageId: req.body.lastReadMessageId
  }));
}));

app.post("/api/chats/:chatId/messages", wrap(async (req, res) => {
  const message = await store.createMessage({
    chatId: req.params.chatId,
    actorUserId: req.body.actorUserId,
    body: req.body.body
  });
  broadcast({ type: "message.created", payload: message });
  res.status(201).json(message);
}));

app.delete("/api/chats/:chatId/messages/:messageId", wrap(async (req, res) => {
  const message = await store.deleteMessage({
    chatId: req.params.chatId,
    messageId: req.params.messageId,
    actorUserId: req.query.actorUserId
  });
  broadcast({ type: "message.deleted", payload: message });
  res.json(message);
}));

app.post("/api/chats/:chatId/messages/:messageId/reactions", wrap(async (req, res) => {
  const reaction = await store.addReaction({
    chatId: req.params.chatId,
    messageId: req.params.messageId,
    actorUserId: req.body.actorUserId,
    emoji: req.body.emoji
  });
  broadcast({ type: "reaction.created", payload: reaction });
  res.status(201).json(reaction);
}));

app.delete("/api/chats/:chatId/messages/:messageId/reactions", wrap(async (req, res) => {
  const result = await store.removeReaction({
    chatId: req.params.chatId,
    messageId: req.params.messageId,
    actorUserId: req.query.actorUserId,
    emoji: req.query.emoji
  });
  broadcast({
    type: "reaction.deleted",
    payload: {
      chatId: Number(req.params.chatId),
      messageId: Number(req.params.messageId),
      actorUserId: Number(req.query.actorUserId),
      emoji: req.query.emoji
    }
  });
  res.json(result);
}));

app.get("/api/chats/:chatId/audit-logs", wrap(async (req, res) => {
  res.json(await store.listAuditLogs({
    chatId: req.params.chatId,
    actorUserId: req.query.actorUserId
  }));
}));

wss.on("connection", (socket) => {
  socket.send(
    JSON.stringify({
      type: "hello",
      payload: {
        message: "Connected to YuiMessenger WebSocket"
      }
    })
  );
});

server.listen(port, () => {
  console.log(`YuiMessenger server listening on port ${port} with origin ${expectedOrigin}`);
});

process.on("SIGINT", async () => {
  if (pool) {
    await pool.end();
  }
  wss.close();
  server.close(() => process.exit(0));
});

function sendBadRequest(res, error) {
  res.status(400).json({
    error: error.message
  });
}

function broadcast(message) {
  const payload = JSON.stringify(message);

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

function serializePasskey(passkey) {
  return {
    id: passkey.id,
    userId: passkey.userId,
    credentialId: passkey.credentialId,
    counter: passkey.counter,
    transports: passkey.transports,
    deviceType: passkey.deviceType,
    backedUp: passkey.backedUp,
    createdAt: passkey.createdAt
  };
}
