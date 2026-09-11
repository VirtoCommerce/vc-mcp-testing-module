import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as m from "./vc-secrets.mjs";              // the launcher
import * as oauth from "./vc-secrets-oauth.mjs";     // the protocol
import * as cache from "./vc-secrets-cache.mjs";     // entries, expiry, the lock
import crypto from "node:crypto";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// Two of the acquireLock socket tests below spawn a real second process to race or kill, and each
// writes its own throwaway script into a fresh tmp dir. Removed here rather than per-test so a
// thrown assertion still leaves nothing behind.
const tmpDirs = [];
after(() => {
    for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("vc-secrets-oauth throws the same VcSecretsError the launcher's exit-code path recognises", () => {
    // The whole reason VcSecretsError lives in its own module. Two same-named classes would both
    // print fine, but fail() reads `instanceof VcSecretsError` to pick the exit code, so a second
    // class silently degrades every oauth failure to a bare 1. That silent degrade is what this
    // pins. The source's comment also warned that a cyclic require would hand over `undefined`
    // instead of a class; that half does not carry to ESM — but not because cycles became loud.
    // There is no cycle here to begin with — vc-secrets-error.mjs imports nothing, which is the
    // whole reason it exists. Measured on the arrangement it avoids (the class back in the
    // launcher, used only inside a function): that cycle loads clean from either entry, and ESM
    // throws only when the binding is dereferenced during module EVALUATION. So reintroducing one
    // would be quiet until something validates at load, and fatal from then on — a warning, not a
    // reassurance, which is the direction the source's sentence got backwards. Either way ESM has no
    // `undefined` outcome, so that half needs no test; this one is for the silent degrade.
    assert.throws(() => oauth.parseTokenResponse(400, JSON.stringify({ error: "invalid_grant" }), 0), m.VcSecretsError);
});

test("exchange: the DEFAULT anchor source is the same clock the reader compares against", () => {
    // Nothing else executes the default wiring — every other exchange test injects `uptime`. So
    // substituting Date.now for os.uptime there passes the whole suite, survives
    // parseTokenResponse's finiteness guard (a millisecond epoch is perfectly finite), and stamps
    // an anchor ~1.7e12 "seconds". At read time that delta is hugely negative, the reboot rule
    // discards it, and EVERY entry is silently unprotected — the exact outcome the guard's own
    // comment claims to prevent. Finiteness is not the property that matters; provenance is.
    return oauth.exchange("t", "grant_type=refresh_token", {
        request: async () => ({ status: 200,
            body: JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 60 }) }),
        now: () => 0,
    }).then((r) => {
        assert.ok(Math.abs(r.uptimeAtIssue - os.uptime()) < 5,
            `the anchor must come from os.uptime(): got ${r.uptimeAtIssue}, uptime is ${os.uptime()}`);
    });
});

test("exchange: a refresh-grant renewal that rotates nothing is not read as a code grant", () => {
    // exchange derives the grant from the body it was handed. Getting that wrong applies the
    // code grant's "refresh_token is required" rule to a renewal, aborting a call that succeeded.
    return oauth.exchange("t", oauth.buildTokenBody({ kind: "refresh", clientId: "c",
        redirectUri: "http://localhost:1/", refreshToken: "rt", scopes: ["a"] }), {
        request: async () => ({ status: 200, body: JSON.stringify({ access_token: "at", expires_in: 3600 }) }),
        now: () => 0,
    }).then((r) => {
        assert.equal(r.accessToken, "at");
        assert.equal(r.refreshToken, undefined);
    });
});

test("exchange: passes the body to the injected request and returns the parsed result", async () => {
    const seen = [];
    const r = await oauth.exchange("t", "grant_type=refresh_token", {
        request: async (url, body) => { seen.push([url, body]); return { status: 200,
            body: JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 60 }) }; },
        now: () => 0,
        uptime: () => 12_345,
    });
    assert.equal(seen[0][0], "https://login.microsoftonline.com/t/oauth2/v2.0/token");
    assert.equal(seen[0][1], "grant_type=refresh_token");
    assert.equal(r.accessToken, "at");
    assert.equal(r.uptimeAtIssue, 12_345,
        "exchange must stamp the monotonic reading it took, or every entry it writes is unprotected");
});

test("createPkcePair: S256 challenge is base64url of the verifier's digest", () => {
    const { verifier, challenge } = oauth.createPkcePair();
    const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
    assert.equal(challenge, expected);
    assert.match(verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
});

test("createPkcePair: two pairs never agree", () => {
    // The positive control for the digest test above, which also passes for a constant
    // verifier: a fixed one would make every authorize request replayable.
    assert.notEqual(oauth.createPkcePair().verifier, oauth.createPkcePair().verifier);
});

test("buildAuthorizeUrl: response_mode is query and the challenge method is S256", () => {
    const u = new URL(oauth.buildAuthorizeUrl({ tenantId: "t", clientId: "c", scopes: ["a", "b"],
        redirectUri: "http://localhost:1234/callback", state: "st", challenge: "ch" }));
    assert.equal(u.origin + u.pathname, "https://login.microsoftonline.com/t/oauth2/v2.0/authorize");
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("response_mode"), "query");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("scope"), "a b");
});

test("buildAuthorizeUrl: the verifier is never in the URL, only its digest", () => {
    const { verifier, challenge } = oauth.createPkcePair();
    const url = oauth.buildAuthorizeUrl({ tenantId: "t", clientId: "c", scopes: ["a"],
        redirectUri: "http://localhost:1/", state: "st", challenge });
    assert.ok(!url.includes(verifier), "PKCE is worthless if the verifier travels with the request");
});

// FIVE tests below are NOT ported, and they are interleaved with ported ones rather than
// contiguous, so they are named here rather than bounded by position: "the challenge itself
// travels", "client_id, redirect_uri and state", "the refresh grant carries the token it is
// refreshing", "both grants carry client_id and scope", and "the code grant carries no refresh
// token". A name that no longer matches one below means this note went stale, not that you
// miscounted. The source's suite leaves these fields unpinned
// because there mcpw.js imports this module and a real `login` exercised most of them end to end.
// Nothing imports this module yet, so until it is wired up they are all that stands between a
// tidy-up of the two builders and a protocol request that is still well-formed and no longer safe.

test("buildAuthorizeUrl: the challenge itself travels, not only the method that advertises it", () => {
    // Measured: dropping `code_challenge` leaves the URL still advertising
    // code_challenge_method=S256. What Entra then does with such a request is not knowable from
    // this repository, and that is the risk — if it serves it as an ordinary non-PKCE sign-in, the
    // authorization code stops being bound to whoever asked for it and nothing local reports it.
    const u = new URL(oauth.buildAuthorizeUrl({ tenantId: "t", clientId: "c", scopes: ["a"],
        redirectUri: "http://localhost:1/", state: "st", challenge: "the-challenge" }));
    assert.equal(u.searchParams.get("code_challenge"), "the-challenge");
});

