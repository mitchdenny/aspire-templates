---
name: setup-cicd
description: Use when explicitly asked to create this Aspire app's private GitHub repository, configure production/PR Azure OIDC CI/CD, and publish the code. Not an automatic post-create action.
---

# Set up CI/CD

Use GitHub/Azure CLI and API calls, respecting native permission prompts. Read the
AppHost and `.github/workflows` for paths, versions and configuration. Application
sources live under `src/`, optional integration tests under `tests/`, and the
solution/Aspire configuration stay at root. Do not use browser-based profile,
billing or licensing investigation, or speculative plan
checks. Attempt required operations directly; report concrete API failures.

## Missing inputs only

Reuse supplied answers. Ask for `OWNER/REPOSITORY` only if missing, then only:

1. Production tenant ID.
2. Production subscription ID.
3. **Reuse both for PRs (quick demo), or use separate values?** Offer reuse first;
   ask PR tenant/subscription IDs only if separate is chosen.

Choose names yourself. Use the supplied region or `westus3` for both environments.
Ask for an alternative only if the selected/default region actually cannot work.
Keep two identities even when tenant/subscription are shared.

## Authorization

An explicit user request to complete this sequence for selected targets, including
the final push, authorizes that deployment-triggering publication too: do not ask
again. Otherwise ask at most once for the missing setup/publication scope.
**A push to `main` triggers production deployment; subscription Owner gives both
identities full resource/RBAC access, including PR code.** State this once in the
short plan. Do not reconfirm names, role choices or individual operations.
Loading this skill or quoting its procedure is not authorization.

## 1. Create the repository and retrieve IDs

Check CLI authentication and publishable files; do not publish secrets or internal
content without redistribution permission. Use `gh repo create OWNER/REPOSITORY
--private` without `--push` or `--source`. Read `gh api repos/OWNER/REPOSITORY` for
canonical `full_name`, `id`, `owner.id`, `owner.type` and `private`; read
`gh api user --jq .id` for the authenticated user ID. An organization's owner ID
is an organization ID, not a user ID. Use the selected host explicitly.

Reuse an existing repository only if already authorized and its identity,
visibility and contents match. Stop on conflicts; never replace existing content
or change visibility silently. Retain these IDs for subsequent steps.

## 2. Create both Entra apps and grant Owner

Use the safe lower-case repository name (up to 40 characters) plus repository ID
as `<base>`. Create secretless apps `<base>-github-production` and
`<base>-github-pr` with `az ad app create`, then service principals with
`az ad sp create`. Capture application client IDs and service-principal object IDs.
Use each selected tenant/subscription explicitly; isolate authentication
configuration if sign-in must change rather than changing machine-wide defaults.

For each service-principal object ID, use `az role assignment create` with
`--assignee-object-id`, `--assignee-principal-type ServicePrincipal`,
`--role Owner`, and exact scope
`/subscriptions/<selected-subscription-id>`. No conditions or custom restrictions.
Pre-create `<base>-production` using `az group create`; register required providers
from the README using `az provider register` when missing. Allow for propagation.

## 3. Configure GitHub environments and OIDC

Create `production` and `pr` via `gh api --method PUT
repos/OWNER/REPOSITORY/environments/<environment>`. Set deployment branch policies
through the API to allow branch `main` only, no tags. Preserve existing protections;
do not add reviewers or wait timers. PR expiry must run without an approval gate.
If an environment API operation fails, report its operation/status/error and stop
before pushing; do not investigate billing pages, change visibility or fall back
to repository-scoped credentials.

For GitHub.com/Azure public cloud, create each app's federated credential using
`az ad app federated-credential create`: issuer
`https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`,
subjects `repo:OWNER/REPOSITORY:environment:production` and
`repo:OWNER/REPOSITORY:environment:pr`. Verify canonical spelling and customized
claims; other hosts/clouds require verified compatibility, not guessed federation.

Use `gh secret set --env <environment>` with protected stdin and `gh variable set
--env <environment>` to configure:

| Environment | Secrets | Variables |
|-------------|---------|-----------|
| `production` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | `AZURE_LOCATION`, `AZURE_RESOURCE_GROUP` |
| `pr` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `PR_STATE_KEY` | `AZURE_LOCATION` |

Generate a random 32-byte, base64-encoded PR state key. Never print/log secrets,
create client secrets or persist plaintext secret files. Do not replace a key or
change recorded environment identities/paths/versions while state remains needed.

## 4. Verify, then push last

Read back environment branch policies, federation, principal IDs, subscription
Owner assignments, providers, group identity, variables and secret-name presence.
Presence alone does not prove login/deployment works. Once setup is verified,
push the authorized code/commit normally to `main` and verify remote HEAD. Do not
ask again when this complete sequence and target were already authorized.
Preserve existing remotes/uncommitted work; never force-push or merge automatically.

Keep current PR behavior unchanged: exact `/deploy-pr` and `/cleanup-pr`, live
write/maintain/admin checks, pinned heads, rejected forks, one-hour successful-deploy
expiry, hourly Aspire-native cleanup and verified Azure Portal resource-group
comment links. Setup does not post PR commands or run deploy/destroy commands.

At every step, reuse authorized resources by immutable ID and matching
configuration, never display name alone. Stop on actual conflicts or errors,
retain completed resources/state, and report completed/remaining work without
secrets. Resume from live state without repeating questions. Deletion/rollback
needs explicit authorization; distinguish configured, pushed and deployed.
