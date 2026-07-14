import http from 'k6/http';
import { check } from 'k6';

// GraphQL post helper. Measurement discipline: HTTP 200 with a
// GraphQL `errors` body is a FAILURE — both checks must pass for the iteration
// to count green. Each request is tagged with the operation name so
// `http_req_duration{name:...}` sub-metrics and thresholds attribute per-op.
export function gql(baseUrl, token, name, query, variables) {
    const res = post(baseUrl, token, name, query, variables);
    const body = safeJson(res);
    const ok = check(
        res,
        {
            [`${name}: HTTP 200`]: (r) => r.status === 200,
            [`${name}: no GraphQL errors`]: () => !(body && body.errors),
        },
        { name },
    );
    if (!ok && body && body.errors) {
        console.warn(`${name}: ${JSON.stringify(body.errors).slice(0, 400)}`);
    }

    return body ? body.data : null;
}

// Best-effort variant for cleanup/teardown calls: no checks, failures tolerated silently
// (e.g. a resource already removed by an earlier step in the same iteration).
export function gqlQuiet(baseUrl, token, name, query, variables) {
    const res = post(baseUrl, token, name, query, variables);
    const body = safeJson(res);

    return body ? body.data : null;
}

function post(baseUrl, token, name, query, variables) {
    return http.post(`${baseUrl}/graphql`, JSON.stringify({ query, variables }), {
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        tags: { name },
    });
}

function safeJson(res) {
    try {
        return res.json();
    } catch (_) {
        return null;
    }
}
