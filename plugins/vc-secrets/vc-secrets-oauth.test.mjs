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
//
// "Nothing imports this module yet" is no longer why these five stay unported: cmdLogin now calls
// buildAuthorizeUrl and createPkcePair to build the code grant's authorize request, and
// buildTokenBody with kind: "code" for the exchange -- which drives "the challenge itself
// travels", "client_id, redirect_uri and state", and "the code grant carries no refresh token"
// end to end through a real caller. What keeps these five here rather than deleted is that they
// pin the FIELD-LEVEL contract a caller's happy path does not exercise on its own: cmdLogin's own
// tests assert that a login succeeds, not that a dropped `code_challenge` or a leaked
// refresh_token on the code grant would be caught before it reached Entra. The other two -- the
// refresh grant's token and the client_id/scope shared by both grants -- are exercised by
// oauthLaunchDeps's renewal path instead.

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
    // The callback layer IS ported: listenForCallback (vc-secrets.mjs:1665) and handleCallback
    // (vc-secrets.mjs:1769) exist, and handleCallback compares the returned `state` against
    // `expectedState` at vc-secrets.mjs:1800 -- the consumer that would notice a missing `state`
    // is real now. This test still earns its place regardless: it pins the builder's OWN contract
    // independently of that consumer, the same way the other field-level tests in this block do.
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
    // ensureFreshToken (vc-secrets.mjs:1556) is the production caller, so this is live, not latent.
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
    // this: ensureFreshToken treats an absent entry as "sign in", and the `login` verb overwrites it.
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

// ---------------------------------------------------------------------------------------------
// ensureFreshToken / acquireTokenLock / oauthLaunchDeps / tokenLockFor — Task 13's port of the
// launcher's single locked read→exchange→write refresh path. Ported from the upstream launcher
// (mcpw.js) and its suite: `m.McpwError` becomes `m.VcSecretsError`, and "mcpw"/"mcpw login" in
// every user-facing string becomes "vc-secrets"/"vc-secrets login". tokenLockFor and
// oauthLaunchDeps take a `decl`/`cfg` pair the source never needed, because this package's
// keystore keys are three-segment ("vc-secrets:<scope>:<name>") and carry a project scope the
// source's bare entry names never had — see the comments on tokenLockFor and oauthLaunchDeps
// themselves for why the scope key has to agree with keyFor's.
// ---------------------------------------------------------------------------------------------

const DEPS = (over = {}) => ({
    serverName: "azure-mcp",
    readCache: async () => ({ state: "valid", accessToken: "cached" }),
    writeCache: async () => {},
    exchange: async () => ({ accessToken: "fresh", refreshToken: "r2" }),
    acquireLock: async () => ({ release: async () => {} }),
    now: () => 1_000,
    sleep: async () => {},
    ...over,
});

test("ensureFreshToken: a valid cached token is used without contacting Entra", async () => {
    let exchanged = 0;
    const t = await m.ensureFreshToken(DEPS({ exchange: async () => { exchanged++; } }));
    assert.equal(t, "cached");
    assert.equal(exchanged, 0);
});

test("ensureFreshToken: inside the margin it exchanges once, under the lock, and persists", async () => {
    const order = [];
    await m.ensureFreshToken(DEPS({
        readCache: async () => ({ state: "needs-refresh", refreshToken: "r1" }),
        acquireLock: async () => { order.push("lock"); return { release: async () => { order.push("release"); } }; },
        exchange: async () => { order.push("exchange"); return { accessToken: "fresh", refreshToken: "r2" }; },
        writeCache: async () => order.push("write"),
    }));
    assert.deepEqual(order, ["lock", "exchange", "write", "release"]);
});

test("ensureFreshToken: the loser of the race uses the winner's token, never exchanges", async () => {
    let exchanged = 0, polls = 0;
    const t = await m.ensureFreshToken(DEPS({
        readCache: async () => (++polls < 3 ? { state: "needs-refresh", refreshToken: "r1" }
                                            : { state: "valid", accessToken: "neighbours" }),
        acquireLock: async () => cache.HELD_BY_OTHER,
        exchange: async () => { exchanged++; },
    }));
    assert.equal(t, "neighbours");
    assert.equal(exchanged, 0, "two exchanges would rotate the refresh token twice");
});

test("ensureFreshToken: waiting on a neighbour that never finishes names the neighbour", async () => {
    let elapsed = 0;
    await assert.rejects(() => m.ensureFreshToken(DEPS({
        readCache: async () => ({ state: "needs-refresh", refreshToken: "r1" }),
        acquireLock: async () => cache.HELD_BY_OTHER,
        sleep: async (ms) => { elapsed += ms; },
        now: () => 1_000 + elapsed,
    })), (e) => /another vc-secrets/i.test(e.message) && !/vc-secrets login/.test(e.message));
    assert.ok(elapsed >= cache.LOCK_WAIT_MS, `must wait the full deadline, waited ${elapsed}`);
});

test("ensureFreshToken: the lock is released even when the exchange throws", async () => {
    let released = 0;
    await assert.rejects(() => m.ensureFreshToken(DEPS({
        readCache: async () => ({ state: "needs-refresh", refreshToken: "r1" }),
        acquireLock: async () => ({ release: async () => { released++; } }),
        exchange: async () => { throw new Error("network down"); },
    })));
    assert.equal(released, 1, "a leaked lock blocks every other session on this machine, permanently");
});

test("ensureFreshToken: absent cache fails naming the login verb, and never exchanges", async () => {
    let exchanged = 0;
    await assert.rejects(() => m.ensureFreshToken(DEPS({
        readCache: async () => ({ state: "absent" }),
        exchange: async () => { exchanged++; },
    })), /vc-secrets login azure-mcp/);
    assert.equal(exchanged, 0);
});

test("ensureFreshToken: an identity mismatch is treated as absent, not as a refreshable cache", async () => {
    let exchanged = 0;
    await assert.rejects(() => m.ensureFreshToken(DEPS({
        readCache: async () => ({ state: "identity-mismatch" }),
        exchange: async () => { exchanged++; },
    })), /vc-secrets login azure-mcp/);
    assert.equal(exchanged, 0);
});

test("ensureFreshToken: a REFUSED exchange names the login verb; an unreachable endpoint does not", async () => {
    // The two are not the same failure. A refusal means the refresh token is dead and signing in
    // again is the remedy; a timeout means the network is down and telling the developer to sign
    // in sends them to a browser that cannot help either.
    const refused = Object.assign(new m.VcSecretsError("token endpoint refused the request: invalid_grant"), { refused: true });
    await assert.rejects(() => m.ensureFreshToken(DEPS({
        readCache: async () => ({ state: "needs-refresh", refreshToken: "r1" }),
        exchange: async () => { throw refused; },
    })), (e) => /invalid_grant/.test(e.message) && /vc-secrets login azure-mcp/.test(e.message));

    await assert.rejects(() => m.ensureFreshToken(DEPS({
        readCache: async () => ({ state: "needs-refresh", refreshToken: "r1" }),
        exchange: async () => { throw new m.VcSecretsError("token endpoint unreachable: ENETUNREACH"); },
    })), (e) => /ENETUNREACH/.test(e.message) && !/vc-secrets login/.test(e.message));
});

test("ensureFreshToken: a cache that stops being refreshable while we wait for the lock is not exchanged", async () => {
    // A logout landing between the two reads. Trusting the first verdict hands `undefined` to
    // the exchange, and Entra's answer to that names nothing the developer can act on.
    //
    // The exchange stub returns a real-shaped token rather than undefined: if the guard right
    // below (`again.state !== "needs-refresh"`) is ever removed, exchange still succeeds and
    // ensureFreshToken RESOLVES instead of throwing, so assert.rejects fails on its own terms (no
    // rejection happened) instead of on an incidental "Cannot read properties of undefined
    // (reading 'accessToken')" TypeError that names nothing about the guard actually missing.
    let exchanged = 0, reads = 0;
    await assert.rejects(() => m.ensureFreshToken(DEPS({
        readCache: async () => (++reads === 1 ? { state: "needs-refresh", refreshToken: "r1" } : { state: "absent" }),
        exchange: async () => { exchanged++; return { accessToken: "must-not-be-used", refreshToken: "must-not-be-used" }; },
    })), /vc-secrets login azure-mcp/);
    assert.equal(exchanged, 0);
    assert.equal(reads, 2, "the re-read under the lock is what makes this decidable");
});

test("ensureFreshToken: a neighbour that released WITHOUT publishing is overtaken, not waited out", async () => {
    // The winner's access-entry write is best-effort by design, and its exchange can fail
    // outright — so "the lock is free again" and "a valid token appeared" are different events.
    // Waiting only on the cache burns the whole 45 s deadline and then blames a neighbour that
    // released seconds after taking it, for a token this launcher could have exchanged itself.
    let held = true, exchanged = 0, elapsed = 0;
    const t = await m.ensureFreshToken(DEPS({
        // The clock advances even though nothing sleeps for real: with a frozen clock an
        // implementation that never breaks out of the wait spins forever, and a hanging test
        // reports as neither pass nor fail.
        sleep: async (ms) => { elapsed += ms; },
        now: () => 1_000 + elapsed,
        readCache: async () => ({ state: "needs-refresh", refreshToken: "r1" }),
        acquireLock: async () => {
            if (held) {
                held = false;   // the neighbour releases after our first look

                return cache.HELD_BY_OTHER;
            }

            return { release: async () => {} };
        },
        exchange: async () => { exchanged++; return { accessToken: "ours", refreshToken: "r2" }; },
    }));
    assert.equal(t, "ours");
    assert.equal(exchanged, 1);
});

test("ensureFreshToken: the contended poll backs off instead of hammering the backend", async () => {
    // On Credential Manager every readCache is a PowerShell P/Invoke worth one to three seconds,
    // so a flat 250 ms poll is really "start powershell.exe as fast as it will start" for 45 s.
    const waits = [];
    let elapsed = 0;
    await assert.rejects(() => m.ensureFreshToken(DEPS({
        readCache: async () => ({ state: "needs-refresh", refreshToken: "r1" }),
        acquireLock: async () => cache.HELD_BY_OTHER,
        sleep: async (ms) => { waits.push(ms); elapsed += ms; },
        now: () => 1_000 + elapsed,
    })), /another vc-secrets/i);
    assert.deepEqual(waits.slice(0, 4), [250, 500, 1000, 2000], `got ${waits.slice(0, 4)}`);
    assert.ok(waits.every((ms) => ms <= 2000), "the ceiling is what keeps a long wait cheap");
    assert.ok(elapsed >= cache.LOCK_WAIT_MS, `the deadline must still be reached, waited ${elapsed}`);
});

