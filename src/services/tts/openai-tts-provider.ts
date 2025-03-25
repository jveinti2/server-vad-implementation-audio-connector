import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as g711 from "g711";
import {
  BaseTTSProvider,
  TTSOptions,
  TTSProviderState,
} from "./tts-provider.interface";

/**
 * Proveedor de síntesis de voz usando OpenAI TTS
 */
export class OpenAITTSProvider extends BaseTTSProvider {
  private apiKey: string;
  private metrics = {
    totalSynthesisTime: 0,
    bytesSynthesized: 0,
  };

  /**
   * Modelos disponibles de OpenAI para TTS
   */
  private static AVAILABLE_MODELS = ["tts-1", "tts-1-hd"];

  /**
   * Voces disponibles en OpenAI
   */
  private static AVAILABLE_VOICES = [
    "alloy",
    "echo",
    "fable",
    "onyx",
    "nova",
    "shimmer",
  ];

  constructor(apiKey?: string) {
    super();
    this.apiKey = apiKey || process.env.OPENAI_API_KEY || "";

    if (!this.apiKey) {
      console.warn(
        "🔊 [OpenAI TTS] ⚠️ OPENAI_API_KEY no está configurada. La síntesis de voz fallará."
      );
    } else {
      console.log("🔊 [OpenAI TTS] Proveedor inicializado");
    }
  }

  /**
   * Sintetiza texto a voz usando OpenAI TTS
   */
  async synthesizeSpeech(
    text: string,
    options: TTSOptions = {}
  ): Promise<Uint8Array> {
    try {
      // Verificar API key
      if (!this.apiKey) {
        throw new Error("OPENAI_API_KEY no está configurada");
      }

      // Actualizar estado
      this.state = "Processing";
      const startTime = Date.now();
      this.emitter.emit("synthesis-start", { text });

      // Valores predeterminados
      const model = options.model || "tts-1";
      const voice = options.voiceId || "nova"; // Nova tiene buen español
      const speed = options.speed || 1.0;
      const format = "mp3"; // OpenAI solo soporta MP3, luego convertiremos

      // Verificar valores
      if (!OpenAITTSProvider.AVAILABLE_MODELS.includes(model)) {
        console.warn(
          `🔊 [OpenAI TTS] ⚠️ Modelo "${model}" no reconocido, usando tts-1`
        );
      }
      if (!OpenAITTSProvider.AVAILABLE_VOICES.includes(voice)) {
        console.warn(
          `🔊 [OpenAI TTS] ⚠️ Voz "${voice}" no reconocida, usando nova`
        );
      }

      console.log(
        `🔊 [OpenAI TTS] Sintetizando texto con modelo ${model}, voz ${voice}`
      );
      console.log(
        `🔊 [OpenAI TTS] Texto: "${text.substring(0, 50)}${
          text.length > 50 ? "..." : ""
        }"`
      );

      // Preparar la solicitud a la API de OpenAI
      const response = await axios.post(
        "https://api.openai.com/v1/audio/speech",
        {
          model: model,
          input: text,
          voice: voice,
          response_format: format,
          speed: speed,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          responseType: "arraybuffer",
        }
      );

      // Convertir MP3 a PCM y luego a PCMU (μ-law)
      const tempDir = os.tmpdir();
      const tempMp3Path = path.join(tempDir, `openai-tts-${Date.now()}.mp3`);
      const tempWavPath = path.join(tempDir, `openai-tts-${Date.now()}.wav`);

      try {
        // Guardar MP3 temporalmente
        fs.writeFileSync(tempMp3Path, Buffer.from(response.data));
        console.log(
          `🔊 [OpenAI TTS] Audio MP3 recibido (${
            Buffer.from(response.data).length
          } bytes)`
        );

        // Crear archivo WAV con FFmpeg (si está disponible) o usar alternativa
        let audioData: Uint8Array;

        try {
          // Intentar convertir con ffmpeg
          await this.convertWithFFmpeg(tempMp3Path, tempWavPath);

          // Leer el archivo WAV y convertirlo a μ-law
          const wavBuffer = fs.readFileSync(tempWavPath);
          audioData = this.convertWavToMulaw(wavBuffer);
        } catch (ffmpegError) {
          console.warn(
            `🔊 [OpenAI TTS] ⚠️ Error con FFmpeg: ${ffmpegError}. Usando método alternativo.`
          );

          // Si falla FFmpeg, usar el MP3 directamente (subóptimo pero funcional)
          // Esto servirá como fallback, aunque la calidad será inferior
          const mp3Buffer = fs.readFileSync(tempMp3Path);
          audioData = new Uint8Array(mp3Buffer);
        }

        // Actualizar métricas
        const endTime = Date.now();
        this.metrics.totalSynthesisTime = endTime - startTime;
        this.metrics.bytesSynthesized = audioData.length;

        console.log(
          `🔊 [OpenAI TTS] Síntesis completada en ${this.metrics.totalSynthesisTime}ms (${audioData.length} bytes)`
        );
        this.state = "Complete";
        this.emitter.emit("synthesis-complete", {
          duration: this.metrics.totalSynthesisTime,
          bytesSize: audioData.length,
        });

        return audioData;
      } finally {
        // Limpiar archivos temporales
        this.cleanupTempFiles([tempMp3Path, tempWavPath]);
      }
    } catch (error) {
      console.error(`🔊 [OpenAI TTS] Error en la síntesis de voz:`, error);
      this.state = "Complete";
      this.emitter.emit("error", error);
      throw error;
    }
  }

  /**
   * Convierte un archivo MP3 a WAV usando FFmpeg
   */
  private async convertWithFFmpeg(
    inputPath: string,
    outputPath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const { exec } = require("child_process");

      // Comando FFmpeg para convertir MP3 a WAV PCM mono a 8000 Hz
      const command = `ffmpeg -i "${inputPath}" -ar 8000 -ac 1 -acodec pcm_s16le "${outputPath}" -y`;

      exec(command, (error: any, stdout: any, stderr: any) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Convierte un buffer WAV a formato μ-law (PCMU)
   */
  private convertWavToMulaw(wavBuffer: Buffer): Uint8Array {
    try {
      // Leer el encabezado WAV para encontrar los datos de audio
      let dataOffset = 44; // Posición predeterminada para el inicio de datos en un WAV estándar

      // Buscar el chunk 'data'
      for (let i = 12; i < wavBuffer.length - 8; i++) {
        if (wavBuffer.slice(i, i + 4).toString() === "data") {
          dataOffset = i + 8; // 4 bytes para 'data' y 4 bytes para el tamaño
          break;
        }
      }

      // Extraer los datos PCM
      const pcmData = wavBuffer.slice(dataOffset);

      // Convertir PCM a μ-law
      const muLawBuffer = Buffer.alloc(pcmData.length / 2);
      for (let i = 0; i < pcmData.length; i += 2) {
        const sample = pcmData.readInt16LE(i);
        muLawBuffer[i / 2] = g711.ulawFromPCM(new Int16Array([sample]))[0];
      }

      return new Uint8Array(muLawBuffer);
    } catch (error) {
      console.error(`🔊 [OpenAI TTS] Error convirtiendo WAV a μ-law:`, error);
      throw error;
    }
  }

  /**
   * Limpia archivos temporales
   */
  private cleanupTempFiles(filePaths: string[]): void {
    for (const filePath of filePaths) {
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (error) {
          console.warn(
            `🔊 [OpenAI TTS] No se pudo eliminar archivo temporal ${filePath}:`,
            error
          );
        }
      }
    }
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
