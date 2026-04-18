# Contributing to atlasent-action

Thanks for your interest. This repo publishes the AtlaSent composite GitHub Action used as a required status check to gate deploys on a valid permit.

## Ground rules

1. **Fail-closed.** If evaluation cannot complete, the action must fail the check — never pass "because the network was slow."
2. **No secret leakage.** Never `echo` the API key or any bearer token. Use `::add-mask::` for any dynamic value that could be sensitive.
3. **Tag stability.** Published major tag is `v1`. Any change that's not backwards-compatible requires a deliberate tag bump and release notes.
4. **Runner compatibility.** Keep the composite action working on ubuntu / macos / windows runners unless there's a documented reason not to.

## Local testing

Use [act](https://github.com/nektos/act) or a fork with a test workflow that references `uses: <your-fork>/atlasent-action@<your-branch>`.

## Pull request checklist

- [ ] `action.yml` still valid (composite steps parse)
- [ ] `README.md` updated if inputs / outputs changed
- [ ] No unmasked secrets in shell output
- [ ] A smoke workflow run proves the action still fails closed on bad credentials

## Reporting a security issue

Email **security@atlasent.io**. We acknowledge within 2 business days. Do not open a public issue for security-sensitive reports.

## License

By contributing, you agree that your contributions are licensed under the same license as this repository (see [`LICENSE`](./LICENSE)).