// The keystore side of the launch path. ensureFreshToken's own tests inject every seam, so
// without these the code that actually reads and writes the cache entries has no coverage at
// all — and both of its interesting cases are silent when wrong.
//
// LAUNCH_DECL carries scope: "project" and LAUNCH_CFG a projectId, which the source's bare
// LAUNCH_DECL/entryName never needed: oauthEntryKeys resolves the keystore key from decl.scope
// and cfg.projectId (see keyFor, vc-secrets.mjs:648), and a decl with no scope would produce a
// key with the literal segment "undefined" long before any of these tests reached the assertion
// they are named for.
const LAUNCH_DECL = { ...DECL_IDENTITY, scope: "project" };
const LAUNCH_CFG = { projectId: "launch-p1" };
const LAUNCH_KEYS = m.oauthEntryKeys("azure-mcp", LAUNCH_DECL, LAUNCH_CFG);
const refreshBlob = () => cache.serializeRefresh({ refreshToken: "r1", ...DECL_IDENTITY });
const accessBlob = (over = {}) => cache.serializeAccess({ accessToken: "a1", expiresAt: 9e15,
    obtainedAt: Date.now(), lifetimeMs: 3600_000, uptimeAtIssue: os.uptime(), ...over });

function keychainMiss() {
    return Object.assign(new Error("security: item not found"), { toolExitCode: 44 });
}

test("oauthLaunchDeps.readCache: a missing refresh entry answers absent without reading the access entry", async () => {
    // The fail-fast path has a latency budget on it, and on Credential Manager every read is a
    // PowerShell P/Invoke worth one to three seconds. Reading the second entry to learn nothing
    // is what puts that budget out of reach.
    const asked = [];
    const deps = m.oauthLaunchDeps("azure-mcp", LAUNCH_DECL, LAUNCH_CFG, { backend: "keychain",
        run: (spec) => { asked.push(spec.args.at(-2)); throw keychainMiss(); } });
    assert.deepEqual(await deps.readCache(), { state: "absent" });
    assert.equal(asked.length, 1, `one read, asked for ${asked}`);
});

test("oauthLaunchDeps.readCache: needs-refresh carries the refresh token the exchange will spend", async () => {
    const deps = m.oauthLaunchDeps("azure-mcp", LAUNCH_DECL, LAUNCH_CFG, { backend: "keychain",
        run: (spec) => (spec.args.at(-2).endsWith("-refresh") ? refreshBlob() : Promise.reject(keychainMiss())) });
    const status = await deps.readCache();
    assert.equal(status.state, "needs-refresh", "no access entry → the launcher must exchange");
    assert.equal(status.refreshToken, "r1", "cacheStatus returns a state only; without this the exchange gets undefined");
});

test("oauthLaunchDeps.readCache: a valid access entry is reported valid and carries no refresh token", async () => {
    const deps = m.oauthLaunchDeps("azure-mcp", LAUNCH_DECL, LAUNCH_CFG, { backend: "keychain",
        run: (spec) => (spec.args.at(-2).endsWith("-refresh") ? refreshBlob() : accessBlob()) });
    const status = await deps.readCache();
    assert.equal(status.state, "valid");
    assert.equal(status.accessToken, "a1");
});

test("oauthLaunchDeps.writeCache: a renewal that issues no new refresh token leaves the stored one alone", async () => {
    // RFC 6749 section 6 makes refresh_token optional on the refresh grant. Writing the entry
    // anyway serialises `undefined` over a LIVE refresh token, and the next launch then demands
    // a sign-in that nothing had invalidated — a session lost to a renewal that SUCCEEDED.
    //
    // ADAPTED assertion: the source asserted the bare entry name ["oauth-azure-mcp-access"].
    // `write` here receives the full three-segment keystore key oauthEntryKeys produces (Part
    // B3 — never a bare entry name), so the value that must appear is LAUNCH_KEYS.access.
    const written = [];
    const deps = m.oauthLaunchDeps("azure-mcp", LAUNCH_DECL, LAUNCH_CFG, { backend: "keychain",
        write: async (key) => { written.push(key); } });
    await deps.writeCache({ accessToken: "a2", expiresAt: 9e15, obtainedAt: 1, lifetimeMs: 3600_000, uptimeAtIssue: 1 });
    assert.deepEqual(written, [LAUNCH_KEYS.access]);
});

test("oauthLaunchDeps.writeCache: a refresh token that cannot be stored names the entry and the remedy", async () => {
    // The one irreversible step: Entra killed the previous refresh token when it issued this one,
    // so a failure here IS a signed-out state, and reporting the tool's own words would name a
    // keystore problem instead of the sign-in that fixes it.
    const deps = m.oauthLaunchDeps("azure-mcp", LAUNCH_DECL, LAUNCH_CFG, { backend: "keychain",
        write: async () => { throw new Error("security: SecKeychainItemCreateFromContent failed"); } });
    await assert.rejects(() => deps.writeCache({ accessToken: "a2", refreshToken: "r2",
        expiresAt: 9e15, obtainedAt: 1, lifetimeMs: 3600_000, uptimeAtIssue: 1 }),
        (e) => e instanceof m.VcSecretsError && /oauth-azure-mcp-refresh/.test(e.message)
            && /vc-secrets login azure-mcp/.test(e.message));
});

test("oauthLaunchDeps.writeCache: forwards env to both the refresh and the access write", async () => {
    // Measured hazard (gpg, a custom XDG_CONFIG_HOME): readEntry resolves paths through
    // keyToPath(key, env) using the CALLER's env, but writeCache's two write(...) calls omitted
    // env, so writeSecretValue fell back to process.env. Reads and writes then land in two
    // different homes, readCache never sees what writeCache just wrote, and EVERY launch
    // re-exchanges -- rotating the refresh token a second time on top of the rotation Entra
    // already did the moment it issued the one just stored. Unreachable today (no production
    // caller passes a custom env yet), so this test is what keeps the fix from regressing back.
    const seenEnvs = [];
    const customEnv = { USER: "u", XDG_CONFIG_HOME: "/custom/home" };
    const deps = m.oauthLaunchDeps("azure-mcp", LAUNCH_DECL, LAUNCH_CFG, { backend: "keychain", env: customEnv,
        write: async (key, value, opts) => { seenEnvs.push(opts && opts.env); } });
    await deps.writeCache({ accessToken: "a2", refreshToken: "r2", expiresAt: 9e15,
        obtainedAt: 1, lifetimeMs: 3600_000, uptimeAtIssue: 1 });
    assert.equal(seenEnvs.length, 2, `expected one write for the refresh entry and one for the access entry, got ${seenEnvs.length}`);
    assert.ok(seenEnvs.every((e) => e === customEnv),
        `both writes must forward the caller's env, not fall back to process.env: got ${JSON.stringify(seenEnvs)}`);
});

test("oauthLaunchDeps.writeCache: a failed ACCESS write is a warning, not a lost renewal", async (t) => {
    // Asymmetric on purpose: losing the access entry costs one exchange next launch, so failing
    // the renewal over it would throw away a refresh token that was just successfully rotated.
    //
    // The warning is the ONLY signal that the write failed -- deleting the fs.writeSync(2, ...)
    // line leaves this test green otherwise, since not-throwing is not evidence the warning
    // fired. Captured here by mocking fs.writeSync itself (what the production code actually
    // calls, on fd 2), since this path runs in-process rather than through a spawned CLI whose
    // stderr a subprocess capture could read instead.
    const stderr = [];
    t.mock.method(fs, "writeSync", (fd, str) => {
        if (fd !== 2) {
            throw new Error(`unexpected fs.writeSync(${fd}, ...) in this test`);
        }
        stderr.push(str);

        return Buffer.byteLength(str);
    });
    const deps = m.oauthLaunchDeps("azure-mcp", LAUNCH_DECL, LAUNCH_CFG, { backend: "keychain",
        write: async (name) => { if (name.endsWith("-access")) { throw new Error("full"); } } });
    await deps.writeCache({ accessToken: "a2", refreshToken: "r2", expiresAt: 9e15,
        obtainedAt: 1, lifetimeMs: 3600_000, uptimeAtIssue: 1 });
    assert.equal(stderr.length, 1, `expected exactly one stderr warning, got ${stderr.length}`);
    assert.match(stderr[0], /the access entry could not be stored \(full\); the next launch will exchange one/);
});

// ---------------------------------------------------------------------------------------------
// New coverage this task adds (not a port): acquireTokenLock had no DIRECT test in the source —
// every source case drove it through cmdLogin/cmdLogout, which are Tasks 14/15 and do not exist
// here yet. Without these three, acquireTokenLock ships with zero coverage of its own.
// ---------------------------------------------------------------------------------------------

test("acquireTokenLock: a clean acquisition returns the lock, without waiting or logging", async () => {
    const logged = [];
    const result = await m.acquireTokenLock({
        acquireLock: async () => ({ release: async () => {} }),
        now: () => 0,
        sleep: async () => { throw new Error("must not sleep: nothing is contended"); },
        log: (line) => logged.push(line),
    });
    assert.ok(result.lock, "a free lock must come back as the holder, not a reason");
    assert.equal(result.reason, undefined);
    assert.deepEqual(logged, [], "a clean acquisition has nothing to wait out and nothing to announce");
});

test("acquireTokenLock: a holder that never clears is reported busy, bounded by the poll cap", async () => {
    // Mirrors the source's frozen-clock regression (mcpw.test.js:2356): with now() frozen the
    // deadline never advances, and only MAX_LOCK_POLLS stops the loop from spinning forever.
    // Verified here directly rather than through cmdLogin: acquireTokenLock is exported and
    // callable on its own, so no vehicle was ever needed -- driving it through cmdLogin would pin
    // the verb's wiring rather than this loop.
    let polls = 0;
    const result = await m.acquireTokenLock({
        acquireLock: async () => cache.HELD_BY_OTHER,
        now: () => 0,
        sleep: async () => { polls += 1; },
        log: () => {},
    });
    assert.deepEqual(result, { lock: null, reason: "busy" });
    assert.ok(polls > 0 && polls <= 64, `the wait must end by the poll cap, not the clock: ${polls}`);
});

test("acquireTokenLock: an error that is not a refused bind is not laundered into one", async () => {
    // The carve-out covers ONE measured condition. An unfiltered catch turned a broken wiring and
    // an fd exhaustion into "the sandbox refused the bind" — acquireTokenLock decides nothing
    // about a failure to get the lock, so this must reach the caller unchanged, never come back as
    // {lock: null, reason: "unbindable"}.
    const boom = Object.assign(new Error("too many open files"), { code: "EMFILE" });
    await assert.rejects(() => m.acquireTokenLock({
        acquireLock: async () => { throw boom; },
        now: () => 0,
        sleep: async () => {},
        log: () => {},
    }), (e) => e === boom);
});

