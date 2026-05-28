// Two classes with a colliding short method name `run`. The walker must
// produce qualified names `Alpha.run` and `Beta.run` so they're
// distinguishable even though both have short name `run`.
//
// alphaOnly / betaOnly are unique names used to verify that call edges inside
// each method are attributed to the *correct* symbol, not the first `run`.

function alphaOnly(): number { return 1; }
function betaOnly(): number { return 2; }

export class Alpha {
  run(): string {
    alphaOnly();
    return 'alpha';
  }
}

export class Beta {
  run(): string {
    betaOnly();
    return 'beta';
  }
}
