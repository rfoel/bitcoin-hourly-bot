import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { Resource } from "sst";

/**
 * The only way in: Face ID / Touch ID (or whatever the device uses to unlock a
 * passkey) before any page or endpoint opens. There is no password or token.
 *
 * Nothing new to provision. State lives in the same table as everything else:
 *
 *   pk `PASSKEY`  sk `<credential id>`  — public key, signature counter, when added
 *   pk `CONFIG`   sk `SESSION_KEY`      — random HMAC key, created on first use
 *
 * The WebAuthn challenge and the session are both stateless cookies signed with that
 * key. Deleting the SESSION_KEY row signs every browser out (once warm Lambdas recycle;
 * a deploy forces it). Deleting a PASSKEY row revokes that device.
 *
 * Enrolment (`/registrar`) is open only while no passkey exists — the first device
 * claims the app. After that, only a signed-in browser can add another device.
 */

const PASSKEY = "PASSKEY";
const KEY_ROW = { pk: "CONFIG", sk: "SESSION_KEY" };
const SESSION_COOKIE = "sessao";
const CHALLENGE_COOKIE = "desafio";
const SESSION_HOURS = Number(process.env.PASSKEY_SESSION_HOURS ?? "12");
const CHALLENGE_SECONDS = 300;
const RP_NAME = "Bitcoin 5 min";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const table = () => Resource.Memory.name;

interface PasskeyRecord {
  pk: string;
  sk: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  createdAt: string;
  lastUsedAt?: string;
  device?: string;
}

type Result = APIGatewayProxyStructuredResultV2;

/** Routes that must stay open, or nobody could ever sign in. */
export function isPublicRoute(method: string, path: string): boolean {
  return (
    path === "/health" ||
    path === "/entrar" ||
    path === "/registrar" ||
    (method === "POST" && path.startsWith("/auth/"))
  );
}

/** Handles the login and registration routes; undefined for anything else. */
export async function handleAuth(
  event: APIGatewayProxyEventV2,
  method: string,
  path: string,
): Promise<Result | undefined> {
  const route = `${method} ${path}`;
  switch (route) {
    case "GET /entrar":
      return page(loginPage(safeReturn(event.queryStringParameters?.volta)));
    case "GET /registrar":
      return page(registerPage());
    case "POST /auth/login/options":
      return loginOptions(event);
    case "POST /auth/login/verify":
      return loginVerify(event);
    case "POST /auth/register/options":
      return registerOptions(event);
    case "POST /auth/register/verify":
      return registerVerify(event);
    case "POST /auth/sair":
      return { ...json(200, { ok: true }), cookies: [clearCookie(SESSION_COOKIE, "/")] };
    default:
      return undefined;
  }
}

/** Where to send a browser with no session; 401 for anything that is not a page. */
export function denied(event: APIGatewayProxyEventV2, path: string): Result {
  const wantsHtml = (event.headers?.accept ?? "").includes("text/html");
  if (!wantsHtml) return json(401, { error: "unauthorized" });
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  return {
    statusCode: 302,
    headers: {
      location: `/entrar?volta=${encodeURIComponent(path + query)}`,
      "cache-control": "no-store",
    },
  };
}

export async function hasSession(event: APIGatewayProxyEventV2): Promise<boolean> {
  const raw = cookieOf(event, SESSION_COOKIE);
  if (!raw) return false;
  const payload = await unsign(raw);
  if (!payload) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && exp > Date.now();
}

// ── Login ──────────────────────────────────────────────────────────────────────

async function loginOptions(event: APIGatewayProxyEventV2): Promise<Result> {
  const { rpID } = relyingParty(event);
  // No allowCredentials: the device offers whichever passkey it has for this site.
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  return {
    ...json(200, options),
    cookies: [await challengeCookie("login", options.challenge)],
  };
}

async function loginVerify(event: APIGatewayProxyEventV2): Promise<Result> {
  const challenge = await readChallenge(event, "login");
  if (!challenge) return json(400, { error: "desafio expirado, tente de novo" });

  const response = parseBody(event) as unknown as AuthenticationResponseJSON;
  if (typeof response?.id !== "string") return json(400, { error: "resposta inválida" });

  const found = await client.send(
    new GetCommand({ TableName: table(), Key: { pk: PASSKEY, sk: response.id } }),
  );
  const stored = found.Item as PasskeyRecord | undefined;
  if (!stored) return json(401, { error: "passkey desconhecida" });

  const { rpID, origin } = relyingParty(event);
  let verified = false;
  let newCounter = stored.counter;
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: stored.sk,
        publicKey: Buffer.from(stored.publicKey, "base64url"),
        counter: stored.counter,
        transports: stored.transports,
      },
    });
    verified = result.verified;
    newCounter = result.authenticationInfo.newCounter;
  } catch (error) {
    console.warn("passkey login rejected", error);
  }
  if (!verified) return json(401, { error: "não deu para verificar" });

  await client.send(
    new UpdateCommand({
      TableName: table(),
      Key: { pk: PASSKEY, sk: stored.sk },
      UpdateExpression: "SET #c = :c, lastUsedAt = :t",
      ExpressionAttributeNames: { "#c": "counter" },
      ExpressionAttributeValues: { ":c": newCounter, ":t": new Date().toISOString() },
    }),
  );

  return {
    ...json(200, { ok: true }),
    cookies: [await sessionCookie(), clearCookie(CHALLENGE_COOKIE, "/auth")],
  };
}

