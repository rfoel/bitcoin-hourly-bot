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

    // The Futuur "Bitcoin Up or Down — 5 min" market (category 3728), bet in its last
    // seconds. Fires at minute 4 of every 5-minute window — one minute before the
    // close — settles the rounds that resolved since, then sleeps until
    // FIVEMIN_DECIDE_AT seconds before the close and decides. See src/fivemin.ts.
    //
    // This replaced the hourly Claude agent. An LLM turn takes longer than the window
    // it would have to act in, and 288 runs a day would cost ~$40 in tokens.
    //
    // `retries: 0` on purpose: a retry would re-enter a window the first attempt may
    // already have bet in.
    const fiveMin = new sst.aws.CronV2("FiveMinuteBitcoinBet", {
      schedule: "cron(4/5 * * * ? *)",
      timezone: "UTC",
      retries: 0,
      dlq: dlq.arn,
      function: {
        handler: "src/fivemin.handler",
        environment: {
          ...betting,
          FIVEMIN_CATEGORY_ID: "3728",
          // Starting bankroll. Read only when the ledger (pk FIVEMIN, sk STATE) is
          // created on the first run; after that the ledger is the truth.
          FIVEMIN_BUDGET: "10000",
          // Decide 15s before the close; never place an order with under 4s left.
          FIVEMIN_DECIDE_AT: "15",
          FIVEMIN_LATEST_AT: "4",
          // Only buy ask levels at least 5 points below the model's probability, and
          // only when the favoured side is at least 70% likely.
          FIVEMIN_MIN_EDGE: "0.05",
          FIVEMIN_MIN_PROB: "0.7",
          // All-in allowed: one round may stake the whole bankroll. Kelly decides how
          // much of it — ~all of it near certainty, about half at 80%.
          FIVEMIN_MAX_FRACTION: "1",
          FIVEMIN_KELLY: "1",
          // BTC's 15-second tails are fatter than a random walk's.
          FIVEMIN_VOL_MULT: "1.5",
          FIVEMIN_MIN_STAKE: "10",
          FIVEMIN_DRY_RUN: "false",
        },
        link: [memory],
        ...runtime,
        // From :X4:00 to the close plus settling and recording.
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
      bot: fiveMin.nodes.function.name,
      table: memory.name,
      dlq: dlq.url,
    };
  },
});
