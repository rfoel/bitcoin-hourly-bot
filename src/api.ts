import { randomUUID, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { placeBet, walletBalance } from "./bet.js";
import type { BetOverrides } from "./bet.js";
import { listBets, listNotes, listRuns, putNote, summarise, summariseSpend } from "./store.js";
import { renderPage } from "./ui.js";
import type { DashboardState } from "./ui.js";

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  // One catch-all route, so the API is a single Lambda rather than one per path.
  const method = event.requestContext?.http?.method ?? "GET";
  const path = (event.rawPath ?? "/").replace(/\/+$/, "") || "/";
  const route = `${method} ${path}`;

  // Reads are public — this is a dashboard. Only the two routes that spend money
  // or write to the store need the token.
  const writes = route === "POST /bet" || route === "POST /notes";
  if (writes && !authorized(event)) return json(401, { error: "unauthorized" });

  try {
    switch (route) {
      case "GET /health":
        return json(200, { ok: true });

      case "GET /":
        return html(200, renderPage(await loadDashboard()));

      case "GET /state":
        return json(200, await loadDashboard());

      case "POST /bet":
        return json(200, await placeBet(parseOverrides(event)));

      case "GET /bets": {
        const bets = await listBets(limitOf(event, 50));
        return json(200, { bets });
      }

      case "GET /stats": {
        // Summarised over a window, not all time, so a stale early record cannot
        // skew what the staking logic is judged on.
        const [bets, runs] = await Promise.all([
          listBets(limitOf(event, 200)),
          listRuns(limitOf(event, 200)),
        ]);
        return json(200, {
          window: bets.length,
          stats: summarise(bets),
          spend: summariseSpend(runs),
        });
      }

      case "GET /runs": {
        const runs = await listRuns(limitOf(event, 50));
        return json(200, { runs, spend: summariseSpend(runs) });
      }

      case "GET /notes": {
        const notes = await listNotes(limitOf(event, 50));
        return json(200, { notes });
      }

      case "POST /notes": {
        const body = parseBody(event);
        const text = str(body.text);
        if (!text) return json(400, { error: "text is required" });
        return json(201, await putNote(text, tagsOf(body.tags)));
      }

      default:
        return json(404, { error: `no route for ${route}` });
    }
  } catch (error) {
    if (error instanceof RequestError) return json(400, describe(error));
    console.error(`${route} failed`, error);
    return json(502, describe(error));
  }
};

/** Marks a failure as the caller's fault, so it maps to 400 rather than 502. */
class RequestError extends Error {}

/**
 * Everything the dashboard shows, in one read. The balance is best-effort: a Futuur
 * hiccup should degrade one number, not blank the whole page.
 */
async function loadDashboard(): Promise<DashboardState> {
  const currency = process.env.FUTUUR_CURRENCY ?? "OOM";
  const [balance, bets, runs, notes] = await Promise.all([
    walletBalance(currency as never).catch(() => null),
    listBets(120),
    listRuns(60),
    listNotes(15),
  ]);

  return {
    now: new Date().toISOString().replace("T", " ").slice(0, 19) + "Z",
    currency,
    balance,
    stats: summarise(bets),
    spend: summariseSpend(runs),
    bets,
    runs,
    notes,
  };
}

function html(statusCode: number, body: string): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body,
  };
}

function limitOf(event: APIGatewayProxyEventV2, fallback: number): number {
  const raw = event.queryStringParameters?.limit;
  if (!raw) return fallback;

  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RequestError(`limit must be an integer in 1..1000, got "${raw}"`);
  }
  return limit;
}

function tagsOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === "string");
  throw new RequestError("tags must be an array or a comma-separated string");
}

/** Shared-secret check. Fails closed if the token was never set. */
function authorized(event: APIGatewayProxyEventV2): boolean {
  const expected = process.env.API_TOKEN;
  if (!expected) return false;

  const headers = event.headers ?? {};
  const supplied =
    headers.authorization?.replace(/^Bearer\s+/i, "").trim() || headers["x-api-key"]?.trim();
  if (!supplied) return false;

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Overrides come from the JSON body, falling back to the query string. */
function parseOverrides(event: APIGatewayProxyEventV2): BetOverrides {
  const query: Record<string, unknown> = event.queryStringParameters ?? {};
  const body = parseBody(event);
  const value = (key: string) => body[key] ?? query[key];

  const overrides: BetOverrides = {
    // A manual call should place a real, separate bet rather than replay the
    // hour's cron order, so default to a fresh key.
    idempotencyKey: str(value("idempotencyKey")) ?? randomUUID(),
  };

  const currency = str(value("currency"));
  if (currency) overrides.currency = currency.toUpperCase();

  const strategy = str(value("strategy"));
  if (strategy) overrides.strategy = strategy;

  const rawAmount = value("amount");
  if (rawAmount !== undefined && rawAmount !== null && rawAmount !== "") {
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new RequestError(`amount must be a positive number, got "${String(rawAmount)}"`);
    }
    overrides.amount = amount;
  }

  const rawDryRun = value("dryRun");
  if (rawDryRun !== undefined) {
    overrides.dryRun = rawDryRun === true || rawDryRun === "true" || rawDryRun === "1";
  }

  return overrides;
}

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  if (!raw.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RequestError("body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestError("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Futuur errors are axios errors — the API error code lives in `response.data`. */
function describe(error: unknown): { error: string; detail?: unknown } {
  const message = error instanceof Error ? error.message : String(error);
  const detail = (error as { response?: { data?: unknown } })?.response?.data;
  return detail === undefined ? { error: message } : { error: message, detail };
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