test("buildAuthorizeUrl: client_id, redirect_uri and state reach the request unaltered", () => {
    // No callback layer is ported yet, and that is precisely why these are asserted here: the
    // consumer that would notice a missing `state` — a listener comparing it against the one it
    // generated — does not exist in this package, so nothing downstream fails if the builder
    // stops emitting it.
    const u = new URL(oauth.buildAuthorizeUrl({ tenantId: "t", clientId: "the-client", scopes: ["a"],
        redirectUri: "http://localhost:1/", state: "the-state", challenge: "ch" }));
    assert.equal(u.searchParams.get("client_id"), "the-client");
    assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:1/");
    assert.equal(u.searchParams.get("state"), "the-state");
});

test("buildTokenBody: code grant carries the verifier and the code", () => {
    const b = new URLSearchParams(oauth.buildTokenBody({ kind: "code", clientId: "c",
        redirectUri: "http://localhost:1/", code: "the-code", verifier: "the-verifier", scopes: ["a"] }));
    assert.equal(b.get("grant_type"), "authorization_code");
    assert.equal(b.get("code"), "the-code");
    assert.equal(b.get("code_verifier"), "the-verifier");
});

test("buildTokenBody: refresh grant carries no code and no verifier", () => {
    const b = new URLSearchParams(oauth.buildTokenBody({ kind: "refresh", clientId: "c",
        redirectUri: "http://localhost:1/", refreshToken: "rt", scopes: ["a"] }));
    assert.equal(b.get("grant_type"), "refresh_token");
    assert.equal(b.get("code"), null);
    assert.equal(b.get("code_verifier"), null);
});

test("buildTokenBody: the refresh grant carries the token it is refreshing", () => {
    // Its sibling above pins what the refresh body must NOT contain; nothing pinned the one field
    // it exists to carry. Dropping it still produces a well-formed grant_type=refresh_token body,
    // so the mistake leaves this package looking correct and surfaces only as whatever the token
    // endpoint says about a request that names no token.
    const b = new URLSearchParams(oauth.buildTokenBody({ kind: "refresh", clientId: "c",
        redirectUri: "http://localhost:1/", refreshToken: "the-token", scopes: ["a"] }));
    assert.equal(b.get("refresh_token"), "the-token");
});

test("buildTokenBody: both grants carry client_id and scope, and the code grant its redirect_uri", () => {
    // redirect_uri on the code grant is not a destination — nothing is redirected at exchange
    // time. It is the value the authorization-code grant is expected to repeat from the authorize
    // step, so a body that omits it is refused for a reason that names neither builder.
    const code = new URLSearchParams(oauth.buildTokenBody({ kind: "code", clientId: "the-client",
        redirectUri: "http://localhost:1/", code: "c0de", verifier: "v", scopes: ["a", "b"] }));
    assert.equal(code.get("client_id"), "the-client");
    assert.equal(code.get("redirect_uri"), "http://localhost:1/");
    assert.equal(code.get("scope"), "a b", "the code grant must ask for the scopes it was given");
    const refresh = new URLSearchParams(oauth.buildTokenBody({ kind: "refresh", clientId: "the-client",
        redirectUri: "http://localhost:1/", refreshToken: "rt", scopes: ["a", "b"] }));
    assert.equal(refresh.get("client_id"), "the-client");
    assert.equal(refresh.get("scope"), "a b", "a renewal that drops the scopes renews a narrower token");
    // The name above states a relation, so both halves need asserting: without this, moving
    // redirect_uri into the shared header — so both grants carry it — leaves the suite green.
    assert.equal(refresh.get("redirect_uri"), null, "the redirect belongs to the code grant alone");
});

test("buildTokenBody: the code grant carries no refresh token", () => {
    // The mirror of "refresh grant carries no code and no verifier", which had no counterpart.
    // The fixture supplies a refresh token it must not travel with: omitting it would leave the
    // assertion two causes — the branch never sets the field, or there was nothing to set — and
    // the realistic defect has the second shape. A maintainer adding a defensive
    // `if (refreshToken) { body.set(...) }` to the code branch survives an empty fixture — measured.
    // Posting a real token then needs a second change, a caller that passes refreshToken on the
    // code grant, which no call site does today; the fixture is what keeps the assertion able to
    // notice the first change before the second one arrives to make it matter.
    const b = new URLSearchParams(oauth.buildTokenBody({ kind: "code", clientId: "c",
        redirectUri: "http://localhost:1/", code: "c0de", verifier: "v",
        refreshToken: "rt-must-not-travel", scopes: ["a"] }));
    assert.equal(b.get("refresh_token"), null);
});

test("buildTokenBody: an unknown grant kind is refused rather than posted as a refresh", () => {
    // Falling through would post refresh_token=undefined to Entra and report whatever it says
    // about that, instead of the caller's actual mistake.
    assert.throws(() => oauth.buildTokenBody({ kind: "bogus", clientId: "c",
        redirectUri: "http://localhost:1/", scopes: ["a"] }), m.VcSecretsError);
});

test("parseTokenResponse: maps expires_in to an absolute stamp and keeps the lifetime", () => {
    const r = oauth.parseTokenResponse(200,
        JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), 1_000, "code", 500);
    assert.equal(r.expiresAt, 1_000 + 3600_000);
    assert.equal(r.lifetimeMs, 3600_000);
    assert.equal(r.obtainedAt, 1_000);
    assert.equal(r.uptimeAtIssue, 500, "the monotonic reading must be taken with the wall clock, not later");
});

test("parseTokenResponse: the monotonic reading is required, not defaulted", () => {
    // Defaulting it would let a caller forget, and a missing anchor is invisible until a clock
    // moves — at which point the entry is exactly as unprotected as before the anchor existed.
    assert.throws(() => oauth.parseTokenResponse(200,
        JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), 1_000, "code"),
    /uptime/i);
});

test("parseTokenResponse: a response with no usable expires_in is refused, not cached as never-expiring", () => {
    // Number(undefined) * 1000 is NaN, and `NaN <= MARGIN_MS` is false — so an entry stamped
    // with a NaN expiry reads as valid forever, and the launcher, which is deliberately out of
    // the data path and never sees a 401, keeps handing over a token that died an hour ago.
    for (const expires_in of [undefined, "soon", -5, 0]) {
        assert.throws(() => oauth.parseTokenResponse(200,
            JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in }), 0, "code"),
        /expires_in/, `expires_in=${JSON.stringify(expires_in)} must be refused`);
    }
});

test("parseTokenResponse: on the CODE grant, no refresh token is an error naming offline_access", () => {
    assert.throws(() => oauth.parseTokenResponse(200,
        JSON.stringify({ access_token: "at", expires_in: 60 }), 0, "code"), /offline_access/);
});

test("parseTokenResponse: on the REFRESH grant, no refresh token means keep the existing one", () => {
    // RFC 6749 section 6 makes refresh_token optional in a refresh-grant response — the
    // client keeps the one it has. Applying the code-grant rule here would abort a
    // renewal that succeeded and hand the developer a consent problem that does not
    // exist, sending them to an administrator over a valid response.
    const r = oauth.parseTokenResponse(200,
        JSON.stringify({ access_token: "at2", expires_in: 3600 }), 5_000, "refresh", 500);
    assert.equal(r.accessToken, "at2");
    assert.equal(r.refreshToken, undefined, "absent means unchanged, and the caller keeps its own");
});

