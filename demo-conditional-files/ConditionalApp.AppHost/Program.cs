var builder = DistributedApplication.CreateBuilder(args);
builder.AddProject<Projects.ConditionalApp_Web>("web");
builder.Build().Run();