// ---------------------------------------------------------------------------------------------
// Review fix round: acquireTokenLock's OWN wait was completely unpinned. Measured by the
// reviewer: lowering MAX_LOCK_POLLS from 64 to 1 left the whole suite green. Root cause: every
// test above drives a FROZEN clock or a small, controlled number of attempts, so none of them
// can tell "the deadline ended the wait" apart from "the poll cap ended the wait". The first two
// tests below close that gap, driving an ADVANCING clock; the other two pin the classification and
// the log line, for which a frozen clock is the right instrument. All four drive acquireTokenLock
// DIRECTLY — no vehicle needed, it is exported and callable on its own.
// ---------------------------------------------------------------------------------------------

test("acquireTokenLock: the poll cap is a backstop, not the terminator of the wait", async () => {
    // Under an advancing clock the LOCK_WAIT_MS deadline must be what ends the wait; the poll cap
    // must never fire first. Must go red when MAX_LOCK_POLLS is lowered enough to end the loop
    // before the deadline is reached (measured: 64 -> 1 does this).
    let elapsed = 0;
    const result = await m.acquireTokenLock({
        acquireLock: async () => cache.HELD_BY_OTHER,
        now: () => 1_000 + elapsed,
        sleep: async (ms) => { elapsed += ms; },
        log: () => {},
    });
    assert.deepEqual(result, { lock: null, reason: "busy" });
    assert.ok(elapsed >= cache.LOCK_WAIT_MS,
        `the deadline must be what ends the wait, not the poll cap: waited only ${elapsed}, need >= ${cache.LOCK_WAIT_MS}`);
});

test("acquireTokenLock: seed, doubling and ceiling of its own wait", async () => {
    // Declared locally rather than imported, same discipline as the source's own pinned-copy
    // test: the point is to pin the numbers this loop actually PRODUCES, not to track whatever
    // the module constant currently says. Driven directly (not through ensureFreshToken, which
    // has its own, separate loop with its own pinned test a few tests up) -- a change to
    // acquireTokenLock's seed/ceiling alone must redden only this test, not the other loop's.
    const LOCK_POLL_SEED = 250;
    const LOCK_POLL_CEILING = 2_000;
    const slept = [];
    let elapsed = 0;
    const result = await m.acquireTokenLock({
        acquireLock: async () => cache.HELD_BY_OTHER,
        now: () => 1_000 + elapsed,
        sleep: async (ms) => { slept.push(ms); elapsed += ms; },
        log: () => {},
    });
    assert.deepEqual(result, { lock: null, reason: "busy" });
    assert.deepEqual(slept.slice(0, 4), [LOCK_POLL_SEED, LOCK_POLL_SEED * 2, LOCK_POLL_SEED * 4, LOCK_POLL_CEILING],
        `backoff seed, doubling, ceiling: got ${slept.slice(0, 4)}`);
    assert.ok(slept.every((ms) => ms <= LOCK_POLL_CEILING), "the ceiling must hold for the whole wait");
    assert.ok(elapsed >= cache.LOCK_WAIT_MS && elapsed < cache.LOCK_WAIT_MS + LOCK_POLL_CEILING,
        `the wait ended at ${elapsed}, outside [${cache.LOCK_WAIT_MS}, ${cache.LOCK_WAIT_MS + LOCK_POLL_CEILING})`);
});

test("acquireTokenLock: sawHolder survives a later unbindable attempt -- still busy, not unbindable", async () => {
    // Once HELD_BY_OTHER has been seen, a LATER bind failure (EPERM/EACCES) must still classify
    // as "busy", not "unbindable" -- the diagnosis is "another session is refreshing", not "the
    // sandbox refused the bind". Must go red when `|| sawHolder` is dropped from classify.
    let calls = 0;
    const eperm = Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
    const result = await m.acquireTokenLock({
        acquireLock: async () => {
            calls += 1;
            if (calls === 1) {
                return cache.HELD_BY_OTHER;
            }
            throw eperm;
        },
        now: () => 0,
        sleep: async () => {},
        log: () => {},
    });
    assert.deepEqual(result, { lock: null, reason: "busy" },
        `a holder seen once must keep classifying a later unbindable attempt as busy, got ${JSON.stringify(result)}`);
    assert.ok(calls >= 2, `the second, unbindable attempt must actually run: only ${calls} call(s)`);
});

test("acquireTokenLock: a contended bind announces itself through the log seam", async () => {
    let calls = 0;
    const logged = [];
    const result = await m.acquireTokenLock({
        acquireLock: async () => {
            calls += 1;

            return calls === 1 ? cache.HELD_BY_OTHER : { release: async () => {} };
        },
        now: () => 0,
        sleep: async () => {},
        log: (line) => logged.push(line),
    });
    assert.ok(result.lock, "the lock must be granted once the holder clears");
    assert.ok(logged.some((l) => /waiting for an in-flight token renewal/.test(l)),
        `the wait must announce itself through the log seam: got ${JSON.stringify(logged)}`);
});

test("ensureFreshToken: the contended wait's backoff and ceiling bound the deadline it enforces", async () => {
    // Behavioural in place of a source-text match. The plan for this test was
    // `assert.match(m.ensureFreshToken.toString(), /LOCK_WAIT_MS/)` — a comment containing the
    // name satisfies that just as well as the real reference does, and it stays green with the
    // constant deleted from the loop. This instead DRIVES the loop and pins the numbers it must
    // actually produce: the backoff seed, the doubling, the ceiling, and the window the deadline
    // falls in — the same shape as the source's own pinned-copy test (mcpw.test.js:2934), driven
    // through ensureFreshToken instead of cmdLogout because cmdLogout does not exist here yet.
    const LOCK_POLL_SEED = 250;
    const LOCK_POLL_CEILING = 2_000;
    const slept = [];
    let ms = 0;
    await assert.rejects(() => m.ensureFreshToken({
        serverName: "azure-mcp",
        readCache: async () => ({ state: "needs-refresh", refreshToken: "r1" }),
        writeCache: async () => {},
        exchange: async () => { throw new Error("must not exchange: the neighbour never releases"); },
        acquireLock: async () => cache.HELD_BY_OTHER,
        now: () => ms,
        sleep: async (d) => { slept.push(d); ms += d; },
    }), /still refreshing/);
    assert.deepEqual(slept.slice(0, 4), [LOCK_POLL_SEED, LOCK_POLL_SEED * 2, LOCK_POLL_SEED * 4, LOCK_POLL_CEILING],
        "backoff seed, doubling, ceiling");
    assert.ok(slept.every((d) => d <= LOCK_POLL_CEILING), "the ceiling holds for the whole wait");
    // The boundary, not a tally: it must outlast the ceiling, and overshoot by at most one poll.
    assert.ok(ms >= cache.LOCK_WAIT_MS && ms < cache.LOCK_WAIT_MS + LOCK_POLL_CEILING,
        `the wait ended at ${ms}, outside [${cache.LOCK_WAIT_MS}, ${cache.LOCK_WAIT_MS + LOCK_POLL_CEILING})`);
});

lockTest("tokenLockFor: project scope keys the lock exactly the way keyFor keys the keystore entry", async () => {
    // tokenLockFor has no return value carrying the scope key it computed, and cache.acquireLock/
    // cache.lockPathFor are read-only ES module exports — this file cannot substitute them the way
    // the source's CJS test does (mcpw.test.js:2894, `c.acquireLock = ...`). Proven instead by
    // PRE-occupying the exact path keyFor's own rule predicts (decl.scope === USER_SCOPE ?
    // USER_SCOPE : cfg.projectId — vc-secrets.mjs:648) and observing tokenLockFor collide with it:
    // if tokenLockFor computed its scope key some other way, this would either fail to collide (the
    // pre-occupied path is not the one it binds) or collide with the WRONG project below.
    const decl = { scope: "project" };
    const entryName = "predict-entry-" + process.pid;
    const cfgA = { projectId: "predict-a-" + process.pid };
    const cfgB = { projectId: "predict-b-" + process.pid };
    const pathFor = (cfg) => cache.lockPathFor(entryName, cfg.projectId,
        { platform: process.platform, env: process.env });

    const holderA = await cache.acquireLock(pathFor(cfgA));
    // Released defensively (not just on the happy path): under a WRONG scope key, either got*
    // comes back as a real, live-listening lock instead of HELD_BY_OTHER, and an un-released
    // listener keeps the process alive long after the assertion has already failed — the test
    // then reports correctly but the run never exits on its own.
    let gotA = null, gotB = null;
    try {
        gotA = await m.tokenLockFor(entryName, decl, cfgA)();
        assert.equal(gotA, cache.HELD_BY_OTHER,
            "the same projectId must collide on the path keyFor's own rule predicts");

        gotB = await m.tokenLockFor(entryName, decl, cfgB)();
        assert.notEqual(gotB, cache.HELD_BY_OTHER,
            "a different projectId must not collide with project A's lock");
    } finally {
        if (gotA && gotA !== cache.HELD_BY_OTHER) { await gotA.release(); }
        if (gotB && gotB !== cache.HELD_BY_OTHER) { await gotB.release(); }
        await holderA.release();
    }
});

lockTest("tokenLockFor: user scope keys the lock on USER_SCOPE, ignoring cfg.projectId", async () => {
    const decl = { scope: "user" };
    const entryName = "predict-entry-user-" + process.pid;
    const predictedUserPath = cache.lockPathFor(entryName, "user",
        { platform: process.platform, env: process.env });

    const holder = await cache.acquireLock(predictedUserPath);
    // Collected and released defensively, same reason as the project-scope test above: a WRONG
    // scope key gives back a real, live-listening lock instead of HELD_BY_OTHER, and leaving it
    // unreleased keeps the process alive after the assertion has already failed.
    const got = [];
    try {
        // Two configs that disagree about projectId: at user scope keyFor ignores cfg.projectId
        // entirely, so both must still collide with the SAME pre-occupied "user" path, or a
        // renewal running under one project's config would fail to serialise against one running
        // under another's for the very same personal token.
        for (const cfg of [{ projectId: "predict-a-" + process.pid }, { projectId: "predict-b-" + process.pid }]) {
            const lock = await m.tokenLockFor(entryName, decl, cfg)();
            got.push(lock);
            assert.equal(lock, cache.HELD_BY_OTHER,
                `a user-scope entry must lock on "user" regardless of cfg.projectId=${cfg.projectId}`);
        }
    } finally {
        for (const lock of got) {
            if (lock && lock !== cache.HELD_BY_OTHER) { await lock.release(); }
        }
        await holder.release();
    }
});