test("parseTokenResponse: a rotated refresh token on the refresh grant is returned", () => {
    const r = oauth.parseTokenResponse(200,
        JSON.stringify({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 }), 5_000, "refresh", 500);
    assert.equal(r.refreshToken, "rt2");
});

test("parseTokenResponse: a 2xx without a usable access token is an error, not a usable entry", () => {
    // Without this the "keep the existing refresh token" rule above degrades into accepting any
    // 2xx at all, and the caller caches an entry whose accessToken is undefined. The empty-string
    // case is what makes the second half of the check decide something: absent settles the type
    // half on its own, so without a blank fixture that half is deletable while the suite is green.
    for (const access_token of [undefined, ""]) {
        assert.throws(() => oauth.parseTokenResponse(200,
            JSON.stringify({ access_token, refresh_token: "rt", expires_in: 3600 }), 0, "refresh"),
        /access token/i, `access_token=${JSON.stringify(access_token)} must be refused`);
    }
});

test("parseTokenResponse: a non-JSON 2xx body names the endpoint and echoes nothing", () => {
    // Node embeds the first ten characters of the input in a JSON SyntaxError, so an
    // unwrapped parse both misreports and prints a token prefix.
    assert.throws(() => oauth.parseTokenResponse(200, "eyJhbGciOiJSUzI1NiJ9.oops", 0, "refresh"), (e) => {
        assert.match(e.message, /token endpoint/i);
        assert.doesNotMatch(e.message, /eyJhbGci/, "a SyntaxError would carry the first ten characters");

        return true;
    });
});

test("parseTokenResponse: an Entra error surfaces its code, never the body verbatim", () => {
    assert.throws(() => oauth.parseTokenResponse(400, JSON.stringify({ error: "invalid_grant",
        error_description: "AADSTS70008: expired", trace_id: "x" }), 0), /invalid_grant.*AADSTS70008/s);
});

test("parseTokenResponse: an error body's other fields do not travel into the message", () => {
    // The positive control for the test above, which also passes for a message built by
    // JSON.stringify of the whole body — and an error body can carry a token hint.
    assert.throws(() => oauth.parseTokenResponse(400, JSON.stringify({ error: "invalid_grant",
        error_description: "AADSTS70008: expired", trace_id: "trace-must-not-leak" }), 0),
    (e) => !e.message.includes("trace-must-not-leak"));
});

test("parseTokenResponse: a non-JSON error body still reports the status without echoing it", () => {
    assert.throws(() => oauth.parseTokenResponse(502, "<html>eyJhbGciOi bad gateway</html>", 0, "refresh"), (e) => {
        assert.match(e.message, /502/);
        assert.doesNotMatch(e.message, /eyJhbGci/);

        return true;
    });
});

test("parseTokenResponse: only a judged grant is refused — a throttle or an outage is not", () => {
    // The whole point of the tag. A 503 tagged as a refusal tells the developer to sign in again,
    // which rotates a LIVE refresh token to fix an outage the next tick would have ridden out.
    const tag = (status, body) => {
        try {
            oauth.parseTokenResponse(status, body, 1000, "refresh", 5);
        } catch (e) {
            return e.refused;
        }

        return "did not throw";
    };
    assert.equal(tag(400, JSON.stringify({ error: "invalid_grant" })), true);
    assert.equal(tag(401, JSON.stringify({ error: "invalid_client" })), true);
    assert.equal(tag(503, "<html>gateway</html>"), false);
    assert.equal(tag(429, JSON.stringify({ error: "temporarily_unavailable" })), false);
    assert.equal(tag(408, ""), false);
});

// Measured on this machine: a bind that is refused does NOT throw from listen() — it emits
// an 'error' event, and an unattached one aborts the whole process instead of failing one test.
// So the probe attaches a handler, which makes it async, which is why the skip decision happens
// inside each test rather than in a module-level constant.
//
// Adapted from the source's unix-domain-socket probe: the capability under test here is a
// loopback TCP bind, covering httpsPostForm's socket-drop behaviour, so the probe binds one
// instead of a unix socket — probing the wrong permission would answer confidently either way.
// The lock-file tests that need a real unix-socket bind get their own gate and probe further
// down (canBindLocks/lockTest), because they exercise a different privilege than this one.
let bindProbe = null;
function canBindSockets() {
    bindProbe ??= new Promise((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.once("listening", () => probe.close(() => resolve(true)));
        probe.listen(0, "127.0.0.1");
    });

    return bindProbe;
}

// This is the only coverage httpsPostForm's socket-drop behaviour has. Measured on this machine:
// a loopback TCP bind is permitted both inside and outside the Claude Code sandbox — it is the
// unix-socket bind the sandbox refuses, which is what the source's probe tested and why this one
// was changed. So the expected outcome here is RUN, not skip: a run reporting it skipped means a
// broken probe or an unusually restricted host, and either way the skip is a signal.
const socketTest = (name, fn) => test(name, async (t) => {
    if (!(await canBindSockets())) {
        t.skip("needs an environment that permits a loopback TCP bind");

        return;
    }
    await fn(t);
});

socketTest("httpsPostForm: a connection dropped after the headers REJECTS, it does not hang", async () => {
    // The defect this pins was a hang, not a crash: node emits the error on the RESPONSE stream, and an
    // IncomingMessage with no listener swallows it, so the promise stayed pending forever. Measured.
    // What that costs is silence -- on the renewal path `renewing` never clears, so the launcher stops
    // renewing for the rest of its life and the server dies when its access token expires.
    //
    // Driven through the real wiring with http.request rather than an injected `request`, because an
    // injected transport exercises none of the code that was broken.
    let gotRequest = false;
    const server = http.createServer((req, res) => {
        gotRequest = true;
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.write('{"partial":');
            setTimeout(() => res.socket.destroy(), 20);
        });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
        const port = server.address().port;
        const attempt = oauth.httpsPostForm(`http://127.0.0.1:${port}/token`, "grant_type=refresh_token",
            { requestImpl: http.request });
        // Raced, so a regression FAILS instead of hanging the suite.
        const outcome = await Promise.race([
            attempt.then(() => "resolved", (e) => e),
            new Promise((r) => setTimeout(() => r("HUNG"), 4000)),
        ]);
        assert.notEqual(outcome, "HUNG", "the promise must settle; pending forever is the defect");
        assert.notEqual(outcome, "resolved", "a truncated body must not read as a token response");
        assert.ok(outcome instanceof m.VcSecretsError, `expected a VcSecretsError, got ${outcome}`);
        // The two below MUST stay below the three above. They read `outcome.message`, and when the
        // hang regresses `outcome` is the string "HUNG" — but because assert.match carries an
        // explicit message, Node reports that message rather than an argument-type error. Measured
        // by deleting res.on("error"): with these two first, the headline regression announced
        // "rejected through the request listener", which is false, and the sentence written for the
        // hang never ran. Order is the fix, not a tidy-up.
        //
        // Both are needed. `gotRequest` rules out a connect-time failure; it does not rule out a
        // socket dropped after the handler ran but before any response byte, which rejects through
        // req.on("error") and satisfies every other assertion here — measured. The match is
        // anchored because "response failed" is not reserved to this listener: rewording the OTHER
        // one to "response failed to open" defeated a floating match with the suite still green.
        // Matching on wording is the assertion here rather than a shortcut — the module's "a tag
        // rather than a message match" argument is about a branch taken at runtime, which fails
        // silently, whereas a test fails loudly. It holds only while this module stays a verbatim
        // transcription of mcpw-oauth.js; if that is ever allowed to diverge, this needs a tag.
        assert.ok(gotRequest, "the server never saw the request; the response path was not exercised");
        // The leak check goes ABOVE the prefix match, and that order is load-bearing for the same
        // reason as the block above. An edit that echoes the body AND rewords the prefix fails the
        // match first, so a refresh token sitting in the error text is reported as a wording
        // complaint and this line never runs. Measured.
        assert.doesNotMatch(outcome.message, /grant_type|refresh_token=/,
            "the request body carried a refresh token and must not be echoed");
        // Says what it observed, not what caused it: a missing prefix means the rejection did not
        // come from the response listener, OR that listener was reworded. Naming only the first
        // made the test announce a request-listener rejection on a reword that came through the
        // response listener — measured, and false.
        assert.match(outcome.message, /^token endpoint response failed: /,
            "no response-listener prefix: either the rejection came through the request listener, "
            + "or the response listener was reworded and this match must be updated with it");
    } finally {
        await new Promise((r) => server.close(r));
    }
});

