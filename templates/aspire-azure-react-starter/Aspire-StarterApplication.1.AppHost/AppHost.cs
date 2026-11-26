var builder = DistributedApplication.CreateBuilder(args);

builder.AddAzureContainerAppEnvironment("env");

#if UseRedisCache
var cache = builder.AddAzureManagedRedis("cache")
    .RunAsContainer();

#endif
var server = builder.AddDotnetProject("server", "../Aspire-StarterApplication.1.Server/Aspire-StarterApplication.1.Server.csproj")
#if UseRedisCache
    .WithReference(cache)
    .WaitFor(cache)
#endif
    .WithHttpHealthCheck("/health")
    .WithExternalHttpEndpoints();

var webfrontend = builder.AddViteApp("webfrontend", "../frontend")
    .WithReference(server)
    .WaitFor(server);

server.PublishWithContainerFiles(webfrontend, "wwwroot");

builder.Build().Run();