// ---------------------------------------------------------------------------------------------
// Review fix round: the restored keychain line-length refusal (buildLocalWrite's `security -i`
// stdinCommand branch) and its EAGER check in writeSecretValue, before any process is spawned.
// security(1) reads that command line into a fixed buffer and, past the limit, SPLITS rather
// than refusing: the first half stores a TRUNCATED value and the tail runs as a second command.
// ---------------------------------------------------------------------------------------------

test("buildLocalWrite(keychain).stdinCommand: composes up to the line limit, refuses one byte past it", () => {
    // The limit mirrors SECURITY_LINE_LIMIT in vc-secrets.mjs — declared with the stdin-composition
    // constants near COMMAND_ON_STDIN, not next to the buildLocalWrite branch that enforces it
    // (not exported, so restated here -- same discipline as the lock tests' locally-declared
    // backoff constants above: pin the value the guard actually enforces, not a re-export of it).
    //
    // The boundary is DERIVED, not hardcoded: the composed overhead (the account, the key, and
    // the fixed "add-generic-password ..." text) is measured here from the real builder with a
    // short known-length filler, so a change to the key shape (e.g. a longer project id) moves
    // the boundary this test pins right along with it, instead of silently under- or over-testing.
    const SECURITY_LINE_LIMIT = 4095;
    const env = { USER: "u" };
    const key = "vc-secrets:demo-project:oauth-azure-mcp-refresh";
    const spec = m.buildLocalWrite("keychain", key, env, { value: "x" });

    // A filler value whose every byte is plain ASCII (no quote/backslash to escape) contributes
    // exactly its own length to the composed line; everything else is the fixed overhead.
    const probeLen = 16;
    const overhead = Buffer.byteLength(spec.stdinCommand("x".repeat(probeLen))) - probeLen;
    const maxValueLen = SECURITY_LINE_LIMIT - overhead;

    const atLimit = spec.stdinCommand("x".repeat(maxValueLen));
    assert.equal(Buffer.byteLength(atLimit), SECURITY_LINE_LIMIT,
        `the largest composing value must land exactly on the limit, got ${Buffer.byteLength(atLimit)} bytes`);

    assert.throws(() => spec.stdinCommand("x".repeat(maxValueLen + 1)), (e) => {
        assert.ok(e instanceof m.VcSecretsError, `expected a VcSecretsError, got ${e}`);
        assert.ok(e.message.includes(key), `must name the entry: ${e.message}`);
        assert.ok(e.message.includes(String(SECURITY_LINE_LIMIT + 1)), `must carry the composed byte count: ${e.message}`);
        assert.ok(e.message.includes(String(SECURITY_LINE_LIMIT)), `must carry the limit: ${e.message}`);

        return true;
    });
});

test("writeSecretValue: an oversize keychain value is refused before the runner is ever reached", async () => {
    // The refusal itself is pinned by the test above; what this pins is that it happens EARLY. The
    // runner composes spec.stdinCommand only AFTER it has spawned, so without writeSecretValue's own
    // validating call an oversize value leaves an orphaned `security -i` waiting on a stdin that
    // never arrives, until the runner's timeout kills it.
    //
    // Asserted through the INJECTED runner rather than by watching for a real process: a spawn can
    // only be observed after it has already happened, so "no marker file yet" is a race that reports
    // success most of the time while the child ran every time. The fake runner mimics the real one --
    // record the call, and only then compose -- so deleting the early call fails THIS assertion
    // rather than the rejection, which the downstream guard would satisfy either way.
    const runnerCalls = [];
    const run = async (spec, { stdinValue } = {}) => {
        runnerCalls.push(spec);
        if (spec.stdinCommand) {
            spec.stdinCommand(stdinValue);
        }
    };
    const key = "vc-secrets:demo-project:oauth-azure-mcp-refresh";
    const oversized = "x".repeat(5000);   // past the limit regardless of the composed overhead
    await assert.rejects(
        () => m.writeSecretValue(key, oversized, { backend: "keychain", env: { USER: "u" }, run }),
        (e) => e instanceof m.VcSecretsError && /too large for the keychain/.test(e.message));
    assert.equal(runnerCalls.length, 0, "the runner must never be reached once the guard has refused");
});

// ---------------------------------------------------------------------------------------------
// Task 14a: the callback surface -- the loopback listener, handleCallback, the two HTML pages,
// and the browser opener. Ported from the launcher's own suite (source ranges resolved 2026-09-11).
// ---------------------------------------------------------------------------------------------

// Every byte this tool prints has to survive the console it is printed to. `doctor` writes its report
// with `fs.writeSync(2, …)` — raw bytes, deliberately, because a synchronous unbuffered write is what
// survives an immediate exit — and that bypasses the tty stream node would otherwise use to transcode
// for the active Windows code page. Measured: on a Russian-locale console an em dash arrived as `тАФ`,
// which is mojibake in the one place a diagnostic must be legible. So the messages are ASCII, and the
// transport keeps the property it was chosen for.
const NON_ASCII = /[^\x00-\x7f]/;

test("mapResolveError and forTerminal: their messages are ASCII too", () => {
    const cases = [
        m.mapResolveError("wcm", "n", Object.assign(new Error("x"), { toolExitCode: 3 })),
        m.mapResolveError("keychain", "n", Object.assign(new Error("x"), { toolExitCode: 44 })),
        m.mapResolveError("gpg", "n", Object.assign(new Error("decryption failed"), { toolExitCode: 2 })),
    ];
    for (const e of cases) {
        assert.ok(!NON_ASCII.test(e.message), `non-ASCII in a mapped error: ${JSON.stringify(e.message)}`);
    }
    // The truncation marker counts: it is appended to text that goes to the same console.
    assert.ok(!NON_ASCII.test(m.forTerminal("x".repeat(50), 10)), "the truncation marker must be ASCII");
});

// The opener probe is injected rather than left to the real PATH. With a real `commandOnPath` the
// linux case asserts whatever this machine happens to have installed: it passes here because
// wslview and powershell.exe are absent, and would fail on a WSL box that has wslview — an
// environment-dependent test that reports the machine, not the code.
const onPath = (...present) => (tool) => present.includes(tool);

test("buildBrowserCommand: one command per platform", () => {
    assert.deepEqual(m.buildBrowserCommand("linux", {}, "http://x/", onPath("xdg-open")),
        { cmd: "xdg-open", args: ["http://x/"] });
    assert.deepEqual(m.buildBrowserCommand("darwin", {}, "http://x/", onPath()),
        { cmd: "open", args: ["http://x/"] });
    assert.equal(m.buildBrowserCommand("win32", {}, "http://x/", onPath()).cmd, "cmd");
});

test("buildBrowserCommand: on WSL the interop opener is preferred over xdg-open", () => {
    // xdg-open inside WSL opens a Linux browser that may not exist, or nothing at all; wslview
    // and powershell.exe hand the URL to the Windows default browser, which is where the
    // developer is actually signed in.
    assert.equal(m.buildBrowserCommand("linux", {}, "http://x/", onPath("wslview", "xdg-open")).cmd, "wslview");
    assert.equal(m.buildBrowserCommand("linux", {}, "http://x/", onPath("powershell.exe", "xdg-open")).cmd,
        "powershell.exe");
});

test("buildBrowserCommand: no opener at all is a supported path, not a failure", () => {
    // Measured on one of our machines: no /mnt/c, no cmd.exe on PATH. cmdLogin prints the URL
    // and keeps waiting on the listener, so sign-in still completes by hand.
    assert.equal(m.buildBrowserCommand("linux", { VC_SECRETS_WSL_NO_INTEROP: "1" }, "http://x/",
        onPath("wslview", "xdg-open")), null, "the override must win over anything on PATH");
    assert.equal(m.buildBrowserCommand("linux", {}, "http://x/", onPath()), null);
});

test("buildBrowserCommand: a URL carrying & or | survives to the browser on every platform", () => {
    // The property, stated per platform, because it is not the same property. On linux and darwin the
    // URL is its own argv element and nothing re-parses it. On win32 that is NOT enough and the
    // previous version of this test asserted it anyway: cmd.exe re-parses everything after /c, so the
    // element boundary the assertion checked is invisible to it and the URL truncated at the first &.
    // Green test, broken launch, measured only when a real sign-in reached a real Windows browser.
    const nasty = "http://127.0.0.1:1/?code=a&b=c|whoami";
    for (const platform of ["linux", "darwin"]) {
        const built = m.buildBrowserCommand(platform, {}, nasty, onPath("xdg-open"));
        assert.ok(built.args.includes(nasty), `${platform} must pass the URL as one argument`);
    }
    const win = m.buildBrowserCommand("win32", {}, nasty, onPath());
    assert.deepEqual(win.args, [`/c start "" "${nasty}"`], "one verbatim line, with the URL quoted");
    assert.equal(win.opts.windowsVerbatimArguments, true,
        "without this node re-quotes the line and the quotes stop protecting anything");
    assert.match(win.args[0], /\?code=a&b=c\|whoami"$/, "everything after the & must still be there");
});

test("buildBrowserCommand: a URL containing a double quote is refused, not quoted anyway", () => {
    // The win32 form embeds the URL in a quoted string, so a quote inside it would end that string
    // early and hand the rest to cmd.exe as syntax. Cannot happen from outside today — guids,
    // base64url and configured scopes — so this keeps it that way rather than trusting it stays.
    assert.throws(() => m.buildBrowserCommand("win32", {}, 'http://127.0.0.1:1/?a="&calc', onPath()),
        m.VcSecretsError);
});

test("openBrowser: the spawn options the builder asked for actually reach spawn", async () => {
    // The other half of the same defect: the win32 spec carries windowsVerbatimArguments and the
    // inline default dropped spec.opts, so the builder was right and the launch was not. A spec field
    // nothing reads is worse than no field at all.
    let seen = null;
    const spec = { cmd: "cmd", args: ['/c start "" "http://x/?a=1&b=2"'], opts: { windowsVerbatimArguments: true } };
    m.openBrowser(spec, { spawnProcess: (cmd, args, opts) => {
        seen = { cmd, args, opts };

        return { unref() {}, on() {} };
    } });
    assert.equal(seen.opts.windowsVerbatimArguments, true);
    assert.equal(seen.opts.detached, true, "and the defaults it does not override are still there");
    assert.deepEqual(seen.args, spec.args);
});

test("openBrowser: a missing opener is reported, not thrown", () => {
    // spawn fails ASYNCHRONOUSLY, so by the time `error` arrives the caller's try/catch is gone and an
    // unhandled one would end the sign-in on a stack trace -- with the listener already waiting and
    // the URL already printable. A degradation must read as one.
    const logged = [];
    let emit = null;
    m.openBrowser({ cmd: "xdg-open", args: ["http://x/"] }, {
        log: (line) => logged.push(line),
        spawnProcess: () => ({ unref() {}, on(event, fn) { if (event === "error") { emit = fn; } } }),
    });
    assert.ok(emit, "openBrowser must subscribe to the child's error");
    emit(Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }));
    assert.match(logged.join(""), /could not open a browser \(ENOENT\)/);
    assert.match(logged.join(""), /by hand/, "and must say what the developer can still do");
});

