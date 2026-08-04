---
description: "One-time: move secrets stored under the pre-plugin key prefix to their namespaced keys. Run once after switching a machine from the in-repo wrapper to this plugin. Idempotent."
argument-hint: ""
disable-model-invocation: true
---

# /vc-secrets:migrate — carry existing secrets over to the namespaced keys

Keys are now namespaced by the declaration's home (`vc-secrets:<projectId>:<name>`,
`vc-secrets:user:<name>`) instead of a flat prefix. This copies what is already stored.

## Why this exists rather than "just set them again"

`set` needs the plaintext, and the credential store will not hand a value back — that is the whole
point of putting it there. A developer whose PAT exists only under the old key cannot retype it; they
would have to mint a new one. Across a team, renaming a key prefix would become a credential
rotation. So the launcher reads the old entry itself and writes the new key, never printing the value.

## Run it

```bash
node "$VC_SECRETS" migrate
```

Unsandboxed, in a real terminal — on the gpg backend the agent may need to be unlocked first
(`node "$VC_SECRETS" unlock`).

## What it does per secret

| Outcome | Meaning |
|---|---|
| `migrated` | the legacy entry was read and written under the new key |
| `already present` | the new key already resolves — nothing to do |
| `no legacy entry` | nothing to carry over; `set <name>` is the next step |
| `cannot tell whether it is already migrated, refusing to touch it` | the store answered neither "here it is" nor "absent" — a cold gpg agent, a timeout, a wrong recipient. Nothing was written, deliberately: the alternative is overwriting a current value with a stale one. Fix the store (`unlock`, or check the backend) and re-run |
| `migration failed` | the write itself failed; the old entry is untouched |

The run exits non-zero if any secret failed or could not be judged. Idempotent, so re-running is safe. The legacy entry is left in place: nothing reads it, and deleting
it would add a second way to fail. Remove it by hand later if you want the store tidy.

## Report

The per-secret lines verbatim plus the final count, then run `/vc-secrets:doctor` and confirm the
migrated names now report `OK`. If any secret says `no legacy entry`, list it explicitly — that is a
value nobody has, and the operator needs to know before a server fails at launch.
