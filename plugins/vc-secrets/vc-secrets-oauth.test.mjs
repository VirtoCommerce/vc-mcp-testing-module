import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "./vc-secrets.mjs";              // the launcher
import * as oauth from "./vc-secrets-oauth.mjs";     // the protocol
import crypto from "node:crypto";
import os from "node:os";
import http from "node:http";
import net from "node:net";

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
// Adapted from the source's unix-domain-socket probe (which gated lock-file tests that do not
// exist in this port yet): the capability under test here is a loopback TCP bind, so the probe
// binds one instead of a unix socket — probing the wrong permission would answer confidently
// either way.
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
