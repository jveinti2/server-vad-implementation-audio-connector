/*
 * This class provies TTS support for BotResource.
 * This is a "dummy" implementation that will need to be replaced
 * with an actual TTS engine.
 *
 * See `bot-service` in this folder for more information.
 */
import { EventEmitter } from "events";
import { TTSProvider, TTSOptions } from "./tts/tts-provider.interface";
import { AWSPollyProvider } from "./tts/aws-polly-provider";
import { OpenAITTSProvider } from "./tts/openai-tts-provider";
import { ElevenLabsProvider } from "./tts/elevenlabs-provider";

/**
 * Tipo de proveedor TTS
 */
export type TTSProviderType = "aws-polly" | "openai" | "elevenlabs";

/**
 * Servicio de síntesis de voz que utiliza un patrón adaptador
 * para soportar múltiples proveedores (AWS Polly, OpenAI, ElevenLabs, etc.)
 */
export class TTSService extends EventEmitter {
  private provider: TTSProvider;
  private readonly providers: Map<TTSProviderType, TTSProvider> = new Map();

  constructor() {
    super();

    // Inicializar los proveedores disponibles
    this.providers.set("aws-polly", new AWSPollyProvider());
    this.providers.set("openai", new OpenAITTSProvider());
    this.providers.set("elevenlabs", new ElevenLabsProvider());

    // Obtener el proveedor de las variables de entorno
    const configuredProvider = (process.env.TTS_PROVIDER ||
      "elevenlabs") as TTSProviderType;

    // Establecer el proveedor basado en la configuración
    const selectedProvider = this.providers.get(configuredProvider);
    if (!selectedProvider) {
      console.warn(
        `🔊 [TTS] Proveedor '${configuredProvider}' no disponible, usando elevenlabs`
      );
      this.provider = this.providers.get("elevenlabs")!;
    } else {
      this.provider = selectedProvider;
    }

    console.log(
      `🔊 [TTS] Servicio inicializado con proveedor '${this.getCurrentProviderType()}'`
    );

    // Configurar eventos del proveedor
    this.setupProviderEvents();
  }

  /**
   * Cambia el proveedor de síntesis de voz
   */
  setProvider(providerType: TTSProviderType): TTSService {
    const newProvider = this.providers.get(providerType);
    if (!newProvider) {
      throw new Error(`Proveedor TTS '${providerType}' no disponible`);
    }

    // Limpiar eventos del proveedor anterior
    this.provider.removeAllListeners();

    // Establecer nuevo proveedor
    this.provider = newProvider;
    console.log(`🔊 [TTS] Proveedor cambiado a '${providerType}'`);

    // Configurar eventos del nuevo proveedor
    this.setupProviderEvents();

    return this;
  }

  /**
   * Configura los eventos del proveedor actual
   */
  private setupProviderEvents(): void {
    this.provider.on("error", (error) => {
      this.emit("error", error);
    });

    this.provider.on("synthesis-start", (data) => {
      this.emit("synthesis-start", data);
    });

    this.provider.on("synthesis-complete", (data) => {
      this.emit("synthesis-complete", data);
    });
  }

  /**
   * Sintetiza texto a voz utilizando el proveedor actual
   */
  async synthesizeSpeech(
    text: string,
    options: TTSOptions = {}
  ): Promise<Uint8Array> {
    if (!text || text.trim() === "") {
      console.log("🔊 [TTS] Texto vacío, no se sintetiza");
      return new Uint8Array(0);
    }

    // Registrar proveedor utilizado
    console.log(
      `🔊 [TTS] Utilizando proveedor: ${this.getCurrentProviderType()}`
    );

    // Usar la voz apropiada según el proveedor si no se especifica
    if (!options.voiceId) {
      options.voiceId = this.getDefaultVoiceForProvider();
      console.log(`🔊 [TTS] Usando voz predeterminada: ${options.voiceId}`);
    }

    try {
      return await this.provider.synthesizeSpeech(text, options);
    } catch (error: any) {
      console.error("🔊 [TTS] Error en la síntesis de voz:", error);
      this.emit("error", error);
      throw error;
    }
  }

  /**
   * Método de conveniencia para obtener bytes de audio
   */
  getAudioBytes(
    text: string,
    providerType?: TTSProviderType
  ): Promise<Uint8Array> {
    // Cambiar temporalmente de proveedor si se especifica
    if (providerType && this.providers.has(providerType)) {
      const originalProvider = this.provider;
      this.setProvider(providerType);

      return this.synthesizeSpeech(text).finally(() => {
        // Restaurar el proveedor original
        this.provider = originalProvider;
        this.setupProviderEvents();
      });
    }

    // Usar el proveedor actual
    const defaultOptions: TTSOptions = {
      voiceId: this.getDefaultVoiceForProvider(),
      engine: "neural",
      textType: "text",
      sampleRate: "8000",
    };

    return this.synthesizeSpeech(text, defaultOptions);
  }

  /**
   * Obtiene la voz predeterminada según el proveedor
   */
  private getDefaultVoiceForProvider(): string {
    // Usar variables de entorno para voces específicas si están definidas
    if (this.provider instanceof AWSPollyProvider) {
      return process.env.AWS_POLLY_VOICE || "Mia"; // Voz en español para AWS
    }
    if (this.provider instanceof OpenAITTSProvider) {
      return process.env.OPENAI_VOICE || "nova"; // Voz en español para OpenAI
    }
    if (this.provider instanceof ElevenLabsProvider) {
      return process.env.ELEVENLABS_VOICE || "Mimi"; // Voz en español para ElevenLabs
    }
    return "default";
  }

  /**
   * Obtiene el tipo de proveedor actual
   */
  getCurrentProviderType(): TTSProviderType | "unknown" {
    if (this.provider instanceof AWSPollyProvider) return "aws-polly";
    if (this.provider instanceof OpenAITTSProvider) return "openai";
    if (this.provider instanceof ElevenLabsProvider) return "elevenlabs";
    return "unknown";
  }

  /**
   * Obtiene las métricas del proveedor actual
   */
  getMetrics(): { [key: string]: number } {
    return this.provider.getMetrics();
  }
}
