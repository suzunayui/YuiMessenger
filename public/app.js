const authLog = document.querySelector("#auth-log");
const supportPill = document.querySelector("#support-pill");

const { startRegistration, startAuthentication, browserSupportsWebAuthn } = window.SimpleWebAuthnBrowser;

const webAuthnSupported = browserSupportsWebAuthn();

setSupportState(webAuthnSupported);
logMessage(
  webAuthnSupported
    ? "このブラウザは WebAuthn に対応しています。パスキーの動作を試せます。"
    : "このブラウザは WebAuthn に対応していません。ここではパスキー操作を完了できません。"
);

document.querySelector("#create-user-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const form = new FormData(event.currentTarget);
  const payload = {
    userId: form.get("userId"),
    displayName: form.get("displayName")
  };

  const result = await postJSON("/api/users", payload);
  logMessage(["ユーザーを作成しました。", result]);
});

document.querySelector("#register-passkey-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const form = new FormData(event.currentTarget);
    const userId = form.get("userId");

    const options = await postJSON("/api/passkeys/register/options", { userId });
    const response = await startRegistration({ optionsJSON: options });
    const verification = await postJSON("/api/passkeys/register/verify", {
      userId,
      response
    });

    logMessage(["パスキーを登録しました。", verification]);
  } catch (error) {
    logMessage(["パスキー登録に失敗しました。", error.message || error]);
  }
});

document.querySelector("#login-passkey-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const form = new FormData(event.currentTarget);
    const userId = form.get("userId");

    const options = await postJSON("/api/passkeys/authenticate/options", { userId });
    const response = await startAuthentication({ optionsJSON: options });
    const verification = await postJSON("/api/passkeys/authenticate/verify", {
      userId,
      response
    });

    logMessage(["ログインに成功しました。", verification]);
  } catch (error) {
    logMessage(["ログインに失敗しました。", error.message || error]);
  }
});

async function postJSON(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

function logMessage(value) {
  const lines = Array.isArray(value) ? value : [value];
  authLog.textContent = lines
    .map((item) => (typeof item === "string" ? item : JSON.stringify(item, null, 2)))
    .join("\n\n");
}

function setSupportState(isSupported) {
  if (!supportPill) {
    return;
  }

  supportPill.textContent = isSupported
    ? "このブラウザはパスキーに対応しています"
    : "このブラウザはパスキーに対応していません";
  supportPill.classList.add(isSupported ? "is-supported" : "is-unsupported");
}
