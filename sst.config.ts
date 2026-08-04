/// <reference path="./.sst/platform/config.d.ts" />

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

    // Not a secret, but SST's per-stage config value. No default on purpose: every
    // stage states its own hostname, so a deploy can never inherit another stage's
    // DNS record. Set it with `sst secret set Domain <host> --stage <stage>`.
    const domain = new sst.Secret("Domain");

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
    // :53 rather than :45. Measured runs take 223-628s (median 335s) and never call
    // `wait`, so the wide window was idle time — and the bets that actually carry the
    // P&L land latest, where the book has had time to misprice a drifting spot.
    //
    // The window stayed at :53, but the budget now reaches the close rather than
    // stopping 90s short of it. Shrinking the window had also removed the agent's
    // ability to manage what it bought, which is a different thing from removing idle
    // time: it never called `wait` partly because it was told there was no point.
    //
    // `retries: 0` on purpose: a retry would re-enter a window the first attempt may
    // already have bet in.
    const cron = new sst.aws.CronV2("HourlyBitcoinBet", {
      schedule: "cron(53 * * * ? *)",
      timezone: "UTC",
      retries: 0,
      dlq: dlq.arn,
      function: {
        handler: "src/agent.handler",
        environment: {
          ...betting,
          ANTHROPIC_API_KEY: anthropicKey.value,
          // Enough to reach the close from :53 (420s) plus the 45s the handler holds
          // back to finish cleanly. At 375000 the working budget ran out 90 seconds
          // early, so `managed` was false on every single run and the agent was told
          // outright that it would get no turn to sell — which is how two positions
          // ended up needing a human to exit them.
          AGENT_BUDGET_MS: "465000",
          // Narrower than the shared 70: the cron fires at :45, so the only event it
          // should ever pick is the one closing at the top of this hour. A 70-minute
          // window lets it land on a market an hour out that it cannot see through.
          FUTUUR_WINDOW_MINUTES: "15",
          // Sonnet 5 reaches near-Opus quality on agentic work at roughly 40% of the
          // cost. The model is recorded on every run, so switching back is a config
          // change and the two are comparable on win rate afterwards.
          AGENT_MODEL: "claude-sonnet-5",
          AGENT_EFFORT: "high",
          AGENT_TOKEN_BUDGET: "250000",
          AGENT_MAX_ITERATIONS: "40",
          // Off. The spot rule it falls back to has run -19% ROI over 38 bets, so a
          // failed agent betting anyway costs more than a skipped hour, which costs
          // nothing.
          AGENT_FALLBACK: "false",
        },
        link: [memory],
        ...runtime,
        // Covers the working budget with room for the final turn on top.
        timeout: "9 minutes",
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

    // The agent may write a note every hour and reads all of them before every
    // decision, so the notebook grows while the value of reading it does not. This
    // rewrites it into a shorter set once it passes the threshold, and no-ops below —
    // hourly rather than daily because at one note per run a daily pass would let it
    // overshoot the injection limit by half a day.
    //
    // :20 keeps it clear of both the settle at :06 and the agent from :53.
    const compact = new sst.aws.CronV2("CompactNotes", {
      schedule: "cron(20 * * * ? *)",
      timezone: "UTC",
      retries: 2,
      dlq: dlq.arn,
      function: {
        handler: "src/compact.handler",
        environment: {
          ANTHROPIC_API_KEY: anthropicKey.value,
          // Five below the 20 the briefing injects, so compaction happens before any
          // note is silently dropped rather than after.
          COMPACT_THRESHOLD: "15",
          COMPACT_MODEL: "claude-sonnet-5",
        },
        link: [memory],
        ...runtime,
        timeout: "2 minutes",
      },
    });

    const api = new sst.aws.ApiGatewayV2("BetApi", {
      domain: { name: domain.value, dns: sst.aws.dns() },
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
      compactor: compact.nodes.function.name,
      table: memory.name,
      dlq: dlq.url,
    };
  },
});
