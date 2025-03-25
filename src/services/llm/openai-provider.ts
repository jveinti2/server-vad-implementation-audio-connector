import {
  LLMProvider,
  ConversationContext,
  LLMResponse,
} from "./llm-provider.interface";
import { EventEmitter } from "events";

export class OpenAIProvider extends EventEmitter implements LLMProvider {
  private apiKey: string;
  private systemPrompt: string;

  constructor(apiKey: string) {
    super(); // Inicializar EventEmitter
    this.apiKey = apiKey || process.env.OPENAI_API_KEY || "";
    this.systemPrompt =
      "Eres Mia, una asistente amable especializada en atención al cliente de Tigo. " +
      "Proporciona respuestas claras, útiles y concisas. Sé amable y profesional." +
      "Proporciona informacion acerca de todo lo que te pidan haciendo referencia a los servicios de Tigo, aqui puedes inventar lo que sea necesario" +
      "Responde con no mas de 50 palabras";
  }

  async generateResponse(
    input: string,
    context: ConversationContext
  ): Promise<LLMResponse> {
    try {
      // Construir los mensajes para el modelo
      const messages = [
        { role: "system", content: this.systemPrompt },
        ...context.messages,
        { role: "user", content: input },
      ];

      console.log(
        `🤖 [LLM] Enviando petición a OpenAI: "${input.substring(0, 50)}${
          input.length > 50 ? "..." : ""
        }"`
      );

      // Usar streaming para comenzar a procesar la respuesta más rápido
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-3.5-turbo",
            messages,
            max_tokens: 120,
            temperature: 0.6,
            stream: true, // Habilitar streaming
          }),
        }
      );

      if (!response.ok) {
        const errorData = (await response.json()) as {
          error?: { message?: string };
        };
        throw new Error(
          `Error de OpenAI: ${errorData.error?.message || "Desconocido"}`
        );
      }

      if (!response.body) {
        throw new Error("No se pudo obtener el stream de respuesta");
      }

      // Procesar la respuesta como stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let responseText = "";
      let streamDone = false;

      // Procesar el stream
      while (!streamDone) {
        const { done, value } = await reader.read();

        if (done) {
          streamDone = true;
          break;
        }

        // Decodificar y procesar los chunks
        const chunk = decoder.decode(value);
        const lines = chunk
          .split("\n")
          .filter(
            (line) => line.trim() !== "" && line.trim() !== "data: [DONE]"
          );

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const jsonData = JSON.parse(line.slice(6));
              const content = jsonData.choices?.[0]?.delta?.content || "";

              if (content) {
                responseText += content;

                // Emitir evento con el texto parcial
                this.emit("partial-response", {
                  text: responseText,
                  final: false,
                });
              }
            } catch (e) {
              // Ignorar errores de parsing
            }
          }
        }
      }

      console.log(
        `🤖 [LLM] Respuesta de OpenAI completada: "${responseText.substring(
          0,
          50
        )}${responseText.length > 50 ? "..." : ""}"`
      );

      // Emitir respuesta final
      this.emit("partial-response", {
        text: responseText,
        final: true,
      });

      return {
        text: responseText || "Lo siento, no pude generar una respuesta.",
        confidence: 0.95,
      };
    } catch (error) {
      console.error("🤖 [LLM] Error en OpenAI:", error);
      return {
        text: "Disculpa, estoy teniendo problemas técnicos en este momento. ¿Podrías intentarlo nuevamente?",
        confidence: 0.5,
      };
    }
  }

  supportsStreaming(): boolean {
    return true; // Ahora soportamos streaming
  }

  resetContext(sessionId: string): void {
    // No es necesario implementar nada aquí para OpenAI
    console.log(
      `🤖 [LLM] Contexto de conversación reiniciado para sesión: ${sessionId}`
    );
  }
}
