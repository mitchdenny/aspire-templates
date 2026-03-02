// DemoApp Web Service
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/", () => "Hello from DemoApp!");
app.Run();
