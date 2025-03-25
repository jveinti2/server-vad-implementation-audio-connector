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
 * Proveedor de síntesis de voz usando ElevenLabs
 */
export class ElevenLabsProvider extends BaseTTSProvider {
  private apiKey: string;
  private metrics = {
    totalSynthesisTime: 0,
    bytesSynthesized: 0,
  };

  // Mapeo de nombres de voces a IDs (para compatibilidad con otros proveedores)
  private voiceMap: Record<string, string> = {
    Mimi: "YPh7OporwNAJ28F5IQrm", // Voz en español
    Antonio: "pNInz6obpgDQGcFmaJgB", // Voz en español masculina
    Rachel: "21m00Tcm4TlvDq8ikWAM", // Voz en inglés
    Bella: "EXAVITQu4vr4xnSDxMaL", // Voz en inglés
  };

  // ID de voz predeterminado para español
  private defaultVoiceId = "YPh7OporwNAJ28F5IQrm"; // Mimi

  constructor(apiKey?: string) {
    super();
    this.apiKey = apiKey || process.env.ELEVENLABS_API_KEY || "";

    if (!this.apiKey) {
      console.warn(
        "🔊 [ElevenLabs] ⚠️ ELEVENLABS_API_KEY no está configurada. La síntesis de voz fallará."
      );
    } else {
      console.log(
        "🔊 [ElevenLabs] Proveedor inicializado con API key: " +
          this.apiKey.substring(0, 5) +
          "..."
      );
    }
  }

