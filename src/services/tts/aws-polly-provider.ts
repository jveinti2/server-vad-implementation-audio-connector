import {
  PollyClient,
  SynthesizeSpeechCommand,
  OutputFormat,
  TextType,
  Engine,
  VoiceId,
} from "@aws-sdk/client-polly";
import * as g711 from "g711";
import {
  BaseTTSProvider,
  TTSOptions,
  TTSProviderState,
} from "./tts-provider.interface";

/**
 * Proveedor de síntesis de voz usando AWS Polly
 */
export class AWSPollyProvider extends BaseTTSProvider {
  private pollyClient: PollyClient;
  private metrics = {
    totalSynthesisTime: 0,
    bytesSynthesized: 0,
  };

  constructor() {
    super();

    // Configura el cliente de Polly con credenciales y región
    this.pollyClient = new PollyClient({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });

    console.log("🔊 [AWS Polly] Proveedor inicializado");
  }

  /**
   * Sintetiza texto a voz usando AWS Polly
   */
  async synthesizeSpeech(
    text: string,
    options: TTSOptions = {}
  ): Promise<Uint8Array> {
    try {
      // Actualizar estado
      this.state = "Processing";
      const startTime = Date.now();
      this.emitter.emit("synthesis-start", { text });

      // Configura los parámetros para la síntesis de voz
      const params = {
        Text: text,
        OutputFormat: OutputFormat.PCM, // Usa PCM que luego convertiremos a PCMU
        SampleRate: options.sampleRate || "8000", // Mismo rate que espera Genesys
        TextType: (options.textType as TextType) || TextType.TEXT,
        VoiceId: (options.voiceId as VoiceId) || VoiceId.Mia, // Voz predeterminada en español
        Engine: (options.engine as Engine) || Engine.NEURAL,
      };

      console.log(
        `🔊 [AWS Polly] Sintetizando texto: "${text.substring(0, 50)}${
          text.length > 50 ? "..." : ""
        }"`
      );

      // Ejecuta el comando para sintetizar el habla
      const command = new SynthesizeSpeechCommand(params);
      const response = await this.pollyClient.send(command);

      if (!response.AudioStream) {
        throw new Error("No se recibió flujo de audio de AWS Polly");
      }

      // Convierte PCM a PCMU (μ-law)
      const pcmBytes = await this.streamToUint8Array(response.AudioStream);
      const pcmBuffer = Buffer.from(pcmBytes);
      const muLawBuffer = Buffer.alloc(pcmBuffer.length / 2);
      for (let i = 0; i < pcmBuffer.length; i += 2) {
        const sample = pcmBuffer.readInt16LE(i);
        muLawBuffer[i / 2] = g711.ulawFromPCM(new Int16Array([sample]))[0];
      }

      // Actualizar métricas
      const endTime = Date.now();
      this.metrics.totalSynthesisTime = endTime - startTime;
      this.metrics.bytesSynthesized = muLawBuffer.length;

      console.log(
        `🔊 [AWS Polly] Síntesis completada en ${this.metrics.totalSynthesisTime}ms (${muLawBuffer.length} bytes)`
      );
      this.state = "Complete";
      this.emitter.emit("synthesis-complete", {
        duration: this.metrics.totalSynthesisTime,
        bytesSize: muLawBuffer.length,
      });

      return new Uint8Array(muLawBuffer);
    } catch (error) {
      console.error(`🔊 [AWS Polly] Error en la síntesis de voz:`, error);
      this.state = "Complete";
      this.emitter.emit("error", error);
      throw error;
    }
  }

  /**
   * Convierte un stream a Uint8Array
   */
  private async streamToUint8Array(stream: any): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve(new Uint8Array(buffer));
      });
    });
  }

  /**
   * Devuelve las métricas de rendimiento
   */
  getMetrics(): { [key: string]: number } {
    return { ...this.metrics };
  }

  /**
   * Reinicia el proveedor para una nueva síntesis
   */
  reset(): void {
    super.reset();
    this.metrics = {
      totalSynthesisTime: 0,
      bytesSynthesized: 0,
    };
  }
}