// ---------------------------------------------------------------------------------------------
// vc-secrets-cache.mjs — two keystore entries, their expiry check, and the cross-process refresh
// lock. Ported from the upstream launcher's cache module and its suite: `c.` below becomes `cache.`,
// `m.McpwError` becomes `m.VcSecretsError`. `entryNames` has no test here — the source's own is
// not ported, because `oauthEntryKeys()` in vc-secrets.mjs already fills that role for this
// package, and a second incompatible name generator would be the defect.
// ---------------------------------------------------------------------------------------------

// The identity a cache entry must carry to match the OAuth declaration these tests exercise.
const DECL_IDENTITY = { tenantId: "t", clientId: "c", scopes: ["scope-a", "scope-b"] };
const DECL = { ...DECL_IDENTITY };

// An access entry exactly as parseTokenResponse produces one, so every expiry assertion below
// runs against a state production can actually reach. Hand-writing the pair is what made the
// previous version of the clock check a tautology.
const UPTIME_AT_ISSUE = 1_000;   // seconds; an arbitrary "the host has been up a while"

function freshAccess(issuedAt, lifetimeSeconds = 3600, uptimeAtIssue = UPTIME_AT_ISSUE) {
    return oauth.parseTokenResponse(200, JSON.stringify({ access_token: "a", refresh_token: "r",
        expires_in: lifetimeSeconds }), issuedAt, "code", uptimeAtIssue);
}

function cacheAt(issuedAt, identity = DECL_IDENTITY) {
    return { refresh: { refreshToken: "r", ...identity }, access: freshAccess(issuedAt) };
}

// Reads the cache `elapsed` ms after issue. The two clocks agree unless a case deliberately
// separates them: `clockElapsed` is what the wall clock believes, `uptimeElapsed` is what the
// monotonic counter believes, and every interesting case is a disagreement between the two.
// (Parameter named `entryCache`, not `cache` — the module is imported as `cache` above, and
// shadowing it here would turn every `cache.cacheStatus` call inside this function into a call on
// whatever cache entry the caller passed in. Not a silent hazard, though: measured, the shadowed
// form reddens 18 tests with `cache.cacheStatus is not a function`. The naming stands because the
// failure is confusing, not because it would be quiet.)
function statusAfter(entryCache, elapsed, { clockElapsed = elapsed, uptimeElapsed = elapsed,
    issuedAt = 0, uptimeAtIssue = UPTIME_AT_ISSUE } = {}) {
    return cache.cacheStatus(entryCache, DECL, issuedAt + clockElapsed, uptimeAtIssue + uptimeElapsed / 1000);
}

test("cacheStatus: absent when there is no refresh entry", () => {
    assert.equal(statusAfter({}, 1000).state, "absent");
});

test("cacheStatus: a usable access entry with no refresh entry is still absent", () => {
    // Deliberate, not an oversight: spending the access token and only then discovering there
    // is nothing to renew with trades a clear failure now for an opaque one inside the hour.
    assert.equal(statusAfter({ access: freshAccess(0) }, 60_000).state, "absent");
});

test("cacheStatus: a refresh entry with no access entry needs a refresh, not a login", () => {
    assert.equal(statusAfter({ refresh: { refreshToken: "r", ...DECL_IDENTITY } }, 0).state, "needs-refresh");
});

test("cacheStatus: identity is checked before the access entry, not after it", () => {
    // Not ported — the source's suite leaves the ORDER of the two checks unpinned, and every other
    // identity test here carries an access entry, so all of them pass if the access-entry check is
    // hoisted above the identity comparison. Measured: under that hoist this case answers
    // `needs-refresh` instead of `identity-mismatch`, and `needs-refresh` drives an exchange —
    // spending a refresh token issued for one tenant and client against a different declaration,
    // which is the outcome the identity check exists to prevent. An absent access entry is the
    // cheap, expected loss, so this is a state a real cache reaches routinely.
    const moved = { ...DECL_IDENTITY, tenantId: "00000000-0000-0000-0000-000000000000" };
    assert.equal(statusAfter({ refresh: { refreshToken: "r", ...moved } }, 0).state, "identity-mismatch");
});

test("cacheStatus: identity mismatch on each field of the declaration in turn", () => {
    // One fixture per operand. Without all three, a check comparing only the tenant passes
    // every test a check comparing all three would, and a moved clientId silently reuses a
    // refresh token issued to a different application.
    const moved = {
        tenantId: { ...DECL_IDENTITY, tenantId: "00000000-0000-0000-0000-000000000000" },
        clientId: { ...DECL_IDENTITY, clientId: "99999999-9999-9999-9999-999999999999" },
        scopes: { ...DECL_IDENTITY, scopes: [...DECL_IDENTITY.scopes, "extra/.default"] },
    };
    for (const [field, identity] of Object.entries(moved)) {
        assert.equal(statusAfter(cacheAt(0, identity), 60_000).state, "identity-mismatch",
            `a moved ${field} must not reuse the cached token`);
    }
});

test("cacheStatus: scope set compared as a set, not a string", () => {
    const reordered = { ...DECL_IDENTITY, scopes: [...DECL_IDENTITY.scopes].reverse() };
    assert.equal(statusAfter(cacheAt(0, reordered), 60_000).state, "valid");
});

test("cacheStatus: a scope list of the same length but different members is a mismatch", () => {
    // The positive control for the set comparison: sorting and joining also makes two lists
    // of equal length compare equal if only their lengths are checked.
    const swapped = { ...DECL_IDENTITY,
        scopes: DECL_IDENTITY.scopes.map((s, i) => (i === 0 ? "other/.default" : s)) };
    assert.equal(statusAfter(cacheAt(0, swapped), 60_000).state, "identity-mismatch");
});

