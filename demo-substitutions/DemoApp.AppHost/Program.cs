// DemoApp AppHost
// "DemoApp" becomes your project name, "demoapp" the lowercase version.
var builder = DistributedApplication.CreateBuilder(args);
builder.AddProject<Projects.DemoApp_Web>("demoapp-web");
builder.Build().Run();
