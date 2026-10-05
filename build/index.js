#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
// Drop undefined values so optional inputs are not sent to the actor at all.
function compact(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoint carries a platform
// ceiling of 300 seconds on the HTTP wait and answers 408 past it while the run
// keeps going and keeps billing. Starting the run, polling it to a terminal
// status, and then reading the dataset waits as long as the actor needs.
//
// How long the actor run itself may take, in seconds: long enough for a large
// batch, short enough that a hung run cannot bill indefinitely.
const ACTOR_RUN_TIMEOUT_SECS = 1800;
// How long this wrapper waits: the run's own timeout plus two minutes, so the
// run's TIMED-OUT status is what the caller sees.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = Number(process.env.MAMBA_POLL_INTERVAL_MS ?? 3000);
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The actor types its switches as strings ("true"/"false") for Clay
// compatibility, because Clay sends every input as a string and a boolean typed
// field silently receives "false" and reads it as truthy. The model gets a real
// boolean and the actor gets the string it validates.
function boolToString(v) {
    return v === undefined ? undefined : v ? "true" : "false";
}
// actorPath is the actor's IMMUTABLE Apify actor id, not its slug, so a Store
// rename never breaks these calls.
async function runActor(actorPath, actorLabel, input) {
    if (!APIFY_TOKEN) {
        return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
    }
    // memory=512 is deliberate and matches the actor's declared
    // defaultRunOptions.memoryMbytes. an unspecified memory can run at 2048
    // MB, and `apify-actor-start` bills once per GB with a
    // minimum of one, so leaving the default in place would charge the caller
    // more start events per run than the actor asks for. Keep this in step with
    // the actor's defaultRunOptions.
    const headers = {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
    };
    const httpError = async (response) => {
        let detail = "";
        try {
            const body = (await response.json());
            if (body?.error?.message)
                detail = ` ${body.error.message}`;
        }
        catch {
            detail = "";
        }
        switch (response.status) {
            case 400:
                return `The ${actorLabel} run was rejected as invalid input.${detail}`;
            case 401:
                return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
            case 402:
                return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
            default:
                return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
        }
    };
    // 1. Start the run.
    let started;
    try {
        started = await fetch(`https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}&memory=512`, { method: "POST", headers, body: JSON.stringify(input) });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
    }
    if (!started.ok) {
        return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
    }
    let run;
    try {
        run = (await started.json()).data ?? {};
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
    }
    const runId = run.id;
    if (!runId) {
        return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
    }
    // 2. Poll to a terminal status.
    const deadline = Date.now() + WRAPPER_WAIT_MS;
    let status = run.status ?? "READY";
    let datasetId = run.defaultDatasetId;
    while (!TERMINAL.has(status)) {
        if (Date.now() >= deadline) {
            return {
                isError: true,
                content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
            };
        }
        await sleep(POLL_INTERVAL_MS);
        let poll;
        try {
            poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
        }
        if (!poll.ok) {
            return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
        }
        const body = (await poll.json());
        status = body.data?.status ?? status;
        datasetId = body.data?.defaultDatasetId ?? datasetId;
    }
    // 3. A run that did not succeed is a failure the caller must see, never an
    // empty success.
    if (status !== "SUCCEEDED") {
        return {
            isError: true,
            content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
        };
    }
    if (!datasetId) {
        return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
    }
    // 4. Read the dataset. Pass actor output through unchanged: the wrapper never
    // reinterprets a status field.
    let ds;
    try {
        ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
    }
    if (!ds.ok) {
        return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
    }
    let items;
    try {
        items = await ds.json();
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
    }
    if (!Array.isArray(items)) {
        const asObj = items;
        const detail = asObj?.error?.message ? `${asObj.error.message}` : JSON.stringify(items);
        return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}
const server = new McpServer({
    name: "mamba-meta-ad-library-monitor",
    version: pkg.version,
});
// Meta Ad Library Monitor (immutable actor ID J1GWlSXfSGU3u8Wng)
server.registerTool("find_meta_ads", {
    title: "Find Meta Ads",
    description: "Search the Meta Ad Library for a company's ads through Facebook's sanctioned Graph API and return ONE FLAT ROW PER AD with creative text, headline, delivery dates, the Meta surfaces it ran on and Meta's permanent snapshot URL for the rendered ad. COVERAGE IS NOT UNIVERSAL: the Ad Library holds all ads only in the EU and only political and issue ads elsewhere, so a commercial advertiser outside the EU is legitimately absent and every row carries a coverage note saying what the search could have found. Requires the caller's own Meta app access token, as the metaAccessToken argument or the META_ACCESS_TOKEN environment variable. Use it to check whether a company advertises on Facebook and Instagram right now or to pull a creative history; each call is a point in time read, so monitoring means calling it on a schedule and comparing rows. Not for organic posts or follower counts, which the brand presence mappers cover. Impressions and spend exist for political ads only and arrive as bands, so a null there is not zero spend. Read only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
        title: "Find Meta Ads",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
    inputSchema: {
        company_domain: z.string()
            .optional()
            .describe("Bare company domain, for example gymshark.com. Used to derive the advertiser search term when no company name is given, and used by the identity gate to check that a matched advertiser page really is this company."),
        company_name: z.string()
            .optional()
            .describe("Strongly recommended here. Meta advertiser search is a fuzzy text search over page names, so the company name is what the identity gate compares a matched page against. Without it the gate falls back to the domain stem, which is weaker."),
        metaAccessToken: z.string()
            .optional()
            .describe("YOUR OWN Meta app access token, free to create at developers.facebook.com. Required unless the server was started with the META_ACCESS_TOKEN environment variable, which keeps the token out of the chat transcript; the Ad Library API is not open, so with neither the call returns an error before any Apify run starts. Political and issue ad data additionally requires a verified identity on your Meta account, which is a Meta requirement."),
        ad_reached_countries: z.enum(["EU", "GB", "US", "DE", "FR", "NL", "ES", "IT", "IE", "ALL_EU_PLUS_UK"])
            .optional()
            .describe("Which country audiences to search. This parameter is REQUIRED by Meta and a request without it fails outright. The EU set is where the Ad Library covers ALL ads rather than only political ones, so it is the default."),
        ad_active_status: z.enum(["ACTIVE", "ALL", "INACTIVE"])
            .optional()
            .describe("Whether to return currently running ads, stopped ads, or both. ACTIVE is the default because a currently running ad is the buying signal; ALL is what you want for a creative history or a competitive teardown."),
        ad_type: z.enum(["ALL", "POLITICAL_AND_ISSUE_ADS"])
            .optional()
            .describe("ALL returns every ad the Ad Library holds for those countries. POLITICAL_AND_ISSUE_ADS narrows to the political archive, which is the only archive that carries impressions and spend, and which requires a verified identity on your Meta account."),
        media_type: z.enum(["ALL", "IMAGE", "VIDEO", "MEME", "NONE"])
            .optional()
            .describe("Narrow to a creative format. Useful for a creative teardown where you only care about video, and irrelevant for a simple \"are they advertising\" check."),
        maxAds: z.enum(["10", "25", "50", "100"])
            .optional()
            .describe("How many ad rows to return per company. This is a cost dial, not a change of answer: the row always reports how many ads matched before the cap."),
        skipCache: z.boolean()
            .optional()
            .describe("Default false: a successful lookup is cached for seven days and reused, which costs nothing on a repeated run. Set true to force a fresh fetch."),
    },
}, async ({ company_domain, company_name, metaAccessToken, ad_reached_countries, ad_active_status, ad_type, media_type, maxAds, skipCache }) => {
    const token = metaAccessToken ?? process.env.META_ACCESS_TOKEN;
    if (!token) {
        return { isError: true, content: [{ type: "text", text: "No Meta access token. Pass metaAccessToken, or start the server with the META_ACCESS_TOKEN environment variable. Create one free at developers.facebook.com; the Ad Library API is not open without it." }] };
    }
    return runActor("J1GWlSXfSGU3u8Wng", "Meta Ad Library Monitor", compact({
        company_domain,
        company_name,
        metaAccessToken: token,
        ad_reached_countries,
        ad_active_status,
        ad_type,
        media_type,
        maxAds,
        skipCache: boolToString(skipCache),
    }));
});
const transport = new StdioServerTransport();
await server.connect(transport);