test("cacheStatus: one scope holding a space is not the same set as the two it joins to", () => {
    // What the length comparison is for. Sorting and joining maps ["a b"] and ["a", "b"] to the
    // same string, so without the length check a single malformed scope entry matches a correct
    // two-scope declaration and the cached token is reused against a scope set nobody granted.
    const collided = { ...DECL_IDENTITY, scopes: [[...DECL_IDENTITY.scopes].sort().join(" ")] };
    assert.equal(collided.scopes.length, 1, "the fixture is only meaningful as a single element");
    assert.equal(statusAfter(cacheAt(0, collided), 60_000).state, "identity-mismatch");
});

test("cacheStatus: valid well inside the token's life", () => {
    const status = statusAfter(cacheAt(0), 60_000);
    assert.equal(status.state, "valid");
    assert.equal(status.accessToken, "a", "a valid status must hand over the token it validated");
});

test("cacheStatus: needs refresh inside the margin, and the margin boundary is inclusive", () => {
    const lifetime = 3600_000;
    assert.equal(statusAfter(cacheAt(0), lifetime - cache.MARGIN_MS).state, "needs-refresh",
        "exactly at the margin is already too late — the call it is about to make outlives it");
    assert.equal(statusAfter(cacheAt(0), lifetime - cache.MARGIN_MS - 1).state, "valid",
        "one millisecond outside the margin is still usable");
});

test("cacheStatus: an expired token is not valid", () => {
    assert.equal(statusAfter(cacheAt(0), 3600_001).state, "needs-refresh");
});

test("cacheStatus: a rollback landing inside the token's own lifetime is caught by the anchor", () => {
    // The case the wall clock alone cannot see, and the whole reason the anchor exists. The host
    // slept and came back half an hour behind: an hour of real time has passed, so the token is
    // spent, but the wall clock reports only thirty minutes of it. Before the anchor this read
    // `valid` and the launcher handed over a dead token — measured, not argued.
    const spent = statusAfter(cacheAt(0), 3600_000, { clockElapsed: 1800_000 });
    assert.equal(spent.state, "needs-refresh");
    // And the wall clock alone still says it is fine, which is what makes the case discriminating.
    assert.equal(statusAfter(cacheAt(0), 1800_000).state, "valid");
});

test("cacheStatus: a rollback past the issue time no longer costs a needless exchange", () => {
    // Before the anchor this had to be treated as a rollback and refreshed, because a clock
    // reading earlier than the issue time was the only evidence available that something was
    // wrong. With a second source the truth is visible: one minute of real time has passed and
    // the token is young, so the wall clock being two hours out is no longer our problem.
    assert.equal(statusAfter(cacheAt(0), 60_000, { clockElapsed: -2 * 3600_000 }).state, "valid");
});

test("cacheStatus: a rollback past the issue time with no usable anchor is still refused", () => {
    // Reboot plus a backwards clock — the one case the anchor cannot cover, since its stored
    // reading belongs to a boot that is gone. Both sources then place the issue in the future,
    // and an age that cannot be established is a refusal rather than a guess.
    assert.equal(statusAfter(cacheAt(0), 60_000,
        { clockElapsed: -2 * 3600_000, uptimeElapsed: -UPTIME_AT_ISSUE * 1000 + 5_000 }).state,
    "needs-refresh");
});

test("cacheStatus: a monotonic counter that missed a suspend is covered by the wall clock", () => {
    // WSL2 pauses the guest when the Windows host sleeps, so the guest's counter may not tick
    // across the pause — the anchor's own failure direction, and the reason elapsed is the MAX
    // of the two rather than the anchor alone. Here the counter believes one minute passed while
    // the wall clock, correctly, reports the whole hour.
    assert.equal(statusAfter(cacheAt(0), 3600_000, { uptimeElapsed: 60_000 }).state, "needs-refresh");
});

test("cacheStatus: after a reboot the anchor is ignored rather than believed", () => {
    // os.uptime() restarts at zero, so the stored reading is from a boot that no longer exists
    // and the difference goes negative. A negative elapsed would otherwise INFLATE the remaining
    // life and make an expired token look freshly issued.
    const rebooted = statusAfter(cacheAt(0), 3600_000, { uptimeElapsed: -UPTIME_AT_ISSUE * 1000 + 5_000 });
    assert.equal(rebooted.state, "needs-refresh", "the wall clock still says the hour is up");
    assert.equal(statusAfter(cacheAt(0), 60_000, { uptimeElapsed: -UPTIME_AT_ISSUE * 1000 + 5_000 }).state,
        "valid", "and a young token is still usable — a reboot is not itself a reason to re-exchange");
});

test("cacheStatus: a caller that omits the monotonic reading is stopped, not quietly downgraded", () => {
    // Omitting it makes byUptime NaN, NaN >= 0 is false, and the function falls back to exactly
    // the wall-clock-only rule the anchor replaced — no throw, no needs-refresh, nothing red.
    // There is no production caller yet, so the wiring commit is precisely when that would bite.
    assert.throws(() => cache.cacheStatus(cacheAt(0), DECL, 60_000), /uptime/i);
    assert.throws(() => cache.cacheStatus(cacheAt(0), DECL, 60_000, NaN), /uptime/i);
    assert.throws(() => cache.cacheStatus(cacheAt(0), DECL, undefined, 1060), /now/i);
});

test("cacheStatus: an entry whose stamps are not real numbers is refused, never aged", () => {
    // Each of these is a number the arithmetic silently absorbs. Missing obtainedAt makes the
    // WALL term NaN, and Math.max propagates NaN, so a perfectly honest anchor is destroyed by
    // it: measured, an entry ten years past its expiry read as valid. `null` is what
    // JSON.stringify writes for a NaN, so it is reachable from a keystore blob, not only by hand.
    for (const [field, value] of [["obtainedAt", undefined], ["obtainedAt", null],
        ["lifetimeMs", null], ["uptimeAtIssue", null], ["uptimeAtIssue", "1000"]]) {
        const access = { ...freshAccess(0), [field]: value };
        const entryCache = { refresh: { refreshToken: "r", ...DECL_IDENTITY }, access };
        assert.equal(cache.cacheStatus(entryCache, DECL, 60_000, UPTIME_AT_ISSUE + 60).state, "needs-refresh",
            `${field}=${JSON.stringify(value)} must not be aged`);
    }
});

test("cacheStatus: an access entry with no lifetime is refused rather than half-checked", () => {
    const { lifetimeMs, ...noLifetime } = freshAccess(0);
    assert.equal(lifetimeMs, 3600_000, "the fixture is only meaningful if the field really was there");
    assert.equal(statusAfter({ refresh: { refreshToken: "r", ...DECL_IDENTITY }, access: noLifetime },
        60_000).state, "needs-refresh");
});

test("cacheStatus: an access entry written before the anchor existed is refused, not half-trusted", () => {
    // Such an entry cannot be checked against a rolled-back clock at all. One extra exchange is
    // the whole cost of refusing it; accepting it silently reinstates the hole the anchor closed.
    const { uptimeAtIssue, ...noAnchor } = freshAccess(0);
    assert.equal(uptimeAtIssue, UPTIME_AT_ISSUE, "the fixture is only meaningful if the field really was there");
    assert.equal(statusAfter({ refresh: { refreshToken: "r", ...DECL_IDENTITY }, access: noAnchor },
        60_000).state, "needs-refresh");
});

