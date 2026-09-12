// vc-secrets-error.mjs — the one error type every vc-secrets module throws.
//
// The error type lives alone so clients.mjs and the launcher can share it without a cycle. The cycle
// works today — clients.mjs only defines functions, so the binding is initialised before any call —
// and turns into a temporal-dead-zone crash the first time something there validates at module
// evaluation time.
class VcSecretsError extends Error {
    constructor(message, exitCode = 1) {
        super(message);
        this.exitCode = exitCode;
    }
}

export { VcSecretsError };