  /**
   * Sintetiza texto a voz usando ElevenLabs
   */
  async synthesizeSpeech(
    text: string,
    options: TTSOptions = {}
  ): Promise<Uint8Array> {
    try {
      // Verificar API key
      if (!this.apiKey) {
        throw new Error("ELEVENLABS_API_KEY no está configurada");
      }

      // Actualizar estado
      this.state = "Processing";
      const startTime = Date.now();
      this.emitter.emit("synthesis-start", { text });

      // Obtener ID de voz correcto (convertir nombre a ID si es necesario)
      let voiceId = this.getVoiceId(options.voiceId);

      console.log(`🔊 [ElevenLabs] Sintetizando texto con voz ID: ${voiceId}`);
      console.log(
        `🔊 [ElevenLabs] Texto: "${text.substring(0, 50)}${
          text.length > 50 ? "..." : ""
        }"`
      );

      // IMPORTANTE: ElevenLabs no acepta "mulaw_8000" como formato, usamos "pcm_8000" que luego convertiremos
      // Los formatos aceptados son: mp3, pcm_16000, pcm_22050, pcm_24000, pcm_44100, ulaw_8000
      const outputFormat = "ulaw_8000"; // Cambio crítico: mulaw_8000 (incorrecto) -> ulaw_8000 (correcto)

      // Configuración simplificada
      const requestData = {
        text: text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.8,
        },
      };

      // Hacer solicitud a la API con el formato correcto
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`,
        requestData,
        {
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": this.apiKey,
            Accept: "audio/*", // Aceptar cualquier formato de audio
          },
          responseType: "arraybuffer",
        }
      );

      // Verificar tipo de contenido de la respuesta
      const contentType = response.headers["content-type"];
      if (contentType && contentType.includes("application/json")) {
        // Si la respuesta es JSON, probablemente sea un error
        const errorJson = JSON.parse(Buffer.from(response.data).toString());
        throw new Error(`Error de ElevenLabs: ${JSON.stringify(errorJson)}`);
      }

      // Obtener audio en formato μ-law directamente de la API
      const audioData = new Uint8Array(response.data);
      console.log(
        `🔊 [ElevenLabs] Audio μ-law recibido (${audioData.length} bytes)`
      );

      // Actualizar métricas
      const endTime = Date.now();
      this.metrics.totalSynthesisTime = endTime - startTime;
      this.metrics.bytesSynthesized = audioData.length;

      console.log(
        `🔊 [ElevenLabs] Síntesis completada en ${this.metrics.totalSynthesisTime}ms`
      );

      this.state = "Complete";
      this.emitter.emit("synthesis-complete", {
        duration: this.metrics.totalSynthesisTime,
        bytesSize: audioData.length,
      });

      return audioData;
    } catch (error: any) {
      console.error(
        "🔊 [ElevenLabs] Error en la síntesis de voz:",
        error.message
      );

      if (error.response) {
        console.error("🔊 [ElevenLabs] Detalles de respuesta:", {
          status: error.response.status,
          statusText: error.response.statusText,
        });

        // Intentar analizar el cuerpo de la respuesta si es JSON
        try {
          const errorData =
            error.response.data instanceof Buffer
              ? JSON.parse(Buffer.from(error.response.data).toString())
              : error.response.data;

          console.error(
            "🔊 [ElevenLabs] Mensaje de error de la API:",
            errorData.detail?.message ||
              errorData.detail ||
              errorData.message ||
              JSON.stringify(errorData)
          );
        } catch (parseError) {
          console.error("🔊 [ElevenLabs] Error al analizar respuesta");
        }
      }

      this.state = "Complete";
      this.emitter.emit("error", error);
      throw error;
    }
  }

  /**
   * Convierte un nombre de voz a ID, o devuelve el ID directamente
   */
  private getVoiceId(voiceIdOrName?: string): string {
    if (!voiceIdOrName) {
      return this.defaultVoiceId;
    }

    // Si el valor está en el mapa de voces, devolver el ID correspondiente
    if (this.voiceMap[voiceIdOrName]) {
      return this.voiceMap[voiceIdOrName];
    }

    // Verificar si la voz solicitada no existe en nuestro mapa
    if (!Object.keys(this.voiceMap).includes(voiceIdOrName)) {
      console.warn(
        `🔊 [ElevenLabs] ⚠️ La voz "${voiceIdOrName}" no está configurada en el mapa de voces de ElevenLabs.`
      );
      console.log(
        `🔊 [ElevenLabs] ℹ️ Voces disponibles: ${Object.keys(
          this.voiceMap
        ).join(", ")}`
      );
      console.log(`🔊 [ElevenLabs] ℹ️ Usando voz predeterminada: Mimi`);
      return this.defaultVoiceId;
    }

    // Asumir que es un ID válido si no está en el mapa
    return voiceIdOrName;
  }

  /**
   * Convierte audio usando FFmpeg (similar al enfoque de librosa en Python)
   */
  private async convertAudioFormat(
    inputPath: string,
    outputPath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const { exec } = require("child_process");

      // Convertir a WAV PCM 8kHz mono (como el resample en el código Python)
      const command = `ffmpeg -i "${inputPath}" -ar 8000 -ac 1 -acodec pcm_s16le "${outputPath}" -y`;

      exec(command, (error: any, stdout: any, stderr: any) => {
        if (error) {
          console.error("Error en FFmpeg:", stderr);
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Conversión simple para casos donde FFmpeg falla
   */
  private simpleConversion(audioData: Buffer): Uint8Array {
    // Crear un buffer de 8kB como muestra de audio
    const buffer = Buffer.alloc(8000);

    // Llenar con valores de la mitad del buffer de entrada
    const midPoint = Math.floor(audioData.length / 2);
    const segmentLength = Math.min(8000, audioData.length - midPoint);

    for (let i = 0; i < segmentLength; i++) {
      buffer[i] = audioData[midPoint + i];
    }

    return new Uint8Array(buffer);
  }

  /**
   * Convierte un buffer WAV a formato μ-law
   */
  private convertToMulaw(wavBuffer: Buffer): Uint8Array {
    try {
      // Buscar el offset del chunk 'data'
      let dataOffset = 44; // Posición predeterminada
      for (let i = 12; i < Math.min(wavBuffer.length - 8, 100); i++) {
        if (wavBuffer.slice(i, i + 4).toString() === "data") {
          dataOffset = i + 8;
          break;
        }
      }

      // Extraer los datos PCM
      const pcmData = wavBuffer.slice(dataOffset);

      // Convertir a μ-law
      const muLawBuffer = Buffer.alloc(pcmData.length / 2);
      for (let i = 0; i < pcmData.length; i += 2) {
        if (i + 1 < pcmData.length) {
          const sample = pcmData.readInt16LE(i);
          muLawBuffer[i / 2] = g711.ulawFromPCM(new Int16Array([sample]))[0];
        }
      }

      return new Uint8Array(muLawBuffer);
    } catch (error) {
      console.error("Error al convertir a μ-law:", error);
      throw error;
    }
  }

  /**
   * Limpieza de archivos temporales
   */
  private cleanupTempFiles(filePaths: string[]): void {
    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        console.error(`Error al eliminar archivo temporal ${filePath}:`, error);
      }
    }
  }

  /**
   * Obtiene métricas del proveedor
   */
  getMetrics(): { [key: string]: number } {
    return {
      totalSynthesisTime: this.metrics.totalSynthesisTime,
      bytesSynthesized: this.metrics.bytesSynthesized,
    };
  }

  /**
   * Restablece el estado
   */
  reset(): void {
    this.state = "Ready" as TTSProviderState;
    this.metrics = {
      totalSynthesisTime: 0,
      bytesSynthesized: 0,
    };
  }
}
