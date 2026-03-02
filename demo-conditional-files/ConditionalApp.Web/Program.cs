var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/", () => "Hello from ConditionalApp!");
app.Run();