const GET = (url) => ({ url, method: "GET" });

test("handleCallback: a mismatched state decides nothing, and says so", () => {
    // It used to END the sign-in with "state_mismatch". Anything that can reach this port can send
    // that, so the abort was available to anybody and the message named a cause the developer did not
    // have. Ignored now -- and reported, so that an error Entra sends without echoing state is still
    // visible rather than a silent wait.
    const r = m.handleCallback(GET("/callback?code=abc&state=WRONG"), "RIGHT", "/callback");
    assert.equal(r.ignore, true);
    assert.match(r.notice, /state that is not this sign-in/);
    assert.equal(r.code, undefined, "and the code is not carried forward");
    assert.equal(r.error, undefined, "nor turned into a failure the caller would report");
});

test("handleCallback: the matching state yields the code", () => {
    assert.deepEqual(m.handleCallback(GET("/callback?code=abc&state=RIGHT"), "RIGHT", "/callback"),
        { code: "abc" });
});

test("handleCallback: an Entra error carries its AADSTS code into the result", () => {
    // Entra redirects here when the user is not in the assigned group or declines. Without this
    // the best `login` can say is "no code received", and the AADSTS string a developer can
    // actually act on never reaches them.
    const r = m.handleCallback(
        GET("/callback?error=access_denied&error_description=AADSTS50105%3A+not+assigned&state=RIGHT"),
        "RIGHT", "/callback");
    assert.match(r.error, /access_denied/);
    assert.match(r.description, /AADSTS50105/);
    assert.equal(r.code, undefined);
});

test("handleCallback: an error beats the code, but only once the state matches", () => {
    // Both halves of a reversed decision. The goal of the old order is kept: with a matching state an
    // error is reported before the code is looked at, so a developer reads their AADSTS code and not a
    // generic "no code received". What the old order also permitted is gone: an error whose state does
    // not match no longer ends anything, because that abort was available to any local process.
    const real = m.handleCallback(
        GET("/callback?error=access_denied&error_description=AADSTS50105&code=abc&state=RIGHT"),
        "RIGHT", "/callback");
    assert.match(real.error, /access_denied/);
    assert.match(real.description, /AADSTS50105/);

    const forged = m.handleCallback(
        GET("/callback?error=access_denied&error_description=AADSTS50105&state=WRONG"), "RIGHT", "/callback");
    assert.equal(forged.ignore, true);
    assert.equal(forged.error, undefined);
});

test("handleCallback: a request to another path is ignored, not treated as a failed sign-in", () => {
    // A browser fetching /favicon.ico for the "you can close this tab" page must not abort a
    // sign-in that is about to succeed.
    assert.equal(m.handleCallback(GET("/favicon.ico"), "RIGHT", "/callback").ignore, true);
    // What the path check actually decides, and the reason the line above does not pin it: a
    // NON-callback path carrying ANY of code, error or state. /favicon.ico is turned away by the
    // stray-request branch below whatever the path check does, so deleting the check left the whole
    // suite green. One of the three parameters is enough to disarm that branch; with a matching
    // state and a code, as here, the code is accepted from a path Entra never redirected to.
    assert.equal(m.handleCallback(GET("/evil?code=abc&state=RIGHT"), "RIGHT", "/callback").ignore, true);
});

test("handleCallback: a stray request on the callback path is ignored, not read as an attack", () => {
    // The callback moved to "/" to match the registered bare `http://localhost`, so the path no
    // longer filters anything out. A port scanner, or a browser asking for the root, would reach
    // the state check and end the wait with "state_mismatch" — aborting a sign-in that was about
    // to succeed, and telling the developer they are under attack. Under WSL the loopback relay
    // makes the port reachable from Windows, so this is not hypothetical.
    assert.equal(m.handleCallback(GET("/"), "RIGHT", "/").ignore, true);
    assert.equal(m.handleCallback(GET("/?probe=1"), "RIGHT", "/").ignore, true);
    // The "not read as an attack" half of the title, which nothing asserted: the verdict is the same
    // with the branch removed, because the state check also ignores. What changes is the DIAGNOSIS --
    // every browser request for "/" then prints the notice below, which names a state that is not
    // this sign-in's. Deleting the branch left the suite green; this is the line that reddens.
    assert.equal(m.handleCallback(GET("/"), "RIGHT", "/").notice, undefined,
        "a browser asking for the root is not something to warn the developer about");
    // A request that claims to be a callback but carries someone else's state is ignored WITH a
    // notice -- it neither ends the sign-in nor disappears.
    const wrongState = m.handleCallback(GET("/?code=abc&state=WRONG"), "RIGHT", "/");
    assert.equal(wrongState.ignore, true);
    assert.ok(wrongState.notice, "and it must not be silent");
    // And the real redirect still gets through on the root path — the case no other test covers,
    // because every one of them passes the old "/callback".
    assert.deepEqual(m.handleCallback(GET("/?code=abc&state=RIGHT"), "RIGHT", "/"), { code: "abc" });
});

test("handleCallback: an error carries every other parameter Entra sent, except a code", () => {
    // Measured: `access_denied` arrived with no error_description at all, and reporting two fixed
    // fields threw away whatever Entra had sent instead. `code` is excluded rather than assumed
    // absent — it has no business on an error redirect, and echoing one into a page or a log is the
    // one thing this must never do.
    const r = m.handleCallback(
        GET("/?error=access_denied&error_subcode=cancel&trace_id=t-1&code=SECRET&state=RIGHT"),
        "RIGHT", "/");
    assert.equal(r.error, "access_denied");
    assert.deepEqual(r.extras, [["error_subcode", "cancel"], ["trace_id", "t-1"], ["state", "RIGHT"]]);
    assert.ok(!JSON.stringify(r).includes("SECRET"), "a code must not survive into the error verdict");
});

test("the tab title names which sign-in the tab belongs to", () => {
    // A machine can hold more than one: entries are named per organisation, so two projects can each
    // have a tab open, and "vc-secrets" on both is the one thing that cannot tell them apart.
    const title = (html) => /<title>([^<]*)<\/title>/.exec(html)[1];
    assert.equal(title(m.closeTabPage("ado-oauth-org")), "Signed in - ado-oauth-org");
    assert.equal(title(m.failedPage({ error: "access_denied", description: "", extras: [] }, "ado-oauth-org")),
        "Sign-in failed - ado-oauth-org");
    // Without a name it still says what happened rather than the tool's own name.
    assert.equal(title(m.closeTabPage()), "Signed in");
    assert.equal(title(m.failedPage({ error: "x", description: "", extras: [] })), "Sign-in failed");
    // And the failure title must not read as a success at a glance, which is where a tab title is read.
    assert.doesNotMatch(title(m.failedPage({ error: "x", description: "", extras: [] }, "org")), /signed in/i);
    // The name is escaped although it is validated `[a-z0-9-]+` at load, because the page must not
    // depend on a check made somewhere else -- and nothing asserted that until now: removing
    // escapeHtml from BOTH titles left the whole suite green, since every name above is one that
    // escaping does not change. Asserted on the raw HTML rather than through `title()`: its `[^<]*`
    // cannot span an unescaped bracket, so on a regression the match fails outright and the helper
    // throws a TypeError on `exec(...)[1]` -- a failure that names nothing about escaping.
    const hostile = "a<script>&\"x";
    assert.match(m.closeTabPage(hostile), /<title>Signed in - a&lt;script&gt;&amp;&quot;x<\/title>/);
    assert.match(m.failedPage({ error: "x", description: "", extras: [] }, hostile),
        /<title>Sign-in failed - a&lt;script&gt;&amp;&quot;x<\/title>/);
});

test("failedPage: renders the reason, and escapes it because the sender chose it", () => {
    // Anything that can reach the loopback port during a sign-in picks these values, so an
    // unescaped one would execute as script on this page's own origin.
    const html = m.failedPage({ error: "bad<x>", description: 'a "quoted" & odd one', extras: [["k", "<v>"]] });
    assert.ok(html.includes("bad&lt;x&gt;"), html);
    assert.ok(html.includes("&quot;quoted&quot;"), html);
    assert.ok(html.includes("&amp; odd"), html);
    assert.ok(html.includes("&lt;v&gt;"), html);
    assert.ok(!/<x>|<v>/.test(html), "no raw angle brackets from the query may reach the page");
});

test("forTerminal: a control byte from the redirect cannot reach the terminal as a command", () => {
    // The HTML sink escapes; this is the same sender with a different alphabet. CSI would move the
    // cursor and overwrite what is already on screen, OSC can reach the window title or the
    // clipboard — and unlike a bad tag, none of it is visible in the text that carried it.
    const nasty = `a\u001b[2Jb\u0007c\u009bd`;
    const safe = m.forTerminal(nasty);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(safe), `control bytes survived: ${JSON.stringify(safe)}`);
    assert.match(safe, /^a\?\[2Jb\?c\?d$/, "and the replacement itself must be ASCII");
});

test("forTerminal: an unbounded value is truncated", () => {
    assert.equal(m.forTerminal("x".repeat(1000), 10), "xxxxxxxxxx...");
    assert.equal(m.forTerminal("short", 10), "short");
});

test("handleCallback: the parameter list a redirect can carry is bounded", () => {
    // Whatever can reach this port can send thousands. Bounding it in the verdict means the page and
    // the terminal message inherit one limit instead of each needing its own.
    const many = Array.from({ length: 100 }, (unused, i) => `p${i}=v${i}`).join("&");
    const r = m.handleCallback(GET(`/?error=access_denied&state=RIGHT&${many}`), "RIGHT", "/");
    assert.equal(r.extras.length, m.MAX_ERROR_PARAMS);
});

test("failedPage: names the usual causes, because a bare access_denied is not actionable", () => {
    // The first cause is the measured one: opening the printed URL in a browser that carries no work
    // account returns a bare `access_denied`, and its own page asks for an account to be added to the
    // browser profile. That is the likely case precisely when the URL is printed, because the
    // developer then opens it somewhere other than their usual browser.
    const html = m.failedPage({ error: "access_denied", description: "", extras: [] });
    assert.match(html, /no work\s+account/i);
    assert.match(html, /declined consent/i);
    assert.match(html, /not assigned/i);
    assert.doesNotMatch(html, /signed in/i, "still must not read as a success at a glance");
});

