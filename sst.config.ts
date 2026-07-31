/// <reference path="./.sst/platform/config.d.ts" />

/**
 * Custom domain for the dashboard, applied on the production stage only — other
 * stages get the generated API Gateway URL so they never fight over DNS. Set
 * `DOMAIN` to point a fork somewhere else, or `DOMAIN=""` to skip the custom
 * domain entirely. The zone must already exist in Route 53 on the same account.
 */
const DOMAIN = process.env.DOMAIN ?? "bitcoin.rfoel.dev";

export default $config({
  app(input) {
    return {
      name: "bitcoin-hourly-bot",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage ?? ""),
      home: "aws",
      providers: {
        aws: { region: "sa-east-1" },
      },
    };
  },
  async run() {
    const publicKey = new sst.Secret("FutuurPublicKey");
    const privateKey = new sst.Secret("FutuurPrivateKey");
    // Shared secret for the on-demand endpoint. Without it the API rejects everything.
    const apiToken = new sst.Secret("ApiToken");
    const anthropicKey = new sst.Secret("AnthropicApiKey");

    const betting = {
      FUTUUR_PUBLIC_KEY: publicKey.value,
      FUTUUR_PRIVATE_KEY: privateKey.value,
      // https://futuur.com/markets/bitcoin-hourly is category 3702. Hourly events
      // carry no tags, so the category is the only exact handle on them — and it
      // keeps category 3689 (bitcoin-daily) out, which otherwise collides at 15:59.
      FUTUUR_CATEGORY_IDS: "3702",
      // Fallback only. Single word on purpose: a space in a signed param breaks
      // the HMAC (see scripts/check-encoding.mjs).
      FUTUUR_SEARCH: "bitcoin",
      FUTUUR_TITLE_MATCH: "bitcoin|btc",
      FUTUUR_WINDOW_MINUTES: "70",
      FUTUUR_CURRENCY: "OOM",
      // Stake is this fraction of the wallet, so it grows with winnings and
      // shrinks after losses on its own. HARD_CAP in src/bet.ts is the ceiling
      // FUTUUR_MAX_STAKE cannot exceed.
      FUTUUR_STAKE_FRACTION: "0.02",
      FUTUUR_MIN_STAKE: "10",
      // Ceiling as a share of the bankroll so it scales both ways. On a ~1,840 OOM
      // bankroll that is ~92 per bet; FUTUUR_MAX_STAKE stays as an absolute backstop
      // for the case where the bankroll grows a lot.
      FUTUUR_MAX_STAKE_FRACTION: "0.05",
      FUTUUR_MAX_STAKE: "1000",
      // "spot" bets the direction the BTC price already points at, ignoring the
      // odds: above the event's price to beat means up, below means down.
      // Also accepts "favorite", "underdog", or an exact outcome label.
      FUTUUR_STRATEGY: "spot",
      FUTUUR_DRY_RUN: "false",
    };

    const runtime = {
      runtime: "nodejs24.x",
      architecture: "arm64",
      timeout: "30 seconds",
      memory: "256 MB",
    } as const;

    // Bets placed and strategy notes. Single table, partitioned by record kind —
    // see the key layout at the top of src/store.ts.
    const memory = new sst.aws.Dynamo("Memory", {
      fields: { pk: "string", sk: "string" },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
    });

    // Failed cron invocations land here after the scheduler exhausts its retries.
    const dlq = new sst.aws.Queue("BetDlq");

    // Claude works the last 15 minutes of the hour as an agent: reads the market,
    // its own settled history and its notes, then bets, adds, sells or passes. One
    // invocation spans the whole window, so `wait` is a real move — it can watch the
    // gap develop and act closer to resolution, where the signal is strongest.
    //
    // 15 minutes is the Lambda ceiling, which is why the window starts at :45.
    // `retries: 0` on purpose: a retry would re-enter a window the first attempt may
    // already have bet in, and the agent has its own fallback for a failed loop.
    const cron = new sst.aws.CronV2("HourlyBitcoinBet", {
      schedule: "cron(45 * * * ? *)",
      timezone: "UTC",
      retries: 0,
      dlq: dlq.arn,
      function: {
        handler: "src/agent.handler",
        environment: {
          ...betting,
          ANTHROPIC_API_KEY: anthropicKey.value,
          // Working budget inside the invocation; the handler holds back 45s of the
          // Lambda timeout so it can always finish cleanly.
          AGENT_BUDGET_MS: "840000",
          AGENT_EFFORT: "high",
          AGENT_TOKEN_BUDGET: "250000",
          AGENT_MAX_ITERATIONS: "40",
          // Deterministic spot bet if the agent loop itself fails. A run that
          // deliberately passes does not trigger it.
          AGENT_FALLBACK: "true",
        },
        link: [memory],
        ...runtime,
        timeout: "15 minutes",
        memory: "512 MB",
      },
    });

    const settle = new sst.aws.CronV2("SettleBets", {
      // :06 every hour — the hourly market has closed and resolved by then.
      schedule: "cron(6 * * * ? *)",
      timezone: "UTC",
      retries: 2,
      dlq: dlq.arn,
      function: {
        handler: "src/settle.handler",
        environment: betting,
        link: [memory],
        // Reconciling several events takes more than one round trip.
        ...runtime,
        timeout: "2 minutes",
      },
    });

    const useDomain = DOMAIN !== "" && $app.stage === "production";

    const api = new sst.aws.ApiGatewayV2("BetApi", {
      ...(useDomain ? { domain: { name: DOMAIN, dns: sst.aws.dns() } } : {}),
      cors: false,
    });

    const onDemand = {
      handler: "src/api.handler",
      environment: { ...betting, API_TOKEN: apiToken.value },
      link: [memory],
      ...runtime,
    };

    // One catch-all route: the handler dispatches on method + path, so the API is a
    // single Lambda instead of one per path. GET / serves the dashboard.
    api.route("$default", onDemand);

    return {
      api: api.url,
      agent: cron.nodes.function.name,
      settler: settle.nodes.function.name,
      table: memory.name,
      dlq: dlq.url,
    };
  },
});