test("cacheStatus: a plausible clock nudge does not force a needless exchange", () => {
    // The guard must fire on a rollback, not on ordinary NTP correction, or every small
    // adjustment costs a refresh-token rotation. BOTH sources are nudged here: leaving the
    // anchor honest would let it decide the case, and the allowance itself would go untested.
    const nudge = -cache.SKEW_TOLERANCE_MS / 2;
    assert.equal(statusAfter(cacheAt(0), 0, { clockElapsed: nudge, uptimeElapsed: nudge }).state,
        "valid", "half a minute of correction is not a rollback");
    const past = -cache.SKEW_TOLERANCE_MS - 1;
    assert.equal(statusAfter(cacheAt(0), 0, { clockElapsed: past, uptimeElapsed: past }).state,
        "needs-refresh", "past the allowance, with nothing else to go on, it is a rollback again");
});

test("cacheStatus: a small negative anchor delta cannot rescue a badly rolled-back clock", () => {
    // Reboot shortly after the token was issued, plus a clock two hours behind. The anchor's
    // delta is then negative but TINY, so taking the max of the two would pick it and read the
    // age as a harmless nudge — turning a two-hour rollback into a token that looks freshly
    // issued. A negative delta has to be discarded outright, not merely lose a comparison.
    // Built by hand rather than through statusAfter: this case needs the STORED anchor small,
    // which is the one thing the helper's defaults fix.
    const justAfterBoot = 30;   // seconds of uptime when the token was issued
    const entryCache = { refresh: { refreshToken: "r", ...DECL_IDENTITY },
        access: freshAccess(0, 3600, justAfterBoot) };
    assert.equal(cache.cacheStatus(entryCache, DECL, -2 * 3600_000, justAfterBoot - 1).state, "needs-refresh");
});

test("serialize/parse: a refresh entry round-trips with its identity intact", () => {
    const entry = { refreshToken: "rt", ...DECL_IDENTITY };
    assert.deepEqual(cache.parseEntry(cache.serializeRefresh(entry)), { schema: 1, ...entry });
});

test("serialize/parse: an access entry round-trips with the fields the expiry check reads", () => {
    const access = freshAccess(1_000);
    const back = cache.parseEntry(cache.serializeAccess(access));
    for (const field of ["accessToken", "expiresAt", "obtainedAt", "lifetimeMs", "uptimeAtIssue"]) {
        assert.equal(back[field], access[field], `${field} must survive the round trip`);
    }
});

test("serializeAccess: dropping the anchor on the way to disk is not silently survivable", () => {
    // JSON.stringify omits an undefined field entirely, so a serializer that forgot uptimeAtIssue
    // would produce a perfectly valid-looking entry that simply has no rollback protection.
    const stored = JSON.parse(cache.serializeAccess(freshAccess(1_000)));
    assert.ok(Object.hasOwn(stored, "uptimeAtIssue"), `the anchor must reach disk: ${Object.keys(stored)}`);
});

test("parseEntry: rejects a schema version it does not know", () => {
    assert.throws(() => cache.parseEntry(JSON.stringify({ schema: 99 })), /schema/);
});

test("parseEntry: unreadable input is absent, and nothing about it is echoed", () => {
    // Never a rethrow: node embeds the first ten characters of the input in a JSON SyntaxError,
    // and this input is a keystore blob. Absent is also the actionable answer for whatever calls
    // this — there is no `login` verb yet (VERBS, vc-secrets.mjs); it arrives with a later task.
    assert.equal(cache.parseEntry("eyJhbGciOiJSUzI1NiJ9.truncated"), null);
    assert.equal(cache.parseEntry(""), null);
});

// lockPathFor now takes a PROJECT axis as well as the entry name (source had only the entry), so
// every test below is adapted rather than copied: every call takes the extra scope argument. The
// per-platform tests below and "two projects declaring the same entry name..." further down pin
// that the scope segment actually reaches the name and that two different scopes never collide on
// win32, darwin and linux respectively; the remaining tests carry the argument only to keep the
// call real, since their own subject is the user axis, the entry axis, or a name-injection
// boundary.

test("lockPathFor: an abstract name on linux, with no filesystem entry", () => {
    const p = cache.lockPathFor("azure-mcp", "proj", { platform: "linux", userInfo: () => ({ uid: 1000 }) });
    assert.equal(p[0], "\0", "a leading NUL is what puts the name in the abstract namespace");
    assert.ok(!p.includes("/"), "an abstract name must not look like a path");
    assert.ok(Buffer.byteLength(p) <= 100, "sun_path caps the whole name");
});

test("lockPathFor: two users do not collide on linux either", () => {
    // The abstract namespace is per network namespace, not per user, so it is machine-global
    // for the same reason a pipe name is: without the user in the name, one developer's
    // refresh locks every other account on the host out of theirs.
    const a = cache.lockPathFor("azure-mcp", "proj", { platform: "linux", userInfo: () => ({ uid: 1000 }) });
    const b = cache.lockPathFor("azure-mcp", "proj", { platform: "linux", userInfo: () => ({ uid: 1001 }) });
    assert.notEqual(a, b);
});

test("lockPathFor: a per-user pipe name on win32", () => {
    const p = cache.lockPathFor("azure-mcp", "proj", { platform: "win32", userInfo: () => ({ username: "dev" }) });
    assert.match(p, /^\\\\\.\\pipe\\/);
    assert.ok(p.includes("dev"), "pipe names are machine-global, so the user must be in the name");
    assert.ok(p.includes("proj"), "the project axis must reach the name, or two projects share one mutex");
    const other = cache.lockPathFor("azure-mcp", "other-proj",
        { platform: "win32", userInfo: () => ({ username: "dev" }) });
    assert.notEqual(p, other, "two different scopes must not collide on win32");
});

test("lockPathFor: two users do not collide on win32", () => {
    const a = cache.lockPathFor("azure-mcp", "proj", { platform: "win32", userInfo: () => ({ username: "ann" }) });
    const b = cache.lockPathFor("azure-mcp", "proj", { platform: "win32", userInfo: () => ({ username: "bob" }) });
    assert.notEqual(a, b);
});

test("lockPathFor: a filesystem path on darwin, outside the secrets directory", () => {
    // The source additionally asserted the path excluded the substring "mcpw/secrets", justified
    // by that repository's own permissions.deny patterns matching that substring — a rule that
    // lives in a repository this package does not ship to, so that half of the check is not
    // carried over verbatim. The INVARIANT behind it is not void, though: this package has its
    // own secretsDir() (vc-secrets.mjs), where the gpg-encrypted blobs actually live, and a lock
    // file must not fall inside it.
    const p = cache.lockPathFor("azure-mcp", "proj", { platform: "darwin", userInfo: () => ({ uid: 1000 }) });
    assert.equal(p[0], "/");
    // Above the length bound deliberately: a relocation into a deep secrets directory trips the
    // byte count first, and that assertion carries no diagnosis. Order decides which of the two
    // gets to explain the failure.
    assert.ok(!p.startsWith(m.secretsDir()), `the lock must not fall inside the secrets directory: ${p}`);
    assert.ok(Buffer.byteLength(p) <= 100, `sun_path is ~104 bytes on darwin; this is ${Buffer.byteLength(p)}: ${p}`);
    assert.ok(p.includes("proj"), "the project axis must reach the name, or two projects share one mutex");
    const other = cache.lockPathFor("azure-mcp", "other-proj",
        { platform: "darwin", userInfo: () => ({ uid: 1000 }) });
    assert.notEqual(p, other, "two different scopes must not collide on darwin");
});