// ── Registration ───────────────────────────────────────────────────────────────

async function registerOptions(event: APIGatewayProxyEventV2): Promise<Result> {
  const existing = await client.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": PASSKEY },
      ProjectionExpression: "sk, transports",
      ConsistentRead: true,
    }),
  );

  // The first device claims the app; every later one needs a signed-in browser.
  const claimed = (existing.Items ?? []).length > 0;
  if (claimed && !(await hasSession(event))) {
    return json(401, { error: "entre primeiro num aparelho já cadastrado" });
  }

  const { rpID } = relyingParty(event);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: "dono",
    userDisplayName: "Dono",
    // One fixed user: every device of the owner saves its passkey under the same
    // account, and the same device is not enrolled twice.
    userID: new TextEncoder().encode("owner"),
    attestationType: "none",
    excludeCredentials: (existing.Items ?? []).map((item) => ({
      id: item.sk as string,
      transports: item.transports as string[] | undefined,
    })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });

  return {
    ...json(200, options),
    cookies: [await challengeCookie("register", options.challenge)],
  };
}

async function registerVerify(event: APIGatewayProxyEventV2): Promise<Result> {
  // The challenge cookie is only ever issued after the check above, so it doubles
  // as proof that this registration was allowed.
  const challenge = await readChallenge(event, "register");
  if (!challenge) return json(400, { error: "desafio expirado, tente de novo" });

  const response = parseBody(event) as unknown as RegistrationResponseJSON;
  const { rpID, origin } = relyingParty(event);

  let info;
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (result.verified) info = result.registrationInfo;
  } catch (error) {
    console.warn("passkey registration rejected", error);
  }
  if (!info) return json(400, { error: "não deu para verificar" });

  const record: PasskeyRecord = {
    pk: PASSKEY,
    sk: info.credential.id,
    publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
    counter: info.credential.counter,
    transports: info.credential.transports,
    createdAt: new Date().toISOString(),
    device: (event.headers?.["user-agent"] ?? "").slice(0, 200),
  };
  await client.send(new PutCommand({ TableName: table(), Item: record }));

  // Registering already proved the biometric, so sign in too.
  return {
    ...json(201, { ok: true }),
    cookies: [await sessionCookie(), clearCookie(CHALLENGE_COOKIE, "/auth")],
  };
}

// ── Cookies and signing ────────────────────────────────────────────────────────

let cachedKey: Promise<Buffer> | undefined;

/** The HMAC key, read once per Lambda instance. A failed read is retried next time. */
function signingKey(): Promise<Buffer> {
  cachedKey ??= loadKey().catch((error: unknown) => {
    cachedKey = undefined;
    throw error;
  });
  return cachedKey;
}

