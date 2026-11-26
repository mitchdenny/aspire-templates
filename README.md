# aspire-templates

My personal Aspire template repository, starting with the
`aspire-azure-starter` from
[Azure/aspire-templates](https://github.com/Azure/aspire-templates/tree/7f217365445c4f364726329d476433023e9beaba/templates/aspire-azure-starter),
pinned to commit `7f217365445c4f364726329d476433023e9beaba`.
It contains a Blazor frontend and ASP.NET Core API targeting Azure Container Apps,
with optional Azure Managed Redis caching and integration test projects.
The generated GitHub Actions workflow and deployment guide come from the same
public MIT-licensed repository at commit
[`7810530f6a5ce8672e39f892f20cb526be7b002b`](https://github.com/Azure/aspire-templates/tree/7810530f6a5ce8672e39f892f20cb526be7b002b/templates/aspire-azure-starter).
Template metadata adaptations connect
the workflow's CLI version to the shared Aspire package version and select the
.NET SDK from the target framework. No template-site post-create actions are included.

## Create an app

| Template | Layout |
|----------|--------|
| `aspire-azure-starter` | Blazor frontend and ASP.NET Core API |
| `aspire-azure-cs-ts-starter` | React/TypeScript Vite frontend, ASP.NET Core server and C# AppHost |

Both include Azure Container Apps deployment, authorized PR environment workflows,
the `setup-cicd` skill and a generated Visual Studio `.gitignore`. The React
starter is based on the official
[`aspire-ts-cs-starter`](https://github.com/microsoft/aspire/tree/b2baebe8864c718587bd7d13cfe5460a80f83062/src/Aspire.ProjectTemplates/templates/aspire-ts-cs-starter),
pinned to `b2baebe8864c718587bd7d13cfe5460a80f83062`. It preserves the upstream
C#/React architecture and options; only the Azure integration and CI/CD plumbing
are added. Node.js 24 LTS is needed for its frontend.

Install the [.NET 10 SDK](https://dotnet.microsoft.com/download) and
[Aspire CLI](https://aspire.dev/get-started/install-cli/) (17 or later). From this
repository, generate an app outside the template sources:

```bash
aspire new \
  --template-path ./templates/aspire-azure-starter \
  --name MyApp --output ../MyApp
```

The interactive prompts offer caching, test frameworks and `.dev.localhost`
URLs. For unattended default generation, add `--non-interactive` and
`--suppress-agent-init`. The Aspire host metadata resolves one shared Aspire
package version from NuGet (`[17.0.0,)`, stable by default); retain this metadata
when using prerelease package feeds or channels supported by your CLI.
No deployment is performed by generation. Local caching requires a container
runtime; local development does not require Azure credentials.
If the CLI detects an organizational configuration source, add
`--use-config-source false` to use only this starter.

For the React starter, use `--template-path ./templates/aspire-azure-cs-ts-starter`
instead. It supports caching, framework, HTTPS and `.dev.localhost` options,
but does not include the Blazor starter's optional test project.

The generated `.github/workflows/azure.yml` builds and publishes deployment
artifacts for PRs and `main` pushes; a successful `main` push then deploys to Azure.
**Configure and protect the `production` GitHub environment before the first
push.** The generated README explains OIDC, scoped Azure permissions and required
environment values. Copying or generating this template does not run the workflow
or provision cloud resources.

Template sources live under `templates/aspire-azure-starter`, including the hidden
`.template.config` host, IDE and localization metadata. The root MIT license
covers this repository's contributions; `templates/LICENSE` preserves upstream's
MIT notice, and bundled third-party notices remain with their files.
