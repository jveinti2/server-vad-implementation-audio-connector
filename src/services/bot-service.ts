import { JsonStringMap } from "../protocol/core";
import { BotTurnDisposition } from "../protocol/voice-bots";
import { TTSService, TTSProviderType } from "./tts-service";
import { TTSOptions } from "./tts/tts-provider.interface";
import {
  LLMProvider,
  ConversationContext,
  LLMResponse,
} from "./llm/llm-provider.interface";
import { OpenAIProvider } from "./llm/openai-provider";

/*
 * This class provides support for retreiving a Bot Resource based on the supplied
 * connection URL and input variables.
 *
 * For the purposes of this example, we are just returning a "dummy" resource, and
 * a real implemetation will need to be provided.
 */
export class BotService {
  private ttsService = new TTSService();
  private llmProvider: LLMProvider;
  private conversations: Map<string, ConversationContext> = new Map();

  constructor() {
    // Inicializar LLM usando variable de entorno o OpenAI por defecto
    const llmProvider = process.env.LLM_PROVIDER || "openai";

    if (llmProvider === "openai") {
      this.llmProvider = new OpenAIProvider(process.env.OPENAI_API_KEY || "");
      console.log(`🤖 [BOT] Usando LLM: OpenAI`);
    } else {
      // Por ahora solo soportamos OpenAI, pero esto permite extensión futura
      this.llmProvider = new OpenAIProvider(process.env.OPENAI_API_KEY || "");
      console.log(
        `🤖 [BOT] LLM solicitado "${llmProvider}" no disponible, usando OpenAI`
      );
    }

    // Validar que el TTS está usando el proveedor correcto (no necesitamos configurarlo de nuevo)
    const configuredTTSProvider = process.env.TTS_PROVIDER || "elevenlabs";
    const currentTTSProvider = this.ttsService.getCurrentProviderType();

    // Solo informar el proveedor TTS actual
    console.log(`🤖 [BOT] Usando proveedor TTS: ${currentTTSProvider}`);
  }

  // Método para cambiar de proveedor LLM
  setLLMProvider(provider: LLMProvider) {
    this.llmProvider = provider;
    console.log(
      `🤖 [BOT] Proveedor LLM actualizado: ${provider.constructor.name}`
    );
  }

  // Método para obtener el proveedor LLM actual
  getLLMProvider(): LLMProvider {
    return this.llmProvider;
  }

  /**
   * Obtiene o crea un contexto de conversación para la sesión
   */
  private getConversationContext(sessionId: string): ConversationContext {
    if (!this.conversations.has(sessionId)) {
      console.log(
        `🤖 [BOT] Creando nuevo contexto de conversación para sesión: ${sessionId}`
      );
      this.conversations.set(sessionId, {
        sessionId,
        messages: [],
      });
    }
    return this.conversations.get(sessionId)!;
  }

  /**
   * Método principal para obtener respuesta del bot
   */
  async getBotResponse(
    input: string,
    sessionId: string = "default"
  ): Promise<BotResponse> {
    console.log(
      `🤖 [BOT] Procesando entrada del usuario: "${input.substring(0, 50)}${
        input.length > 50 ? "..." : ""
      }"`
    );

    try {
      // Obtener contexto de conversación
      const context = this.getConversationContext(sessionId);

      // Agregar mensaje del usuario al contexto
      context.messages.push({ role: "user", content: input });

      // Limitar el historial de conversación (opcional)
      if (context.messages.length > 10) {
        context.messages = context.messages.slice(-10);
      }

      // Generar respuesta usando el proveedor LLM
      console.log(
        `🤖 [BOT] Generando respuesta con ${this.llmProvider.constructor.name}...`
      );
      const llmResponse = await this.llmProvider.generateResponse(
        input,
        context
      );

      // Agregar respuesta del bot al contexto
      context.messages.push({ role: "assistant", content: llmResponse.text });
      console.log(
        `🤖 [BOT] Respuesta generada: "${llmResponse.text.substring(0, 50)}${
          llmResponse.text.length > 50 ? "..." : ""
        }"`
      );

      // Generar audio para la respuesta
      console.log(
        `🤖 [BOT] Generando audio para respuesta con ${this.ttsService.getCurrentProviderType()}...`
      );
      try {
        const startTime = Date.now();
        const audioBytes = await this.ttsService.getAudioBytes(
          llmResponse.text
        );
        const duration = Date.now() - startTime;
        console.log(
          `🤖 [BOT] Audio generado: ${audioBytes.length} bytes en ${duration}ms`
        );

        return new BotResponse("match", llmResponse.text)
          .withConfidence(llmResponse.confidence)
          .withAudioBytes(audioBytes)
          .withEndSession(false);
      } catch (audioError) {
        console.error("🤖 [BOT] Error al generar audio:", audioError);

        // Intentar de nuevo con un proveedor alternativo
        console.log("🤖 [BOT] Intentando con proveedor TTS alternativo...");
        try {
          // Intentar con AWS Polly si estamos usando otro
          const alternativeProvider =
            this.ttsService.getCurrentProviderType() === "aws-polly"
              ? "openai"
              : "aws-polly";

          const audioBytes = await this.ttsService.getAudioBytes(
            llmResponse.text,
            alternativeProvider as TTSProviderType
          );
          console.log(
            `🤖 [BOT] Audio generado con proveedor alternativo: ${audioBytes.length} bytes`
          );

          return new BotResponse("match", llmResponse.text)
            .withConfidence(llmResponse.confidence)
            .withAudioBytes(audioBytes)
            .withEndSession(false);
        } catch (fallbackError) {
          console.error(
            "🤖 [BOT] Error al generar audio con proveedor alternativo:",
            fallbackError
          );

          // Devolver respuesta sin audio
          return new BotResponse("match", llmResponse.text)
            .withConfidence(llmResponse.confidence)
            .withEndSession(false);
        }
      }
    } catch (error) {
      console.error("🤖 [BOT] Error al generar respuesta:", error);

      // Respuesta de fallback
      const fallbackText =
        "Disculpa, estoy teniendo dificultades técnicas. ¿Podrías intentarlo de nuevo?";

      try {
        const audioBytes = await this.ttsService.getAudioBytes(fallbackText);
        return new BotResponse("no_match", fallbackText)
          .withConfidence(0.5)
          .withAudioBytes(audioBytes)
          .withEndSession(false);
      } catch (audioError) {
        console.error(
          "🤖 [BOT] Error al generar audio de fallback:",
          audioError
        );
        return new BotResponse("no_match", fallbackText)
          .withConfidence(0.5)
          .withEndSession(false);
      }
    }
  }

