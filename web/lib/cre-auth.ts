export function requireCre(req: Request): Response | null {
  const expected = process.env.CRE_API_KEY;
  if (!expected) {
    return Response.json(
      { error: "CRE_API_KEY not configured" },
      { status: 500 },
    );
  }
  const got = req.headers.get("x-api-key");
  if (!got || got !== expected) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
