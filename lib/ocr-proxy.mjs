const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export async function forwardOcrRequest(body, { referer = "" } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      status: 500,
      payload: {
        error: {
          message:
            "OPENROUTER_API_KEY no está configurada en el entorno del servidor.",
        },
      },
    };
  }

  const model = String(body?.model || "google/gemma-3-4b-it").trim();
  const messages = body?.messages;
  if (!model || !Array.isArray(messages) || messages.length === 0) {
    return {
      status: 400,
      payload: {
        error: { message: "La solicitud OCR no tiene un formato válido." },
      },
    };
  }

  const baseUrl = (process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/$/,
    "",
  );
  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(referer ? { "HTTP-Referer": referer } : {}),
        "X-Title": "Depósito MVP",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages,
      }),
    });
    const text = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = {
        error: { message: text || "Respuesta inválida de OpenRouter." },
      };
    }
    return { status: upstream.status, payload };
  } catch (error) {
    return {
      status: 502,
      payload: {
        error: {
          message:
            error instanceof Error
              ? `No se pudo conectar con OpenRouter: ${error.message}`
              : "No se pudo conectar con OpenRouter.",
        },
      },
    };
  }
}
