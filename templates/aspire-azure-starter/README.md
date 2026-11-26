# Aspire-StarterApplication.1

A Blazor frontend and ASP.NET Core API orchestrated by Aspire and ready to deploy
to Azure Container Apps. If you enabled caching when creating this project, local
runs use a Redis container and deployments use Azure Managed Redis.

Application projects (AppHost, API, Web and ServiceDefaults) live under `src/`.
Optional integration tests live under `tests/`. The solution, Aspire configuration
and GitHub workflows/skills stay at the repository root.

## Run locally

Install the .NET SDK for this project's target framework and the
[Aspire CLI](https://aspire.dev/get-started/install-cli/), then run from this directory:

```bash
aspire run
```

Local development does not require Azure credentials. Caching requires a supported
container runtime.

The included `.gitignore` starts from GitHub's
[VisualStudio.gitignore](https://github.com/github/gitignore/blob/90e1bba3f058319173bcece4f1ff62f5cf18ee53/VisualStudio.gitignore)
(CC0), with additional local IDE/macOS exclusions.

## Next Steps

### Optional guided setup

The bundled Copilot skill at
[`.github/skills/setup-cicd/SKILL.md`](.github/skills/setup-cicd/SKILL.md)
guides production and PR setup. Ask your agent to **use setup-cicd** with your
target repository, production tenant ID and subscription ID. Reuse those Azure
values for PRs for a quick demo, or supply separate ones. Names are chosen for you.
Guided setup grants each Entra service principal **unrestricted Owner on its
selected subscription**, including PR code's access; this is broad demo access.
The CLI/API flow creates the repository and retrieves IDs, creates both Entra apps
and Owner grants, configures GitHub environments/OIDC, then pushes last. Explicitly
authorizing that full sequence includes the deployment-triggering push, without
repeat confirmations. Native tool prompts still apply; this is never a post-create
action.

### 1. Create your GitHub repository

Create a GitHub repository with a `main` branch, then configure and protect the
production environment and Azure access described below **before the first
push**. The included
`.github/workflows/azure.yml` builds the application and runs `aspire publish` on
pull requests targeting `main` and on pushes to `main`. Publishing must complete
successfully; it is not just a step listing or a dry run.

The publish job has no Azure login, environment secrets, or OIDC permission, and
works for fork PRs (subject to GitHub's approval rules for external contributors).
It generates deployment artifacts without provisioning Azure resources or pushing
images. It does not prove that Azure permissions, quotas, image builds, or the
live deployment will succeed. It does not run the optional integration tests.
Mark **Publish deployment artifacts** as a required check in your main-branch ruleset.

After a successful publish on `main`, the deploy job runs `aspire deploy` against
the GitHub environment named `production`. Aspire uses the .NET environment
`Production` for both commands; this is separate from the case-sensitive GitHub
environment name used by OIDC. Deployment runs directly from the AppHost, not
from the previous job's published artifacts.

### 2. Create and protect the production environment

In the repository's **Settings > Environments**, create **production** before
enabling deployments. Restrict its deployment branches to **Selected branches
and tags**, adding only the branch **main** (not a tag). Configure required
reviewers and prevent self-review where your GitHub plan supports it. Protect
`main` with PR reviews and required checks; review workflow and AppHost changes
especially carefully.

Store deployment secrets only in this environment, not as repository secrets.
Do not grant PR workflows access to it, use `pull_request_target` to execute PR
code, or create a federated credential for `pull_request`. The environment's
branch restrictions are essential: an environment-based OIDC subject does not
itself restrict a token to `main`. These protections also matter for same-repository
PRs, which can change workflow code. Never approve a deployment of untrusted code.

### 3. Bootstrap Azure access manually (resource-group scoped)

The manual alternative below uses narrower resource-group-scoped roles, unlike
the guided skill's subscription-wide Owner grants.

Run the following Bash commands yourself in a trusted terminal after installing
the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli).
**These commands create an Entra application, service principal, federated
credential, resource group, and role assignments.** They can enable billable
deployments. They are initial setup, not steps to run inside the workflow.

Replace the values below. Use the exact GitHub owner/repository spelling and an
Azure region supporting your chosen resources, including Azure Managed Redis
if caching is enabled.

```bash
set -euo pipefail

GITHUB_REPOSITORY="OWNER/REPOSITORY"
AZURE_SUBSCRIPTION_ID="<subscription-id>"
AZURE_LOCATION="westus3"
AZURE_RESOURCE_GROUP="my-app-production"
APP_DISPLAY_NAME="my-app-github-production"

az login
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
AZURE_TENANT_ID=$(az account show --query tenantId --output tsv)

az group create --name "$AZURE_RESOURCE_GROUP" --location "$AZURE_LOCATION"
RESOURCE_GROUP_ID=$(az group show --name "$AZURE_RESOURCE_GROUP" --query id --output tsv)

AZURE_CLIENT_ID=$(az ad app create --display-name "$APP_DISPLAY_NAME" --query appId --output tsv)
SERVICE_PRINCIPAL_ID=$(az ad sp create --id "$AZURE_CLIENT_ID" --query id --output tsv)

FEDERATED_CREDENTIAL_FILE=$(mktemp)
cat > "$FEDERATED_CREDENTIAL_FILE" <<EOF
{
  "name": "github-production",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:${GITHUB_REPOSITORY}:environment:production",
  "description": "GitHub Actions production environment",
  "audiences": ["api://AzureADTokenExchange"]
}
EOF
az ad app federated-credential create \
  --id "$AZURE_CLIENT_ID" \
  --parameters "$FEDERATED_CREDENTIAL_FILE"
rm "$FEDERATED_CREDENTIAL_FILE"

az role assignment create \
  --assignee-object-id "$SERVICE_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Contributor" \
  --scope "$RESOURCE_GROUP_ID"

az role assignment create \
  --assignee-object-id "$SERVICE_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Role Based Access Control Administrator" \
  --scope "$RESOURCE_GROUP_ID"

printf 'AZURE_CLIENT_ID=%s\nAZURE_TENANT_ID=%s\nAZURE_SUBSCRIPTION_ID=%s\n' \
  "$AZURE_CLIENT_ID" "$AZURE_TENANT_ID" "$AZURE_SUBSCRIPTION_ID"
```

Your setup identity needs permission to create Entra applications/service
principals, create the resource group, and assign Azure roles at that scope.
Tenant policy may require an administrator. The application is created without a
client secret. Do not create or store `AZURE_CLIENT_SECRET`.

Contributor permits resource deployment but not role assignments. Aspire creates
managed identities and role assignments for registry access and, when selected,
Redis access, so the second role is also needed. Both grants are limited to the
dedicated, pre-created resource group. The deployment identity has no permission
to create other resource groups; this boundary is enforced by Azure RBAC, not
an AppHost configuration switch. The RBAC administrator grant is powerful
within that group. For
stricter environments, have an administrator design constrained role assignments
or pre-provisioned resources instead of granting subscription-wide Owner.
Allow time for new identities and role assignments to propagate.

An administrator should also register the required resource providers at the
subscription scope if they are not already registered:

```bash
for provider in Microsoft.App Microsoft.ContainerRegistry Microsoft.ManagedIdentity Microsoft.OperationalInsights; do
  az provider register --namespace "$provider" --wait
done
# Also required when Azure Managed Redis caching is enabled:
# az provider register --namespace Microsoft.Cache --wait
```

The deployment identity deliberately has no subscription-wide registration grant.
Review the generated Bicep if you add resources needing other providers.

### 4. Configure GitHub values

In the **production** environment, add these values:

| Kind | Name | Value |
|------|------|-------|
| Secret | `AZURE_CLIENT_ID` | Entra application's application (client) ID |
| Secret | `AZURE_TENANT_ID` | Entra tenant ID |
| Secret | `AZURE_SUBSCRIPTION_ID` | Target subscription ID |
| Variable | `AZURE_LOCATION` | The chosen Azure region |
| Variable | `AZURE_RESOURCE_GROUP` | The pre-created resource group name |

These identifiers are stored as secrets by convention; OIDC supplies short-lived
credentials and no long-lived Azure password is needed. The workflow fails
explicitly if a required value is missing. Future secret AppHost parameters belong
in environment secrets and should be mapped to `Parameters__<name>` on the deploy
step, not on the PR publish job.

### 5. Deploy

Merge a reviewed change into `main` and approve the production environment job if
approval is configured. The GitHub-hosted Linux runner supplies Docker and Azure
CLI; the workflow installs .NET and an Aspire CLI version matching the starter's
AppHost release. Keep these versions aligned when upgrading. Projects targeting
preview .NET frameworks also use a preview SDK in CI.

Aspire provisions the Container Apps environment, registry, managed identities,
and application resources. Optional Azure Managed Redis creates additional
billable resources. Production deployments are serialized and a running
deployment is not cancelled by a newer push.

Published output is temporary and is not uploaded as an artifact, since generated
deployment files can contain sensitive configuration as the app evolves.
Review costs and your cleanup policy before the first deployment; this workflow
does not automatically destroy resources.

## On-demand PR environments

The separate PR workflows do not deploy automatically when a PR is opened.
Once these files exist on the repository's **main default branch**, a human
collaborator with live **write, maintain or admin** permission can post exactly:

```text
/deploy-pr
```

or:

```text
/cleanup-pr
```

No arguments, extra text, edited comments or bot comments are accepted. Deploy
requires an open PR targeting `main` whose head belongs to this repository;
**fork PR deployments are rejected**. Cleanup also works for closed PRs.
Permissions and PR identity are checked again before the operation; a changed
head requires a new command. The initial comment identifies the pinned commit;
a rerun cannot silently repin the same deploy comment to a different head.
The result updates that same bot-owned comment with a workflow-run link and
the verified Azure Portal resource-group link. Cleanup reports an actually absent
group as deleted, or an asynchronous deletion still in progress as pending.

**Posting `/deploy-pr` explicitly trusts the pinned PR code with the PR Azure
identity. There is no separate approval gate.** Review all of that code first,
including AppHost, build targets and dependencies. The same-repository restriction
is not a sandbox or proof that the code is safe. Protect the default branch and
review workflow/helper changes. Authorization and cleanup helpers come only from
the trusted default-branch workflow revision, never from the PR checkout.

### Configure the shared `pr` environment

Create a GitHub environment named **pr**, independently of **production**. Allow
deployment from branch **main** only, with no tags. Do not configure required
reviewers or wait timers if expiry must run unattended. Private repositories need
a GitHub plan supporting environments, environment secrets and branch restrictions;
if that is unavailable, stop rather than exposing credentials or weakening scope.

| Kind | Name | Value |
|------|------|-------|
| Secret | `AZURE_CLIENT_ID` | Dedicated PR Entra application's client ID |
| Secret | `AZURE_TENANT_ID` | PR identity's tenant ID |
| Secret | `AZURE_SUBSCRIPTION_ID` | PR deployment subscription ID |
| Secret | `PR_STATE_KEY` | Base64-encoded random 32-byte encryption key |
| Variable | `AZURE_LOCATION` | Supported PR deployment region |

Generate the state key locally using `openssl rand -base64 32`, then enter it
directly as an environment secret; do not commit it or post it in comments.
Retain this key until all recorded environments have been cleaned up.

Use a separate Entra application/federated credential for PRs. For this
GitHub.com/Azure public-cloud workflow, its issuer is
`https://token.actions.githubusercontent.com`, audience is
`api://AzureADTokenExchange`, and subject is
`repo:OWNER/REPOSITORY:environment:pr`. Check any customized GitHub OIDC subject
before configuring federation. Do not grant a PR-branch or fork credential.
No Azure client secret is used.

Every PR gets `aspire-pr-<immutable-repository-id>-<PR-number>` as its dedicated
resource group and `pr-<PR-number>` as its Aspire environment. A single shared
GitHub environment supplies identity/configuration; it is not a shared Azure
Container Apps environment or resource group. Do not put production or unrelated
resources into these groups: native Aspire teardown deletes the whole group.
An existing group is never adopted based on its name alone.

Guided demo setup grants the PR identity unrestricted subscription Owner. If you
reuse the production subscription, PR code has that same broad access.
For narrower, non-demo access, have an administrator design permissions deliberately.
Unlike production's pre-created group, a first PR deployment creates a group:
it needs group-creation permission plus deployment/tagging and managed-identity
role-assignment rights for that group's resources. Use a dedicated PR subscription
or administrator-managed, pre-scoped access rather than broad access to a shared
production subscription. Environment variables are
not an RBAC security boundary. The workflows do not grant Azure roles or register
providers. Required resource providers must already be registered.

### Expiry, state and recovery

A successful deployment expires **one hour after completion**. Only another
successful `/deploy-pr` refreshes expiry; comments, commits and failed redeploys
do not extend an existing lease. Hourly scheduled checks attempt cleanup, so
actual removal can be later than one hour because of scheduling, queues or Azure
deletion latency. No immediate PR-close cleanup is configured.

Deployment and all cleanup paths share a per-PR concurrency lock and never cancel
an active operation. Scheduled cleanup re-reads the newest record under that lock,
so a renewed lease is not deleted using an older discovery result. It discovers
authenticated repository-owned records, not every group matching a prefix.

Native Aspire state and its ownership/expiry record are encrypted with
AES-256-GCM before being retained as an Actions artifact for 90 days. No plaintext
deployment state, native logs or credentials are uploaded or posted. The state
contains the verified subscription/group, immutable repository/PR identity and a
deployment marker checked against live group tags. Cleanup uses `aspire destroy`
with restored native state and a trusted default-branch AppHost at the same path;
it never executes the PR's cleanup code or falls back to raw Azure deletion.

Do not delete the state artifacts, rotate the key, rename the repository/AppHost
path, change PR tenant/subscription or upgrade the Aspire version while recorded
groups remain. Missing, expired, corrupted or mismatched state fails closed,
rather than restoring older state or deleting a guessed target. Cancelled runners,
artifact-upload failures or failures before native state is saved can require
operator recovery: retain any surviving state and verify the exact group before
manual intervention. Do not interpret a failed workflow as successful cleanup.
Partial deploy state is retained when available; failed/pending cleanup can retry.

You can run the helper's focused checks locally without GitHub/Azure mutations:

```bash
node --test .github/pr-environments/lifecycle.test.mjs
```