test("lockPathFor: two servers do not share one lock", () => {
    // The positive control for the per-user tests: a path built from the user alone would pass
    // all of them while serialising every server in the config against every other.
    const userInfo = () => ({ uid: 1000, username: "dev" });
    for (const platform of ["linux", "win32", "darwin"]) {
        assert.notEqual(cache.lockPathFor("azure-mcp", "proj", { platform, userInfo }),
            cache.lockPathFor("azure-monitor", "proj", { platform, userInfo }), `${platform} must key the lock by server`);
    }
});

test("lockPathFor: a separator in the user or server name cannot reshape the lock", () => {
    // A Windows domain login is DOMAIN\user, and a backslash left in it nests the pipe name
    // rather than naming one lock; on darwin a slash walks the lock out of /tmp entirely, and
    // the directory it lands in decides who may hold it.
    const win = cache.lockPathFor("azure-mcp", "proj", { platform: "win32", userInfo: () => ({ username: "CONTOSO\\dev" }) });
    assert.equal(win.slice("\\\\.\\pipe\\".length).includes("\\"), false,
        `a domain login must not nest the pipe name: ${win}`);
    const mac = cache.lockPathFor("../../escape", "proj", { platform: "darwin", userInfo: () => ({ uid: 1000 }) });
    assert.equal(mac.slice("/tmp/".length).includes("/"), false,
        `a lock must stay in the directory it was given: ${mac}`);
});

test("lockPathFor: the owner comes from the OS, so the environment cannot name someone else's lock", () => {
    // Both namespaces are machine-global, and USER/USERNAME are set by whoever starts the process.
    // Reading them made the lock name a claim rather than an identity: on a shared host an account
    // could name its lock after another user and hold that user's launches out to the ceiling.
    const spoofed = { USER: "victim", USERNAME: "victim" };
    const posix = cache.lockPathFor("azure-mcp", "proj", { platform: "linux", env: spoofed, userInfo: () => ({ uid: 1000 }) });
    assert.ok(posix.includes("1000"), `the uid decides the name: ${posix}`);
    assert.equal(posix.includes("victim"), false, "the environment must not reach the lock name");
    const win = cache.lockPathFor("azure-mcp", "proj",
        { platform: "win32", env: spoofed, userInfo: () => ({ username: "real" }) });
    assert.ok(win.includes("real") && !win.includes("victim"), `win32 reads the OS too: ${win}`);
});

test("lockPathFor: a uid with no passwd entry falls back to the environment rather than failing", () => {
    // os.userInfo() throws where the uid has no passwd entry — a container, a stripped image. A
    // launcher must not die there, so the environment stays as a last resort; the cost is that two
    // such accounts can share a name, wait out the ceiling and fail, which is why it is last.
    const p = cache.lockPathFor("azure-mcp", "proj", { platform: "linux", env: { USER: "dev" },
        userInfo: () => { throw Object.assign(new Error("no passwd entry"), { code: "ENOENT" }); } });
    assert.ok(p.includes("dev"), `the environment is the fallback, not the default: ${p}`);
});

test("two projects declaring the same entry name do not share one mutex", () => {
    // The source namespaces the lock by USER because both namespaces are machine-global. A
    // project is a second axis with the same property, and nothing in the source says so — it
    // never had two.
    const a = cache.lockPathFor("ado", "p1", { platform: "linux", userInfo: () => ({ uid: 1000 }) });
    const b = cache.lockPathFor("ado", "p2", { platform: "linux", userInfo: () => ({ uid: 1000 }) });
    assert.notEqual(a, b);
    assert.match(a, /^\0vc-secrets-1000-p1-ado\.lock$/);
});

// The socket tests below never execute where binding is refused, and a skipped test is not
// evidence. These drive the same decisions through the injection seam, so every branch —
// including the two macOS-only ones nobody here can reach — is settled by an assertion.
const inUse = () => Object.assign(new Error("bind: address already in use"), { code: "EADDRINUSE" });
const fakeServer = () => ({ close: (done) => done() });

test("acquireLock: a free name yields a holder that can release", async () => {
    const got = await cache.acquireLock("\0free", { bind: async () => fakeServer() });
    assert.notEqual(got, cache.HELD_BY_OTHER);
    await got.release();
});

test("acquireLock: an occupied abstract name or pipe means a live holder, with no reclaim", async () => {
    // The kernel frees both namespaces when the holder dies, so occupied cannot mean stale —
    // and probing or removing here is what would resurrect the two-holder race.
    for (const name of ["\0vc-secrets-dev-proj-azure-mcp.lock", "\\\\.\\pipe\\vc-secrets-dev-proj-azure-mcp-lock"]) {
        const calls = [];
        const got = await cache.acquireLock(name, {
            bind: async () => { throw inUse(); },
            probe: async () => { calls.push("probe"); return false; },
            remove: () => calls.push("remove"),
        });
        assert.equal(got, cache.HELD_BY_OTHER, name);
        assert.deepEqual(calls, [], `${name} must not be probed or unlinked`);
    }
});

test("acquireLock: an error that is not EADDRINUSE is raised, not read as contention", async () => {
    // EPERM or EACCES reported as "someone else holds it" would make the launcher wait out the
    // whole timeout and then blame a neighbour for a permission problem.
    await assert.rejects(() => cache.acquireLock("\0denied", {
        bind: async () => { throw Object.assign(new Error("listen EPERM"), { code: "EPERM" }); },
    }), /EPERM/);
});

test("acquireLock: on a path, a live holder is not evicted", async () => {
    const calls = [];
    const got = await cache.acquireLock("/tmp/vc-secrets-dev-proj-azure-mcp.lock", {
        bind: async () => { throw inUse(); },
        probe: async () => true,
        remove: () => calls.push("remove"),
    });
    assert.equal(got, cache.HELD_BY_OTHER);
    assert.deepEqual(calls, [], "unlinking a live holder's socket is the two-holder race");
});

test("acquireLock: on a path, a socket a killed holder left behind is reclaimed", async () => {
    let bound = 0;
    const removed = [];
    const got = await cache.acquireLock("/tmp/vc-secrets-dev-proj-azure-mcp.lock", {
        bind: async () => { if (bound++ === 0) { throw inUse(); } return fakeServer(); },
        probe: async () => false,
        remove: (p) => removed.push(p),
    });
    assert.notEqual(got, cache.HELD_BY_OTHER);
    assert.deepEqual(removed, ["/tmp/vc-secrets-dev-proj-azure-mcp.lock"]);
    assert.equal(bound, 2, "the reclaim must actually re-bind, not just unlink");
});

