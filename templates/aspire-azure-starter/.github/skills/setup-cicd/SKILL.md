---
name: setup-cicd
description: Use when explicitly asked to set up this Aspire app's private GitHub repository and production/PR CI/CD with Azure OIDC. Not an automatic post-create action or permission to deploy.
---

# Set up CI/CD

Use GitHub/Azure CLI tools and their normal approvals. Read the generated AppHost,
README and `.github/workflows` to derive paths, versions and required configuration.
Do not upgrade packages or execute deployment/cleanup during setup.

## Essential questions only

Reuse answers and repository/host details already explicitly supplied. Ask for
`OWNER/REPOSITORY` only if missing. Otherwise collect only missing answers to:

1. Production tenant ID.
2. Production subscription ID.
3. **Use the same tenant and subscription for PRs (quick demo), or separate ones?**
   Offer reuse first. Ask PR tenant/subscription IDs only if separate is chosen.

Do not ask about names, role choices, region or extra governance preferences.
Use a supplied region, otherwise `westus3` for both environments. Verify resource
availability, including optional Azure Managed Redis; ask for an alternative only
if that default cannot work. Keep separate production/PR identities even when
their tenant and subscription are shared.

## Preflight and approvals

Check authentication, exact tenants/subscriptions, operator permissions, repository
ownership/private visibility, publishable files and GitHub environment support
read-only. Do not infer targets from the default Azure account. Use explicit
targets and isolated authentication configuration if sign-in must change.
Never publish secrets or internal content without redistribution permission.

Choose names yourself: use the safe lower-case repository name (up to 40 characters)
plus its immutable GitHub repository ID as a base. Name the Entra applications
`<base>-github-production` and `<base>-github-pr`, and the production resource
group `<base>-production`. Existing PR group naming stays unchanged.

Grant each application's service principal **Owner at its selected subscription
scope** (`/subscriptions/<subscription-id>`), without conditions or custom
restrictions. This gives both deployment identities full resource/RBAC control
across those subscriptions, including PR-executed code; sharing a production
subscription is therefore a broad-access demo choice, not isolation.

Present one short plan covering repository, selected Azure targets, app creation,
Owner grants, providers, OIDC and GitHub environment settings. Ask at most once
for setup approval, **only if the invocation has not already authorized those
actions and targets**. Never reconfirm the stated Owner choice, chosen names,
individual API operations or answered questions. Native tool/runtime permission
prompts still apply; do not add redundant confirmations around them.

## Execute the approved setup

- Create an empty private repository without auto-pushing, or reuse the approved
  repository after verifying its immutable identity and contents.
- Create `production` and `pr` environments restricted to branch `main`, no tags.
  Preserve existing protections; do not add new reviewer gates or wait timers.
  In particular, `pr` has no approval gate so expiry can run unattended. Stop on
  conflicting protections or unsupported private-repository features rather than
  silently weakening them or exposing repository-scoped credentials.
- Create separate secretless Entra applications/service principals and the
  subscription Owner assignments above. Pre-create the dedicated production
  resource group; register required providers from the README when missing.
- For GitHub.com/Azure public cloud, use issuer
  `https://token.actions.githubusercontent.com`, audience
  `api://AzureADTokenExchange`, and exact subjects
  `repo:OWNER/REPOSITORY:environment:production` and
  `repo:OWNER/REPOSITORY:environment:pr`. Verify canonical spelling/customized
  claims. Other hosts/clouds need verified compatibility, never guessed federation.
- In **each** environment set secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
  `AZURE_SUBSCRIPTION_ID` and variable `AZURE_LOCATION`. Production also needs
  variable `AZURE_RESOURCE_GROUP`; PR needs secret `PR_STATE_KEY` containing a
  base64-encoded random 32-byte key. Send secrets through protected input, never
  print/log them, create client secrets or persist plaintext secret files.

Preserve PR behavior: exact `/deploy-pr` and `/cleanup-pr`, live
write/maintain/admin authorization, pinned heads, rejected fork deployments,
one-hour expiry refreshed only on successful deployment, hourly native cleanup,
and comments linking to the verified Azure Portal resource group. Setup does not
post commands. Retain state artifacts/key; never change their identity/path/version
or replace the key while recorded environments remain.

## Verify and publish separately

Read back environment policies, federation, principal IDs, exact Owner scopes,
providers, group identity, variables and secret-name presence. Presence is not
proof of a working login. Reuse approved resources by immutable ID and exact
configuration; stop on conflicts, rather than adopting by name or overwriting
unrelated settings. Preserve existing remotes and uncommitted work.

**Pushing to `main` triggers production deployment.** Ask for publication approval
only if that push/deployment was not already explicitly authorized for the target.
If deployment is not approved, propose a non-main publication branch. Use normal,
non-force pushes only when publication is authorized and verify remote HEAD.
Do not create/merge a PR, approve a deployment or delete resources automatically.

On failure, stop dependent actions and report completed/remaining steps without
secrets. Retain created resources and surviving state; rollback/deletion needs
explicit authorization. Resume from verified live state without repeating the
questionnaire. Report configured/published/deployed distinctly; never claim an
untested runtime deployment succeeded.
