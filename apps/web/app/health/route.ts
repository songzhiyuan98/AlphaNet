export function GET() {
  return Response.json({
    status: "ok",
    service: "web",
    version: process.env.APP_VERSION ?? "0.1.0",
    timestamp: new Date().toISOString(),
  });
}
