import { forwardOcrRequest } from "../lib/ocr-proxy.mjs";

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response
      .status(405)
      .json({ error: { message: "Método no permitido." } });
  }

  const result = await forwardOcrRequest(request.body, {
    referer: `https://${process.env.VERCEL_URL || "vercel.app"}`,
  });
  return response.status(result.status).json(result.payload);
}
