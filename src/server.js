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
const store = new AppStore();
const rpID = process.env.RP_ID || "localhost";
const rpName = process.env.RP_NAME || "YuiMessenger";
const expectedOrigin = process.env.EXPECTED_ORIGIN || `http://${rpID}:${port}`;

app.use(express.json());
app.use(express.static("public"));

let pool = null;

if (databaseUrl) {
  pool = new Pool({
    connectionString: databaseUrl
  });
}

app.get("/api/health", async (_req, res) => {
  const status = {
    app: "ok",
    database: "disabled",
    websocket: "ok"
  };

  if (pool) {
    try {
      await pool.query("SELECT 1");
      status.database = "ok";
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

app.get("/api/users", (_req, res) => {
  res.json(store.listUsers());
});

app.post("/api/users", (req, res) => {
  try {
    const user = store.createUser(req.body);
    res.status(201).json(user);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.get("/api/users/:userId/passkeys", (req, res) => {
  try {
    res.json(store.listPasskeysForUser(req.params.userId));
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.get("/api/users/:userId/presence", (req, res) => {
  try {
    res.json(store.getPresence(req.params.userId));
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.patch("/api/users/:userId/presence", (req, res) => {
  try {
    const presence = store.updatePresence({
      userId: req.params.userId,
      status: req.body.status,
      isVisible: req.body.isVisible,
      isManual: req.body.isManual
    });
    broadcast({
      type: "presence.updated",
      payload: presence
    });
    res.json(presence);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.get("/api/users/:userId/notifications", (req, res) => {
  try {
    res.json(store.listNotificationSettings(req.params.userId));
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/users/:userId/notifications", (req, res) => {
  try {
    const setting = store.setNotificationSetting({
      actorUserId: req.params.userId,
      scopeType: req.body.scopeType,
      scopeId: req.body.scopeId,
      enabled: req.body.enabled
    });
    res.json(setting);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.get("/api/users/:userId/unreads", (req, res) => {
  try {
    res.json(store.getUnreadSummary(req.params.userId));
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/passkeys/register/options", async (req, res) => {
  try {
    const user = store.requireUser(req.body.userId);
    const userPasskeys = store.listPasskeysForUser(user.id);

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: user.userId,
      userDisplayName: user.displayName,
      userID: isoUint8Array.fromUTF8String(user.webauthnUserID),
      timeout: 60000,
      attestationType: "none",
      excludeCredentials: userPasskeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required"
      },
      supportedAlgorithmIDs: [-7, -257]
    });

    store.saveRegistrationChallenge(user.id, options.challenge);
    res.json(options);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/passkeys/register/verify", async (req, res) => {
  try {
    const user = store.requireUser(req.body.userId);
    const expectedChallenge = store.readRegistrationChallenge(user.id);

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

    const registrationInfo = verification.registrationInfo;

    const passkey = store.addPasskey({
      userId: user.id,
      credentialId: registrationInfo.credential.id,
      publicKey: registrationInfo.credential.publicKey,
      counter: registrationInfo.credential.counter,
      transports: req.body.response.response.transports || [],
      deviceType: registrationInfo.credentialDeviceType,
      backedUp: registrationInfo.credentialBackedUp
    });

    store.clearRegistrationChallenge(user.id);

    res.json({
      verified: true,
      passkey: serializePasskey(passkey)
    });
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/passkeys/authenticate/options", async (req, res) => {
  try {
    const user = store.requireUser(req.body.userId);
    const userPasskeys = store.listPasskeysForUser(user.id);

    if (userPasskeys.length === 0) {
      throw new Error("no passkeys registered for this user");
    }

    const options = await generateAuthenticationOptions({
      rpID,
      timeout: 60000,
      allowCredentials: userPasskeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports
      })),
      userVerification: "required"
    });

    store.saveAuthenticationChallenge(user.id, options.challenge);
    res.json(options);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/passkeys/authenticate/verify", async (req, res) => {
  try {
    const user = store.requireUser(req.body.userId);
    const expectedChallenge = store.readAuthenticationChallenge(user.id);

    if (!expectedChallenge) {
      throw new Error("authentication challenge not found");
    }

    const credentialId = req.body.response.id;
    const passkey = store.findPasskeyByCredentialId(credentialId);

    if (!passkey || passkey.userId !== user.id) {
      throw new Error("passkey not found for this user");
    }

    const verification = await verifyAuthenticationResponse({
      response: req.body.response,
      expectedChallenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: passkey.credentialId,
        publicKey: passkey.publicKey,
        counter: passkey.counter,
        transports: passkey.transports
      },
      requireUserVerification: true
    });

    if (!verification.verified) {
      throw new Error("passkey authentication could not be verified");
    }

    store.updatePasskeyCounter(passkey.credentialId, verification.authenticationInfo.newCounter);
    store.clearAuthenticationChallenge(user.id);

    res.json({
      verified: true,
      user: {
        id: user.id,
        userId: user.userId,
        displayName: user.displayName
      }
    });
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.get("/api/users/:userId/friendships", (req, res) => {
  try {
    const data = store.listFriendshipsForUser(req.params.userId);
    res.json(data);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/friend-requests", (req, res) => {
  try {
    const data = store.createFriendRequest(req.body);
    res.status(201).json(data);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/friend-requests/:requestId/respond", (req, res) => {
  try {
    const data = store.respondToFriendRequest({
      requestId: req.params.requestId,
      actorUserId: req.body.actorUserId,
      action: req.body.action
    });
    res.json(data);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/blocks", (req, res) => {
  try {
    const data = store.blockUser(req.body);
    res.status(201).json(data);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/chats/dm", (req, res) => {
  try {
    const chat = store.createDirectMessageChat(req.body);
    res.status(201).json(chat);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/chats/group", (req, res) => {
  try {
    const chat = store.createGroupChat(req.body);
    res.status(201).json(chat);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.get("/api/chats/:chatId", (req, res) => {
  try {
    res.json(store.requireChat(req.params.chatId));
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/chats/:chatId/roles", (req, res) => {
  try {
    const role = store.addGroupRole({
      chatId: req.params.chatId,
      actorUserId: req.body.actorUserId,
      name: req.body.name,
      permissions: req.body.permissions || []
    });
    res.status(201).json(role);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/chats/:chatId/roles/:roleId/assign", (req, res) => {
  try {
    const role = store.assignRole({
      chatId: req.params.chatId,
      roleId: req.params.roleId,
      actorUserId: req.body.actorUserId,
      targetUserId: req.body.targetUserId
    });
    res.json(role);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.get("/api/chats/:chatId/messages", (req, res) => {
  try {
    const messages = store.listMessages({
      chatId: req.params.chatId,
      viewerUserId: req.query.viewerUserId
    });
    res.json(messages);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/chats/:chatId/read-state", (req, res) => {
  try {
    const state = store.markChatRead({
      chatId: req.params.chatId,
      actorUserId: req.body.actorUserId,
      lastReadMessageId: req.body.lastReadMessageId
    });
    res.json(state);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/chats/:chatId/messages", (req, res) => {
  try {
    const message = store.createMessage({
      chatId: req.params.chatId,
      actorUserId: req.body.actorUserId,
      body: req.body.body
    });
    broadcast({
      type: "message.created",
      payload: message
    });
    res.status(201).json(message);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.delete("/api/chats/:chatId/messages/:messageId", (req, res) => {
  try {
    const message = store.deleteMessage({
      chatId: req.params.chatId,
      messageId: req.params.messageId,
      actorUserId: req.query.actorUserId
    });
    broadcast({
      type: "message.deleted",
      payload: message
    });
    res.json(message);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.post("/api/chats/:chatId/messages/:messageId/reactions", (req, res) => {
  try {
    const reaction = store.addReaction({
      chatId: req.params.chatId,
      messageId: req.params.messageId,
      actorUserId: req.body.actorUserId,
      emoji: req.body.emoji
    });
    broadcast({
      type: "reaction.created",
      payload: reaction
    });
    res.status(201).json(reaction);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.delete("/api/chats/:chatId/messages/:messageId/reactions", (req, res) => {
  try {
    const result = store.removeReaction({
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
        actorUserId: req.query.actorUserId,
        emoji: req.query.emoji
      }
    });
    res.json(result);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

app.get("/api/chats/:chatId/audit-logs", (req, res) => {
  try {
    const logs = store.listAuditLogs({
      chatId: req.params.chatId,
      actorUserId: req.query.actorUserId
    });
    res.json(logs);
  } catch (error) {
    sendBadRequest(res, error);
  }
});

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