test("acquireLock: losing the reclaim race waits, it does not kill the launch", async () => {
    // The branch a previous draft got wrong. An EADDRINUSE on the RE-bind is an ordinary
    // contended outcome; escaping the try makes it an unhandled rejection, which the launcher's
    // run path turns into process.exit — so the server never starts at all.
    const got = await cache.acquireLock("/tmp/vc-secrets-dev-proj-azure-mcp.lock", {
        bind: async () => { throw inUse(); },
        probe: async () => false,
        remove: () => {},
    });
    assert.equal(got, cache.HELD_BY_OTHER);
});

test("acquireLock: HELD_BY_OTHER cannot be mistaken for an absent lock", async () => {
    // A null or undefined sentinel would let a call site write `if (!lock)` and proceed to
    // exchange concurrently with the holder — the precise thing the lock exists to stop.
    const got = await cache.acquireLock("\0busy", { bind: async () => { throw inUse(); } });
    assert.ok(got, "the sentinel must be truthy");
    assert.equal(typeof cache.HELD_BY_OTHER, "symbol");
});

test("LOCK_WAIT_MS outlasts the holder's whole critical section, not just its exchange", () => {
    // The holder cannot release before both keystore entries are written — releasing earlier
    // hands the waiter a refresh token Entra has already rotated away. So the waiter has to
    // cover the exchange AND both writes; covering only the exchange abandons a neighbour who
    // was two slow keystore calls from publishing. The three constants live in three modules
    // and nothing but this line relates them.
    assert.ok(cache.LOCK_WAIT_MS > oauth.TIMEOUT_OAUTH_MS + 2 * m.TIMEOUT_LOCAL_MS,
        `LOCK_WAIT_MS=${cache.LOCK_WAIT_MS} must exceed ${oauth.TIMEOUT_OAUTH_MS} + 2 * ${m.TIMEOUT_LOCAL_MS}`);
});

test("the margin covers the tick, the exchange, the skew allowance and a worst-case call",
    { todo: true }, () => {
    // Four terms live in three modules and nothing else connects them. Cannot be written yet:
    // RENEWAL_TICK_MS arrives with Task 20. Then the relation is
    //   MARGIN_MS >= RENEWAL_TICK_MS + TIMEOUT_OAUTH_MS + SKEW_ALLOWANCE + WORST_CALL
    });

// acquireLock binds a UNIX socket (abstract on linux, a filesystem path on darwin) — a different
// privilege from socketTest's loopback TCP probe above. Measured on this sandbox: TCP loopback
// bind is permitted, both an abstract AND a filesystem unix-socket bind are EPERM. So reusing
// socketTest here would answer "can bind" and every test below would then fail EPERM, reading as
// a regression rather than a sandbox restriction — a probe of the wrong privilege answers
// confidently either way. This exact defect has already been fixed once in this file, in the
// OTHER direction: socketTest's own probe was adapted FROM a unix-domain-socket probe TO a TCP
// one, because at the time this file had no lock-file tests to gate at all. This commit adds
// them, with their own probe of the privilege they actually use.
let lockBindProbe = null;
function canBindLocks() {
    lockBindProbe ??= new Promise((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.once("listening", () => probe.close(() => resolve(true)));
        probe.listen(cache.lockPathFor("selftest-" + process.pid, "proj",
            { platform: process.platform, env: process.env }));
    });

    return lockBindProbe;
}

// Unlike socketTest, a skip here is NOT a signal that the probe is broken — it is the expected
// outcome in the Claude Code sandbox, where a unix-domain-socket bind IS refused (EPERM). All
// four lockTest cases skip there, and a green in-sandbox run proves less than it looks like:
// measured, a mutation where release() never closes the server is fully green in-sandbox and
// only dies when the suite runs outside it.
const lockTest = (name, fn) => test(name, async (t) => {
    if (!(await canBindLocks())) {
        t.skip("needs an environment that permits a unix-domain-socket bind");

        return;
    }
    await fn(t);
});

// The module URL every spawned-process test below imports by dynamic `import()` — computed once
// from this test file's own URL, so it resolves regardless of the process's working directory.
const cacheModuleUrl = new URL("./vc-secrets-cache.mjs", import.meta.url).href;

lockTest("acquireLock: a second acquisition while held reports the holder, not null", async () => {
    const p = cache.lockPathFor("t1-" + process.pid, "proj", { platform: process.platform, env: process.env });
    const first = await cache.acquireLock(p);
    assert.notEqual(first, cache.HELD_BY_OTHER);
    assert.equal(await cache.acquireLock(p), cache.HELD_BY_OTHER);
    await first.release();
});

lockTest("acquireLock: succeeds again after release", async () => {
    const p = cache.lockPathFor("t2-" + process.pid, "proj", { platform: process.platform, env: process.env });
    const first = await cache.acquireLock(p);
    await first.release();
    const second = await cache.acquireLock(p);
    assert.notEqual(second, cache.HELD_BY_OTHER);
    await second.release();
});

lockTest("acquireLock: a holder killed without releasing does not block the next launch", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-lock-"));
    tmpDirs.push(dir);
    const script = path.join(dir, "holder.mjs");
    const name = "t3-" + process.pid;
    fs.writeFileSync(script, `
        import(${JSON.stringify(cacheModuleUrl)}).then((c) => {
            c.acquireLock(c.lockPathFor(${JSON.stringify(name)}, "proj", { platform: process.platform, env: process.env }))
                .then(() => { process.stdout.write("held\\n"); setInterval(() => {}, 1000); });
        });
    `);
    const holder = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((r) => holder.stdout.once("data", r));   // it holds the lock now
    holder.kill("SIGKILL");
    await new Promise((r) => holder.once("exit", r));
    const got = await cache.acquireLock(cache.lockPathFor(name, "proj", { platform: process.platform, env: process.env }));
    assert.notEqual(got, cache.HELD_BY_OTHER, "a killed holder must not lock the machine out");
    await got.release();
});

lockTest("acquireLock: exactly one of two racing processes holds it", async () => {
    // The single-process cases above cannot see the race that matters: two launchers arriving
    // at the same lock at the same moment. Two real processes can.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-secrets-lock-"));
    tmpDirs.push(dir);
    const script = path.join(dir, "racer.mjs");
    const name = "t4-" + process.pid;
    fs.writeFileSync(script, `
        import(${JSON.stringify(cacheModuleUrl)}).then((c) => {
            c.acquireLock(c.lockPathFor(${JSON.stringify(name)}, "proj", { platform: process.platform, env: process.env }))
                .then((r) => { process.stdout.write(r === c.HELD_BY_OTHER ? "lost" : "won");
                               setTimeout(() => process.exit(0), 400); })
                .catch((e) => { process.stdout.write("threw:" + e.code); process.exit(1); });
        });
    `);
    const run = () => new Promise((resolve) => {
        const p = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        p.stdout.on("data", (d) => { out += d; });
        p.once("exit", () => resolve(out));
    });
    const outcomes = await Promise.all([run(), run()]);
    assert.equal(outcomes.filter((x) => x === "won").length, 1, `exactly one winner, got ${outcomes}`);
    assert.equal(outcomes.filter((x) => x === "lost").length, 1, `exactly one loser, got ${outcomes}`);
});