async function loadKey(): Promise<Buffer> {
  const read = async () => {
    const found = await client.send(
      new GetCommand({ TableName: table(), Key: KEY_ROW, ConsistentRead: true }),
    );
    const value = found.Item?.value;
    return typeof value === "string" ? Buffer.from(value, "base64url") : undefined;
  };

  const existing = await read();
  if (existing) return existing;

  // First use: create it. If another instance won the race, use theirs.
  try {
    await client.send(
      new PutCommand({
        TableName: table(),
        Item: { ...KEY_ROW, value: randomBytes(32).toString("base64url"), createdAt: new Date().toISOString() },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
  }
  const created = await read();
  if (!created) throw new Error("session key missing after create");
  return created;
}

async function sign(payload: string): Promise<string> {
  const mac = createHmac("sha256", await signingKey()).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${mac}`;
}

async function unsign(value: string): Promise<string | undefined> {
  const [encoded, mac] = value.split(".");
  if (!encoded || !mac) return undefined;
  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = createHmac("sha256", await signingKey()).update(payload).digest();
  const supplied = Buffer.from(mac, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return undefined;
  }
  return payload;
}

async function sessionCookie(): Promise<string> {
  const exp = Date.now() + SESSION_HOURS * 3_600_000;
  return cookie(SESSION_COOKIE, await sign(String(exp)), "/", SESSION_HOURS * 3600, "Lax");
}

async function challengeCookie(kind: "login" | "register", challenge: string): Promise<string> {
  const payload = JSON.stringify({ kind, challenge, exp: Date.now() + CHALLENGE_SECONDS * 1000 });
  return cookie(CHALLENGE_COOKIE, await sign(payload), "/auth", CHALLENGE_SECONDS);
}

async function readChallenge(
  event: APIGatewayProxyEventV2,
  kind: "login" | "register",
): Promise<string | undefined> {
  const raw = cookieOf(event, CHALLENGE_COOKIE);
  const payload = raw && (await unsign(raw));
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload) as { kind: string; challenge: string; exp: number };
    if (parsed.kind !== kind || !(parsed.exp > Date.now())) return undefined;
    return parsed.challenge;
  } catch {
    return undefined;
  }
}

/**
 * The session is Lax so a link from another app still lands signed in; the
 * challenge is only ever read by our own fetches, so it can be Strict.
 */
function cookie(
  name: string,
  value: string,
  path: string,
  maxAge: number,
  sameSite: "Lax" | "Strict" = "Strict",
): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${sameSite}`;
}

function clearCookie(name: string, path: string): string {
  return cookie(name, "", path, 0);
}

function cookieOf(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const all = event.cookies ?? event.headers?.cookie?.split(/;\s*/) ?? [];
  for (const entry of all) {
    const at = entry.indexOf("=");
    if (at > 0 && entry.slice(0, at).trim() === name) return entry.slice(at + 1).trim();
  }
  return undefined;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** The passkey is bound to the hostname the browser is on — the custom domain. */
function relyingParty(event: APIGatewayProxyEventV2): { rpID: string; origin: string } {
  const rpID = event.requestContext.domainName;
  return { rpID, origin: `https://${rpID}` };
}

/** Only same-site paths, so `?volta=` cannot bounce someone to another site. */
function safeReturn(value: string | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function json(statusCode: number, body: unknown): Result {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

function page(body: string): Result {
  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body,
  };
}

// ── Pages ──────────────────────────────────────────────────────────────────────

const CSS = `
:root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; }
main { width: min(22rem, 90vw); display: grid; gap: 1rem; text-align: center; }
h1 { font-size: 1.25rem; margin: 0; }
p { margin: 0; opacity: .7; }
button { font: inherit; padding: .8rem 1rem; border-radius: .75rem; border: 1px solid #8886; }
button { background: CanvasText; color: Canvas; border: 0; font-weight: 600; cursor: pointer; }
button:disabled { opacity: .5; }
#erro { color: #d33; min-height: 1.5em; }
`;

/** Shared browser side: JSON options in, JSON credential out, via the native helpers. */
const CLIENT = `
const erro = document.getElementById("erro");
const post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || String(r.status));
  return data;
};
const fail = (e) => {
  erro.textContent = e && e.name === "NotAllowedError" ? "Cancelado." : (e && e.message) || String(e);
};
if (!window.PublicKeyCredential || !PublicKeyCredential.parseRequestOptionsFromJSON) {
  erro.textContent = "Este navegador não suporta passkeys.";
}
`;

function shell(title: string, body: string, script: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body}
<p id="erro" role="alert"></p>
</main>
<script>${CLIENT}${script}</script>
</body>
</html>`;
}

function loginPage(returnTo: string): string {
  return shell(
    "Entrar",
    `<h1>Bitcoin 5 min</h1>
<p>Use o Face ID ou o Touch ID para abrir.</p>
<button id="entrar" type="button">Entrar</button>
<a href="/registrar"><small>Cadastrar este aparelho</small></a>`,
    `
const volta = ${JSON.stringify(returnTo)};
const botao = document.getElementById("entrar");
async function entrar() {
  botao.disabled = true; erro.textContent = "";
  try {
    const options = await post("/auth/login/options");
    const cred = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
    await post("/auth/login/verify", cred.toJSON());
    location.replace(volta);
  } catch (e) { fail(e); } finally { botao.disabled = false; }
}
botao.addEventListener("click", entrar);
// Try straight away; browsers that insist on a tap leave the button there.
entrar();
`,
  );
}

function registerPage(): string {
  return shell(
    "Cadastrar passkey",
    `<h1>Cadastrar este aparelho</h1>
<p>O primeiro aparelho cadastrado vira o dono. Para cadastrar outro depois, entre antes num aparelho que já tem acesso.</p>
<button id="cadastrar" type="button">Cadastrar com Face ID / Touch ID</button>`,
    `
const botao = document.getElementById("cadastrar");
botao.addEventListener("click", async () => {
  erro.textContent = ""; botao.disabled = true;
  try {
    const options = await post("/auth/register/options");
    const cred = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
    await post("/auth/register/verify", cred.toJSON());
    location.replace("/");
  } catch (e) { fail(e); } finally { botao.disabled = false; }
});
`,
  );
}
