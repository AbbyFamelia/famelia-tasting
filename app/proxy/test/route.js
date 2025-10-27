export const runtime = 'nodejs';

export async function GET() {
  return new Response(JSON.stringify({ ok: true, where: "proxy/test" }), {
    headers: { "Content-Type": "application/json" }
  });
}