test("handleCallback: a non-GET request is ignored", () => {
    assert.equal(m.handleCallback({ url: "/callback?code=abc&state=RIGHT", method: "POST" },
        "RIGHT", "/callback").ignore, true);
});

test("handleCallback: the right path with neither code nor error is an error, not a wait", () => {
    assert.equal(m.handleCallback(GET("/callback?state=RIGHT"), "RIGHT", "/callback").error, "no_code");
});

socketTest("listenForCallback: binds loopback only, so the code cannot arrive from the network", async () => {
    // The authorization code travels in this request. A listener on 0.0.0.0 would accept it from
    // anywhere routable, and nothing about the successful case would look different — which is
    // why the one-word change from 127.0.0.1 needs an assertion rather than only a comment.
    const server = await m.listenForCallback("STATE");
    try {
        const addresses = Object.values(os.networkInterfaces()).flat()
            .filter((i) => i.family === "IPv4" && !i.internal).map((i) => i.address);
        if (addresses.length === 0) {
            return;   // nothing routable to probe from; the negative below would prove nothing
        }
        const refused = await new Promise((resolve) => {
            const probe = net.connect({ host: addresses[0], port: server.port });
            probe.once("connect", () => { probe.destroy(); resolve(false); });
            probe.once("error", () => resolve(true));
        });
        assert.equal(refused, true, `the listener answered on ${addresses[0]}, not just loopback`);
    } finally {
        await server.close();
    }
});

socketTest("listenForCallback: a refused sign-in does not tell the browser it succeeded", async () => {
    // The browser is where the developer is looking. "Signed in." after Entra refused them sends
    // them away from the terminal holding the AADSTS code — defeating the error-before-state
    // ordering that exists precisely so that code reaches them.
    const server = await m.listenForCallback("STATE");
    try {
        const waiting = server.next();
        const res = await fetch(`http://127.0.0.1:${server.port}${m.REDIRECT_PATH}`
            + "?error=access_denied&error_description=AADSTS50105&state=STATE");
        assert.equal(res.status, 400);
        const body = await res.text();
        assert.match(body, /failed/i);
        assert.doesNotMatch(body, /signed in/i, "the page must not claim a sign-in that did not happen");
        assert.equal((await waiting).error, "access_denied");
    } finally {
        await server.close();
    }
});

socketTest("listenForCallback: a forged error is reported and waited past, not obeyed", async () => {
    // The wiring, not the verdict: handleCallback's decision is unit-tested above, and what this proves
    // is that an ignore-with-notice really keeps the listener waiting AND really reaches the developer.
    // Anything on this machine can send that request -- under WSL mirrored, anything on the Windows
    // side too -- so obeying it would hand every local process an abort button on someone's sign-in.
    const logged = [];
    const server = await m.listenForCallback("STATE", { log: (line) => logged.push(line) });
    try {
        const waiting = server.next();
        const forged = await fetch(`http://127.0.0.1:${server.port}${m.REDIRECT_PATH}?error=access_denied`);
        assert.equal(forged.status, 404, "a request that decides nothing must not be answered as a callback");
        assert.match(logged.join(""), /state that is not this sign-in/);
        // And the real one still lands, which is the half that proves the listener was never settled.
        const real = await fetch(`http://127.0.0.1:${server.port}${m.REDIRECT_PATH}?code=abc&state=STATE`);
        assert.equal(real.status, 200);
        assert.deepEqual(await waiting, { code: "abc" });
    } finally {
        await server.close();
    }
});

socketTest("listenForCallback: a stray request is answered and waited past, the callback ends the wait", async () => {
    // handleCallback's verdicts are unit-tested; what this proves is the WIRING — that an
    // `ignore` verdict really does keep the listener waiting rather than resolving with it. A
    // browser fetching /favicon.ico for the close-this-tab page would otherwise end the sign-in
    // with no code, and the failure would look like Entra never redirected.
    const server = await m.listenForCallback("STATE");
    try {
        const waiting = server.next();
        const stray = await fetch(`http://127.0.0.1:${server.port}/favicon.ico`);
        assert.equal(stray.status, 404);
        const settled = await Promise.race([waiting, new Promise((r) => setTimeout(() => r("still-waiting"), 50))]);
        assert.equal(settled, "still-waiting", "a 404 must not end the sign-in");

        const ok = await fetch(`http://127.0.0.1:${server.port}${m.REDIRECT_PATH}?code=abc&state=STATE`);
        assert.equal(ok.status, 200);
        assert.match(await ok.text(), /close this tab/i);
        assert.deepEqual(await waiting, { code: "abc" });
    } finally {
        await server.close();
    }
});

// ---------------------------------------------------------------------------------------------
// cmdLogin — Task 14b's port of the interactive sign-in verb. Ported from the upstream launcher's
// suite (mcpw.test.js): `m.McpwError` becomes `m.VcSecretsError`, and every "mcpw"/"mcpw login" in
// a user-facing string becomes "vc-secrets"/"vc-secrets login". `cache.entryNames(serverName)`
// becomes `oauthEntryKeys(serverName, decl, cfg)` — both return { refresh, access }, but the
// values here are the full three-segment keystore keys keyFor produces, not the source's bare
// entry names, so an assertion on a written/removed name reads it off LOGIN_KEYS below instead of
// a literal "oauth-azure-mcp-*" string.
//
// cmdLogin refuses a project-scope entry whose app registration the user file has not acknowledged,
// so every test below runs on an acknowledged one and LOGIN_CFG carries the block. It grants
// nothing: the verb's gate reads whether the registration is acknowledged at all, and WHICH
// launchable may then consume the token is resolveEnvEntries' decision, not this verb's — a block
// with contents would imply this fixture pins a relation it does not.
// ---------------------------------------------------------------------------------------------

// `kind: "oauth"` is what the merge stamps on every entry in the oauth section -- it is the
// discriminator authorizationFor branches on -- and `declaredName` names the key it was found
// under. A hand-built declaration omitting either is not one this package can ever see, and the
// two consumers of authorizationFor disagree about what its `null` means: cmdLogin reads `.block`
// off it and dies with a TypeError, while resolveEnvEntries (vc-secrets.mjs:726) tests
// `source !== null` and takes it as "needs no authorization". Fail-closed at one site and
// permissive at the other is the reason to match the merge rather than to guard the null.
const LOGIN_DECL = { ...DECL_IDENTITY, kind: "oauth", scope: "project", home: "project", declaredName: "azure-mcp" };
const LOGIN_CFG = { oauth: { "azure-mcp": LOGIN_DECL }, projectId: "login-p1",
    registrations: { [DECL_IDENTITY.tenantId]: { [DECL_IDENTITY.clientId]: {} } } };
const LOGIN_KEYS = m.oauthEntryKeys("azure-mcp", LOGIN_DECL, LOGIN_CFG);

// UNACKNOWLEDGED_CFG differs from LOGIN_CFG in exactly one property, so a test driven by it fails
// for the reason its name gives. USER_CFG differs in two -- the declaration's home AND the absent
// registrations block -- and has to: the whole claim is that the first makes the second irrelevant.
const UNACKNOWLEDGED_CFG = { ...LOGIN_CFG, registrations: {} };
const USER_DECL = { ...DECL_IDENTITY, kind: "oauth", scope: "user", home: "user", declaredName: "azure-mcp" };
const USER_CFG = { oauth: { "azure-mcp": USER_DECL }, projectId: "login-p1" };
const USER_KEYS = m.oauthEntryKeys("azure-mcp", USER_DECL, USER_CFG);

// cmdLogin's network, browser and listener are injected, which leaves its actual decisions —
// the order of the two writes above all — as ordinary assertions. This verb is ultimately proved
// by a live sign-in, and that run was blocked on an app registration for a while; the
// irreversible step inside it should not have to wait for an administrator to be covered.
function loginDeps(overrides = {}) {
    const written = [];
    const opened = [];
    const logged = [];
    const lock = [];
    const removed = [];
    const deps = {
        listen: async () => ({ port: 51234, next: async () => ({ code: "the-code" }), close: async () => {} }),
        open: (cmd) => { opened.push(cmd); },
        exchange: async () => ({ refreshToken: "new-rt", accessToken: "at", expiresAt: 3600_000,
            obtainedAt: 0, lifetimeMs: 3600_000, uptimeAtIssue: 1000 }),
        writeEntry: async (name, value) => { written.push([name, value]); },
        randomState: () => "STATE",
        log: (line) => { logged.push(line); },
        backend: "gpg",
        // Injected like every other seam here, and not left to the default: that one binds a REAL
        // machine-global socket, so every login test would serialise against every other and
        // against any other invocation of this tool running on this machine.
        acquireLock: async () => { lock.push("acquire"); return { release: async () => { lock.push("release"); } }; },
        // Same reason as acquireLock, and it was missed here once at a real cost: the default is
        // the REAL deleteEntryIo, so the refresh-write-failure test below cleared a developer's
        // live sign-in out of the actual keystore. From a GREEN run -- a delete that succeeds
        // looks like nothing at all. Measured 2026-08-20: both oauth entries for the affected
        // server were present before the run and gone after, with every other test still passing.
        removeEntry: async (name) => { removed.push(name); },
        ...overrides,
    };

    return { deps, written, opened, logged, lock, removed };
}

// Depth-aware rather than line-anchored: the first version of this matched only a seam standing
// alone at an indent of exactly four, so a new seam sharing a line with another was dropped
// silently, and the guard passed covering nothing for the very case it exists for.
function seamsOf(source) {
    const block = source.slice(source.indexOf("{", source.indexOf("cfg,")) + 1, source.indexOf("} = {}) {"));
    const parts = [];
    let depth = 0;
    let current = "";
    for (const ch of block) {
        if ("([{".includes(ch)) { depth += 1; }
        if (")]}".includes(ch)) { depth -= 1; }
        if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
        current += ch;
    }
    parts.push(current);

    // The name, whether or not a default follows it. Requiring the `=` was the same hole in a
    // second costume: a seam added WITHOUT a default vanished from the list, so the deepEqual below
    // passed and the one production call site -- main, which calls cmdLogin(arg, cfg) with no deps
    // object at all -- would hand it `undefined`. Line comments are stripped first because they
    // would otherwise shadow the name on the part that follows them.
    return parts.map((part) => (/^\s*(\w+)/.exec(part.replace(/\/\/.*$/gm, "")) ?? [])[1]).filter(Boolean);
}

function cmdLoginSeams() {
    return seamsOf(m.cmdLogin.toString());
}

