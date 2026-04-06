# YuiMessenger

LINE リスペクトのメッセージアプリを作るための開発中プロジェクトです。

## Development

`Podman` と `Docker` のどちらでも動かせるように、`Caddy` 付きの本番寄り [compose.yml](c:/Users/mikan/YuiMessenger/compose.yml) と [Dockerfile](c:/Users/mikan/YuiMessenger/Dockerfile) を入れています。

### Start with Podman

```powershell
podman compose up --build
```

### Start with Docker

```powershell
docker compose up --build
```

`Caddy` が `80/443` を受けてアプリへリバースプロキシします。  
ローカルではホスト設定をしない限り TLS ドメイン前提の動作確認はしづらいので、主な想定は VPS 上の `m.yuiroom.net` です。

## VPS-like Test with `m.yuiroom.net`

VPS 上で本番寄りに試すために、[compose.yml](c:/Users/mikan/YuiMessenger/compose.yml) と [infra/Caddyfile](c:/Users/mikan/YuiMessenger/infra/Caddyfile) を `m.yuiroom.net` 前提にしています。

### 1. Production env file

`.env.production.example` を元に `.env` を作って使います。

```bash
cp .env.production.example .env
```

最低でも `POSTGRES_PASSWORD` は変更してください。

### 2. Start on VPS

```bash
docker compose --env-file .env up -d --build
```

この構成では `Caddy` が `m.yuiroom.net` で TLS を終端して、アプリへリバースプロキシします。  
パスキー認証の既定値も `RP_ID=m.yuiroom.net`、`EXPECTED_ORIGIN=https://m.yuiroom.net` です。

## Included for now

- Node.js app container
- Postgres container
- 初期 DB スキーマ
- パスキー登録と認証のサーバー API
- ユーザー、フレンド、DM、グループ、ロールのインメモリ API
- メッセージ送信、削除、リアクション API
- 通知設定 API
- オンライン状態 API
- 未読件数 API
- WebSocket 入口 (`/ws`)

## Main API

- `GET /api/health`
- `GET /api/spec-summary`
- `POST /api/users`
- `GET /api/users/:userId/passkeys`
- `GET /api/users/:userId/presence`
- `PATCH /api/users/:userId/presence`
- `GET /api/users/:userId/notifications`
- `POST /api/users/:userId/notifications`
- `GET /api/users/:userId/unreads`
- `POST /api/passkeys/register/options`
- `POST /api/passkeys/register/verify`
- `POST /api/passkeys/authenticate/options`
- `POST /api/passkeys/authenticate/verify`
- `POST /api/friend-requests`
- `POST /api/friend-requests/:requestId/respond`
- `POST /api/blocks`
- `POST /api/chats/dm`
- `POST /api/chats/group`
- `POST /api/chats/:chatId/roles`
- `POST /api/chats/:chatId/roles/:roleId/assign`
- `GET /api/chats/:chatId/messages`
- `POST /api/chats/:chatId/messages`
- `DELETE /api/chats/:chatId/messages/:messageId`
- `POST /api/chats/:chatId/messages/:messageId/reactions`
- `DELETE /api/chats/:chatId/messages/:messageId/reactions`
- `POST /api/chats/:chatId/read-state`
- `GET /api/chats/:chatId/audit-logs`

## Notes

- 現在の API 実装は開発用のインメモリ実装です
- 後で Postgres 永続化へ置き換えやすいように、ロジックは [src/store.js](c:/Users/mikan/YuiMessenger/src/store.js) に寄せています
- パスキー認証は `@simplewebauthn/server` とブラウザ側バンドルを使っています
- 既定の `RP ID` は `m.yuiroom.net`、`EXPECTED_ORIGIN` は `https://m.yuiroom.net` です