  /**
   * Método para reiniciar el contexto de una sesión
   */
  resetConversation(sessionId: string): void {
    if (this.conversations.has(sessionId)) {
      this.conversations.delete(sessionId);
      this.llmProvider.resetContext(sessionId);
      console.log(`🤖 [BOT] Conversación reiniciada para sesión: ${sessionId}`);
    }
  }

  /**
   * Método para obtener un recurso de bot
   */
  getBotIfExists(
    connectionUrl: string,
    inputVariables: JsonStringMap
  ): Promise<BotResource | null> {
    return Promise.resolve(new BotResource(this));
  }

  /**
   * Configura el proveedor de TTS que se utilizará
   */
  setTTSProvider(providerType: TTSProviderType): void {
    this.ttsService.setProvider(providerType);
    console.log(`🤖 [BotService] Proveedor TTS cambiado a: '${providerType}'`);
  }

  /**
   * Obtiene el proveedor TTS actual
   */
  getCurrentTTSProvider(): TTSProviderType | "unknown" {
    return this.ttsService.getCurrentProviderType();
  }

  /**
   * Obtiene una respuesta del sistema con el texto y audio especificados
   */
  getSystemResponse(
    text: string,
    ttsProvider?: TTSProviderType
  ): Promise<BotResponse> {
    return (
      ttsProvider
        ? this.ttsService.getAudioBytes(text, ttsProvider)
        : this.ttsService.getAudioBytes(text)
    )
      .then((audioBytes) => {
        return new BotResponse("match" as BotTurnDisposition, text)
          .withConfidence(1.0)
          .withAudioBytes(audioBytes);
      })
      .catch((error) => {
        console.error(`🤖 [BotService] Error en TTS:`, error);
        return new BotResponse(
          "match" as BotTurnDisposition,
          text
        ).withConfidence(1.0);
      });
  }

  getTTSService(): TTSService {
    return this.ttsService;
  }
}

/*
 * This class provides support for the various methods needed to interact with an Bot.
 */
export class BotResource {
  private botService: BotService;

  constructor(botService: BotService) {
    this.botService = botService;
  }

  /**
   * Método para obtener la respuesta inicial del bot
   */
  async getInitialResponse(): Promise<BotResponse> {
    const message =
      "¡Hola! Mi nombre es Mia, soy tu asistente virtual. ¿En qué puedo ayudarte hoy?";

    const audioBytes = await this.botService
      .getTTSService()
      .getAudioBytes(message);
    return new BotResponse("match", message)
      .withConfidence(1.0)
      .withAudioBytes(audioBytes);
  }

  /**
   * Método para obtener respuesta del bot en base a la entrada del usuario
   */
  getBotResponse(
    input: string,
    sessionId: string = "default"
  ): Promise<BotResponse> {
    return this.botService.getBotResponse(input, sessionId);
  }
}

export class BotResponse {
  disposition: BotTurnDisposition;
  text: string;
  confidence?: number;
  audioBytes?: Uint8Array;
  endSession?: boolean;

  constructor(disposition: BotTurnDisposition, text: string) {
    this.disposition = disposition;
    this.text = text;
  }

  withConfidence(confidence: number): BotResponse {
    this.confidence = confidence;
    return this;
  }

  withAudioBytes(audioBytes: Uint8Array): BotResponse {
    this.audioBytes = audioBytes;
    return this;
  }

  withEndSession(endSession: boolean): BotResponse {
    this.endSession = endSession;
    return this;
  }
}