// Presence of the KEY is not injection: `Object.keys({a: undefined})` is `["a"]`, and a
// destructuring default fires on undefined, so `loginDeps({ removeEntry: undefined })` would hand
// back the real deleter with the guard green. The source's own instance of that idiom rides a test
// this package has not ported, so nothing below demonstrates it -- which is exactly why the guard
// has to state the rule rather than lean on an example.
function definedSeams(deps) {
    // `null` counts as absent alongside `undefined`: both acquireLock and removeEntry default to
    // null in the parameter list and resolve their real implementation with `??` in the body, so a
    // seam handed in as null falls through to the machine-global socket or the real deleter exactly
    // as an omitted one does. Filtering on undefined alone would bless that shape.
    return Object.entries(deps).filter(([, value]) => value !== undefined && value !== null).map(([key]) => key);
}

test("cmdLogin: a hostile parameter reaches the terminal message declawed", async () => {
    const { deps } = loginDeps({
        listen: async () => ({ port: 1, next: async () => ({
            error: "access_denied", description: "", extras: [["subcode", `x\u001b[2Jy`]],
        }), close: async () => {} }),
    });
    await assert.rejects(() => m.cmdLogin("azure-mcp", LOGIN_CFG, deps), (e) => {
        assert.ok(!/[\u0000-\u001f]/.test(e.message), `raw control byte in: ${JSON.stringify(e.message)}`);
        assert.match(e.message, /subcode=x\?\[2Jy/);

        return true;
    });
});

test("loginDeps: every cmdLogin seam that reaches outside this process is injected", () => {
    const seams = cmdLoginSeams();
    // A parser that quietly finds nothing would make this test pass forever. Pin the whole list,
    // so adding a seam fails here and forces a decision about whether it needs injecting.
    assert.deepEqual(seams, ["listen", "open", "browser", "exchange", "writeEntry", "removeEntry",
        "randomState", "log", "backend", "acquireLock", "now", "sleep"],
        "the seam list changed, or the parse broke — both need a human");
    // These three stay inside the process: a pure command builder, the clock, and a timer.
    const mayDefault = ["browser", "now", "sleep"];
    const injected = definedSeams(loginDeps().deps);
    assert.deepEqual(seams.filter((s) => !mayDefault.includes(s) && !injected.includes(s)), [],
        "each of these would fall through to a real implementation in every login test");
});

test("loginDeps: a seam handed in as undefined counts as NOT injected", () => {
    // The hole the key-presence check had. cmdLogin's destructuring default fires on undefined, so
    // this must read as absent — otherwise the guard blesses exactly the shape that deleted a live
    // sign-in.
    assert.ok(!definedSeams(loginDeps({ removeEntry: undefined }).deps).includes("removeEntry"));
    assert.ok(definedSeams(loginDeps().deps).includes("removeEntry"));
});

test("loginDeps: a seam handed in as null counts as NOT injected, as the body's ?? reads it", () => {
    // acquireLock and removeEntry both default to null and resolve the real thing with `??`, so a
    // null is the one shape that looks handed-in to a key check and behaves like an omission: it
    // binds the machine-global socket, or calls the real deleter.
    assert.ok(!definedSeams(loginDeps({ acquireLock: null }).deps).includes("acquireLock"));
    assert.ok(definedSeams(loginDeps().deps).includes("acquireLock"));
});

test("seamsOf: a seam declared without a default is still a seam", () => {
    // The parser is guilty until shown otherwise, because it feeds the deepEqual above and a parser
    // that quietly finds fewer names makes that assertion pass while covering less. Requiring an
    // `=` dropped a defaultless seam entirely -- and defaultless is the dangerous kind, since main
    // calls cmdLogin with no deps object at all.
    assert.deepEqual(seamsOf("async function f(a, cfg, {\n    withDefault = 1,\n    bare,\n} = {}) {"),
        ["withDefault", "bare"]);
});

test("seamsOf: a seam sharing a line with another is not dropped, and a line comment shadows nothing", () => {
    // The depth-aware split exists for the first of these; the comment strip for the second. Both
    // are ways for a name to go missing without the list looking wrong.
    assert.deepEqual(seamsOf("async function f(a, cfg, {\n    one = 1, two = 2,\n} = {}) {"), ["one", "two"]);
    assert.deepEqual(seamsOf("async function f(a, cfg, {\n    // why three is defaulted\n    three = 3,\n} = {}) {"),
        ["three"]);
});

test("seamsOf: a default containing a comma does not split into two seams", () => {
    // The whole reason the split is depth-aware: writeEntry's default is an arrow taking two
    // parameters, and a naive split on "," would report `name` and `value` as seams of their own.
    assert.deepEqual(seamsOf("async function f(a, cfg, {\n    w = (name, value) => g(name, value),\n    x = [1, 2],\n} = {}) {"),
        ["w", "x"]);
});

test("cmdLogin: the refresh entry is written before the access entry", async () => {
    // Entra invalidates the old refresh token the moment it issues a new one, so persisting the
    // new one is the only irreversible step in the design. Writing the access entry first would
    // widen the window in which a crash leaves no way back in except an interactive login.
    const { deps, written } = loginDeps();
    await m.cmdLogin("azure-mcp", LOGIN_CFG, deps);
    assert.deepEqual(written.map(([name]) => name), [LOGIN_KEYS.refresh, LOGIN_KEYS.access]);
});

test("cmdLogin: the refresh entry carries the new refresh token under the declaration's identity", async () => {
    // The two names and their order were pinned; the CONTENTS were not. Every field here is one a
    // later read compares, so a refresh entry holding the access token, or the tenant and client
    // transposed, stores a session ensureFreshToken rejects on identity at the next launch --
    // sending the developer back to `login` with nothing naming why.
    const { deps, written } = loginDeps();
    await m.cmdLogin("azure-mcp", LOGIN_CFG, deps);
    assert.deepEqual(cache.parseEntry(written.find(([name]) => name === LOGIN_KEYS.refresh)[1]),
        { schema: 1, refreshToken: "new-rt", tenantId: LOGIN_DECL.tenantId,
            clientId: LOGIN_DECL.clientId, scopes: LOGIN_DECL.scopes });
});

test("cmdLogin: the access entry carries the token and the timing the exchange returned", async () => {
    // The same gap on the other write, and it fails differently: the three timing fields decide
    // when a renewal fires, so a transposition here is a session that renews at the wrong moment
    // rather than one that is refused outright.
    const { deps, written } = loginDeps();
    await m.cmdLogin("azure-mcp", LOGIN_CFG, deps);
    assert.deepEqual(cache.parseEntry(written.find(([name]) => name === LOGIN_KEYS.access)[1]),
        { schema: 1, accessToken: "at", expiresAt: 3600_000, obtainedAt: 0, lifetimeMs: 3600_000,
            uptimeAtIssue: 1000 });
});

test("cmdLogin: a failed refresh write is fatal, and the access entry is not written after it", async () => {
    // The access entry would then describe a session whose refresh token was never stored — a
    // login that works for an hour and cannot be renewed.
    const { deps, written } = loginDeps({
        writeEntry: async (name) => {
            if (name.endsWith("-refresh")) { throw new m.VcSecretsError("keystore full"); }
            written.push([name]);
        },
    });
    await assert.rejects(() => m.cmdLogin("azure-mcp", LOGIN_CFG, deps), /keystore full/);
    assert.deepEqual(written, [], "nothing may be written once the refresh write failed");
});

test("cmdLogin: a failed ACCESS write is not fatal — losing it costs one exchange", async () => {
    const { deps, logged } = loginDeps({
        writeEntry: async (name) => { if (name.endsWith("-access")) { throw new m.VcSecretsError("nope"); } },
    });
    await m.cmdLogin("azure-mcp", LOGIN_CFG, deps);
    assert.ok(logged.some((l) => /access/i.test(l)), `the degraded write must be reported: ${logged.join("")}`);
});

test("cmdLogin: the redirect_uri is the registered localhost URI, with the bound port and no path", async () => {
    // Three independent failure modes in one string, and none of them fails locally.
    //
    // The port must come from the listener, or Entra redirects the browser to a port nothing is
    // listening on and the sign-in hangs with no error. The host must be `localhost` and the path
    // must be absent, because Entra matches this string against the app registration — bare
    // `http://localhost` under Mobile and desktop applications — and ignores the port only for
    // that host. Either mismatch is AADSTS50011.
    //
    // So if a change to vc-secrets.mjs makes this fail, fix vc-secrets.mjs — do not update the
    // expectation. This string is not a mirror of the code; it is what an administrator configured
    // in Entra.
    let seenUri = null;
    const { deps } = loginDeps({
        listen: async () => ({ port: 45678, next: async () => ({ code: "c" }), close: async () => {} }),
        exchange: async (tenantId, body) => {
            seenUri = new URLSearchParams(body).get("redirect_uri");

            return { refreshToken: "rt", accessToken: "at", expiresAt: 1, obtainedAt: 0,
                lifetimeMs: 3600_000, uptimeAtIssue: 1 };
        },
    });
    await m.cmdLogin("azure-mcp", LOGIN_CFG, deps);
    assert.equal(seenUri, "http://localhost:45678/");
});

test("cmdLogin: a callback error aborts before any exchange and names the Entra code", async () => {
    let exchanged = false;
    const { deps } = loginDeps({
        listen: async () => ({ port: 1, close: async () => {},
            next: async () => ({ error: "access_denied", description: "AADSTS50105: not assigned" }) }),
        exchange: async () => { exchanged = true; return {}; },
    });
    await assert.rejects(() => m.cmdLogin("azure-mcp", LOGIN_CFG, deps), /AADSTS50105/);
    assert.equal(exchanged, false, "a refused sign-in must not reach the token endpoint");
});

test("cmdLogin: the listener is closed even when the sign-in fails", async () => {
    // An abandoned listener holds the port for the life of the process, so the next attempt
    // binds a different one — and on a failure path nobody is watching to notice.
    let closed = false;
    const { deps } = loginDeps({
        listen: async () => ({ port: 1, close: async () => { closed = true; },
            next: async () => ({ error: "state_mismatch" }) }),
    });
    await assert.rejects(() => m.cmdLogin("azure-mcp", LOGIN_CFG, deps));
    assert.equal(closed, true);
});

test("cmdLogin: with no browser opener the URL is printed and the sign-in still proceeds", async () => {
    const { deps, opened, logged, written } = loginDeps({ browser: () => null });
    await m.cmdLogin("azure-mcp", LOGIN_CFG, deps);
    assert.deepEqual(opened, [], "nothing to open");
    assert.ok(logged.some((l) => l.includes("https://login.microsoftonline.com/")),
        `the URL must reach the operator: ${logged.join("")}`);
    assert.equal(written.length, 2, "and the sign-in completes normally");
});

test("cmdLogin: the verifier never leaves the process, only its digest does", async () => {
    // PKCE is worthless if the verifier travels with the authorize request. The code grant is
    // the only place it may appear.
    let authorizeUrl = null;
    const { deps } = loginDeps({
        browser: (platform, env, url) => { authorizeUrl = url; return null; },
        exchange: async (tenantId, body) => {
            const verifier = new URLSearchParams(body).get("code_verifier");
            assert.ok(verifier, "the code grant must carry the verifier");
            assert.ok(!authorizeUrl.includes(verifier), "but the authorize URL must not");

            return { refreshToken: "rt", accessToken: "at", expiresAt: 1, obtainedAt: 0,
                lifetimeMs: 3600_000, uptimeAtIssue: 1 };
        },
    });
    await m.cmdLogin("azure-mcp", LOGIN_CFG, deps);
});

test("cmdLogin: macOS is a supported platform, not a refusal", async () => {
    // Every other verb already works there — detectLocalBackend returns keychain on darwin, the
    // read path is non-interactive, and the lock has its own darwin branch. login was briefly the
    // one feature that dropped the platform, which is a contradiction rather than a limitation.
    const { deps, written } = loginDeps({ backend: "keychain" });
    await m.cmdLogin("azure-mcp", LOGIN_CFG, deps);
    assert.deepEqual(written.map(([name]) => name), [LOGIN_KEYS.refresh, LOGIN_KEYS.access]);
});

test("cmdLogin: a backend with no keystore is refused before a code is spent", async () => {
    // The check that survives: whatever the reason, discovering it after the exchange leaves the
    // developer signed in with nothing stored and a single-use code already burned.
    let bound = false;
    const { deps } = loginDeps({
        backend: "nonesuch",
        listen: async () => { bound = true; return { port: 1, next: async () => ({ code: "c" }), close: async () => {} }; },
    });
    await assert.rejects(() => m.cmdLogin("azure-mcp", LOGIN_CFG, deps), /nonesuch/);
    assert.equal(bound, false, "nothing may be opened or bound when the token cannot be stored");
});

test("cmdLogin: a failed refresh write also clears the stale entries a previous login left", async () => {
    // Within one login the order already prevents access-without-refresh. The gap is ACROSS
    // invocations: Entra invalidated the old refresh token the moment it issued this one, so the
    // previous login's entries are now lies — the old access token keeps working until it
    // expires and then the session dies with nothing to renew from. Clearing both makes the
    // state unambiguously signed-out instead of quietly doomed.
    const removed = [];
    const { deps } = loginDeps({
        writeEntry: async (name) => { if (name.endsWith("-refresh")) { throw new m.VcSecretsError("keystore full"); } },
        removeEntry: async (n) => { removed.push(n); },
    });
    await assert.rejects(() => m.cmdLogin("azure-mcp", LOGIN_CFG, deps), /keystore full/);
    assert.deepEqual(removed.sort(), [LOGIN_KEYS.access, LOGIN_KEYS.refresh].sort());
});

test("cmdLogin: a cleanup failure does not replace the write error the developer needs", async () => {
    const { deps } = loginDeps({
        writeEntry: async (name) => { if (name.endsWith("-refresh")) { throw new m.VcSecretsError("keystore full"); } },
        removeEntry: async () => { throw new m.VcSecretsError("delete failed too"); },
    });
    await assert.rejects(() => m.cmdLogin("azure-mcp", LOGIN_CFG, deps), /keystore full/);
});

test("cmdLogin: an undeclared server is refused before a port is bound", async () => {
    let bound = false;
    const { deps } = loginDeps({ listen: async () => { bound = true; return { port: 1, next: async () => ({}), close: async () => {} }; } });
    await assert.rejects(() => m.cmdLogin("ghost", LOGIN_CFG, deps), /ghost/);
    assert.equal(bound, false);
});

test("cmdLogin: both writes happen under the lock, and it is taken AFTER the sign-in, not across it", async () => {
    // Two claims in one order, because they trade against each other. Under the lock: a renewal
    // finishing between the exchange and these writes would otherwise overwrite the token just
    // issued with the rotated one from the chain Entra killed by issuing it. After the sign-in:
    // the same mutex serialises every renewal on this machine, and a browser waits on a human.
    const order = [];
    const { deps } = loginDeps({
        listen: async () => ({ port: 1, next: async () => { order.push("browser"); return { code: "c" }; },
            close: async () => {} }),
        exchange: async () => { order.push("exchange"); return { refreshToken: "rt", accessToken: "at" }; },
        writeEntry: async (name) => { order.push(name.endsWith("refresh") ? "write-refresh" : "write-access"); },
        acquireLock: async () => { order.push("lock"); return { release: async () => order.push("release") }; },
    });
    await m.cmdLogin("azure-mcp", LOGIN_CFG, deps);
    assert.deepEqual(order, ["browser", "exchange", "lock", "write-refresh", "write-access", "release"]);
});

test("cmdLogin: a renewal that will not release still stores the token, and names what may undo it", async () => {
    // The asymmetry the shared helper deliberately does not decide. By this point the
    // authorization code is spent and single-use: refusing would leave the developer signed in at
    // Entra with nothing on disk, and a second attempt cannot reuse the code.
    let ms = 0;
    const { deps, written, logged } = loginDeps({
        acquireLock: async () => cache.HELD_BY_OTHER,
        now: () => (ms += 10_000),
        sleep: async () => {},
    });
    await m.cmdLogin("azure-mcp", LOGIN_CFG, deps);
    assert.equal(written.length, 2, "a spent code must still end up stored");
    // A wedged holder that later wakes will overwrite this write, and the developer would otherwise
    // meet that only as an unexplained request to sign in again.
    assert.match(logged.join(""), /still holding the lock/, "the hazard has to be named where it is taken");
    assert.match(logged.join(""), /run this again/, "together with what to do about it");
});

test("cmdLogin: no lock failure costs the developer a spent authorization code", async () => {
    // Every way of not getting the lock, including the ones acquireTokenLock rethrows rather than
    // classifies. Past the exchange the code is single-use and gone: an exception here would store
    // nothing, clear nothing, and leave the previous login's entries lying — and adding the lock is
    // what made that step able to fail at all, so refusing would be a regression, not a discovery.
    for (const boom of [Object.assign(new Error("refused"), { code: "EPERM" }),
        Object.assign(new Error("too many open files"), { code: "EMFILE" }),
        new TypeError("acquireLock is not a function")]) {
        const { deps, written, logged } = loginDeps({ acquireLock: async () => { throw boom; } });
        await m.cmdLogin("azure-mcp", LOGIN_CFG, deps);
        assert.equal(written.length, 2, `${boom.code ?? boom.name} lost the sign-in`);
        assert.match(logged.join(""), /NOT serialised/, "and the developer is told what was not promised");
        // Without this, a wiring TypeError and an ordinary sandbox EPERM print the same line, and
        // the first is a bug while the second is the environment working as measured.
        assert.match(logged.join(""), new RegExp(boom.code ?? boom.name),
            `the warning must name ${boom.code ?? boom.name}`);
    }
});

test("cmdLogin: the lock is released even when the refresh write fails and the entries are cleared", async () => {
    // The clearing branch deletes the very entries a waiting renewal is about to read, so it has
    // to run inside the lock too — and a leaked holder blocks every launch on this machine.
    const { deps, lock } = loginDeps({
        writeEntry: async () => { throw new m.VcSecretsError("keystore full"); },
        removeEntry: async () => {},
    });
    await assert.rejects(() => m.cmdLogin("azure-mcp", LOGIN_CFG, deps), /keystore full/);
    assert.deepEqual(lock, ["acquire", "release"]);
});

test("cmdLogin: a project-scope entry the user file has not acknowledged is refused before a port is bound", async () => {
    // Before the bind, for the same reason the backend check is: past the exchange the
    // authorization code is spent, and a refusal discovered there cannot be retried with it. The
    // bind is the observable because it is the first thing cmdLogin does to the outside world.
    let bound = false;
    const { deps } = loginDeps({
        listen: async () => { bound = true; return { port: 1, next: async () => ({}), close: async () => {} }; },
    });
    await assert.rejects(() => m.cmdLogin("azure-mcp", UNACKNOWLEDGED_CFG, deps), /not authorized/);
    assert.equal(bound, false, "an unauthorized sign-in must not reach the listener");
});

test("cmdLogin: the refusal names the registration that must be acknowledged, not the declaration", async () => {
    // The remedy is a block in the USER file keyed by the (tenantId, clientId) pair, and naming the
    // declaration instead would send the developer to edit the repository file that is precisely
    // what may not authorize itself.
    const { deps } = loginDeps();
    await assert.rejects(() => m.cmdLogin("azure-mcp", UNACKNOWLEDGED_CFG, deps),
        new RegExp(`registrations\\."${DECL_IDENTITY.tenantId}"\\."${DECL_IDENTITY.clientId}"`));
});

test("cmdLogin: the refusal names no command, because doctor does not report registrations yet", async () => {
    // The decision authorizationRefusal's own comment records, and the one resolveEnvEntries
    // already makes on this kind: doctor's crossing loop reports secret references only, so naming
    // it here would send the developer to a command that prints nothing about this block. It was
    // pinned at that site alone, and this verb did the opposite for a commit with nothing red. The
    // /not authorized/ half is the control: without it an empty message would satisfy the absence.
    const { deps } = loginDeps();
    await assert.rejects(() => m.cmdLogin("azure-mcp", UNACKNOWLEDGED_CFG, deps),
        (e) => /not authorized/.test(e.message) && !/vc-secrets doctor/.test(e.message));
});

test("cmdLogin: the policy refusal wins over the capability refusal", async () => {
    // Both would refuse this call. If the backend check ran first the developer would be told their
    // machine has no keystore -- true, and the wrong thing to go and fix, because installing one
    // changes nothing about a sign-in they are not authorized to make.
    const { deps } = loginDeps({ backend: "nonesuch" });
    await assert.rejects(() => m.cmdLogin("azure-mcp", UNACKNOWLEDGED_CFG, deps), (e) => {
        assert.match(e.message, /not authorized/);
        assert.doesNotMatch(e.message, /keystore/);

        return true;
    });
});

test("cmdLogin: a user-scope entry needs no registrations block, because its own file is the authorization", async () => {
    // Nothing is crossing a scope boundary: the declaration lives in the file the grant would live
    // in. Demanding a block here would make the developer authorize themselves, and `authorized` on
    // a user-scope declaration is absent in exactly the same way an unacknowledged registration is
    // -- which is why the exemption is keyed on the declaration's home and not on that absence.
    const { deps, written } = loginDeps();
    await m.cmdLogin("azure-mcp", USER_CFG, deps);
    assert.deepEqual(written.map(([name]) => name), [USER_KEYS.refresh, USER_KEYS.access]);
});
