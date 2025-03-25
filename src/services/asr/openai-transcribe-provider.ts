import {
  BaseTranscribeProvider,
  Transcript,
  TranscribeProviderState,
} from "./transcribe-provider.interface";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import FormData from "form-data";

/**
 * Implementación del proveedor de transcripción usando OpenAI Whisper a través de la API
 */
export class OpenAITranscribeProvider extends BaseTranscribeProvider {
  private apiKey: string;
  private audioBuffer: Buffer[] = [];
  private accumulatedText = "";
  private isProcessing = false;
  private lastTranscriptUpdateTime = Date.now();
  private processingStartTime = 0;
  private firstAudioReceivedTime = 0;
  private readonly INACTIVITY_TIMEOUT_MS = 1500; // 1.5 segundos sin cambios
  private readonly MAX_BUFFER_SIZE = 3 * 1024 * 1024; // 3MB máximo para API de Whisper
  private inactivityCheckIntervalId: NodeJS.Timeout | null = null;
  private maxDurationTimeoutId: NodeJS.Timeout | null = null;
  private readonly MAX_DURATION_MS = 15000; // 15 segundos máximo
  private hasSentFinalTranscript = false;

  // Métricas
  private metrics = {
    audioToFirstTranscription: 0,
    totalProcessingTime: 0,
  };

  constructor(apiKey?: string) {
    super();
    this.apiKey = apiKey || process.env.OPENAI_API_KEY || "";
    this.startInactivityCheck();
  }

  /**
   * Inicia el verificador de inactividad
   */
  private startInactivityCheck(): void {
    // Limpiar timers previos
    this.stopInactivityCheck();

    // Configurar timeout máximo
    this.maxDurationTimeoutId = setTimeout(() => {
      if (this.isState("Processing") && this.audioBuffer.length > 0) {
        console.log(
          `🎤 [OpenAI] ⏱️ Tiempo máximo alcanzado (${
            this.MAX_DURATION_MS / 1000
          }s) - Finalizando transcripción`
        );
        this.finishTranscription();
      }
    }, this.MAX_DURATION_MS);

    // Configurar verificador de inactividad
    this.inactivityCheckIntervalId = setInterval(() => {
      if (this.isState("Processing") && !this.isProcessing) {
        const timeSinceLastUpdate = Date.now() - this.lastTranscriptUpdateTime;

        // Solo mostrar log cada segundo para no saturar
        if (timeSinceLastUpdate > 1000 && timeSinceLastUpdate % 1000 < 250) {
          console.log(
            `🎤 [OpenAI] ⏱️ ${
              Math.round(timeSinceLastUpdate / 100) / 10
            }s sin cambios (umbral: ${this.INACTIVITY_TIMEOUT_MS / 1000}s)`
          );
        }

        if (timeSinceLastUpdate > this.INACTIVITY_TIMEOUT_MS) {
          console.log(
            `🎤 [OpenAI] ⏱️ Inactividad detectada tras ${
              this.INACTIVITY_TIMEOUT_MS / 1000
            }s - Finalizando transcripción`
          );
          this.finishTranscription();
        }
      }
    }, 250);
  }

  /**
   * Detiene el verificador de inactividad
   */
  private stopInactivityCheck(): void {
    if (this.inactivityCheckIntervalId) {
      clearInterval(this.inactivityCheckIntervalId);
      this.inactivityCheckIntervalId = null;
    }

    if (this.maxDurationTimeoutId) {
      clearTimeout(this.maxDurationTimeoutId);
      this.maxDurationTimeoutId = null;
    }
  }

  /**
   * Reinicia el proveedor para un nuevo turno
   */
  reset(): void {
    super.reset();
    this.audioBuffer = [];
    this.accumulatedText = "";
    this.isProcessing = false;
    this.lastTranscriptUpdateTime = Date.now();
    this.processingStartTime = 0;
    this.firstAudioReceivedTime = 0;
    this.hasSentFinalTranscript = false;
    this.metrics = {
      audioToFirstTranscription: 0,
      totalProcessingTime: 0,
    };

    // Reiniciar verificador de inactividad
    this.startInactivityCheck();
  }

  /**
   * Obtiene las métricas de rendimiento
   */
  getMetrics(): {
    audioToFirstTranscription: number;
    totalProcessingTime: number;
  } {
    return { ...this.metrics };
  }

  /**
   * Procesa un chunk de audio
   */
  processAudio(data: Uint8Array): void {
    if (this.isState("Complete")) {
      return;
    }

    // Verificar si hay datos de audio válidos
    if (!data || data.length === 0) {
      console.log(`🎤 [OpenAI] ⚠️ Recibido chunk de audio vacío`);
      return;
    }

    // Comprobar si hay actividad de audio
    const hasAudioActivity = this.checkAudioActivity(data);
    if (hasAudioActivity) {
      console.log(`🎤 [OpenAI] 🎙️ Actividad de audio detectada`);
    }

    // Registrar tiempo del primer audio
    if (this.firstAudioReceivedTime === 0) {
      this.firstAudioReceivedTime = Date.now();
      console.log(`🎤 [OpenAI] 🎙️ Primer audio recibido: ${data.length} bytes`);
    }

    // Inicializar estado si es necesario
    if (this.state === "None") {
      this.state = "Processing";
      this.processingStartTime = Date.now();
      this.lastTranscriptUpdateTime = Date.now();
      console.log(`🎤 [OpenAI] 🎙️ Iniciando procesamiento de transcripción`);
    }

    // Almacenar el audio
    const audioChunk = Buffer.from(data);
    this.audioBuffer.push(audioChunk);

    // Verificar si tenemos suficiente audio para procesar
    const totalBufferSize = this.audioBuffer.reduce(
      (sum, chunk) => sum + chunk.length,
      0
    );

    // Log del tamaño del buffer
    console.log(
      `🎤 [OpenAI] 🎙️ Buffer: ${Math.round(
        totalBufferSize / 1024
      )}KB / 16KB necesarios`
    );

    // Si el buffer está lleno o ya pasó tiempo suficiente, procesamos
    // Reducimos el umbral a 16KB para ser más responsive
    if (totalBufferSize >= 16000 && !this.isProcessing) {
      // ~1 segundo de audio
      console.log(
        `🎤 [OpenAI] 🎙️ Buffer lleno (${totalBufferSize} bytes), procesando audio`
      );
      this.processPendingAudio();
    }

    // Si ha pasado mucho tiempo desde la última actualización, forzar procesamiento
    const timeSinceLastUpdate = Date.now() - this.lastTranscriptUpdateTime;
    if (
      timeSinceLastUpdate > 3000 &&
      totalBufferSize > 8000 &&
      !this.isProcessing
    ) {
      console.log(
        `🎤 [OpenAI] 🎙️ Procesando audio por timeout (${timeSinceLastUpdate}ms sin procesar)`
      );
      this.processPendingAudio();
    }
  }

  /**
   * Verifica si hay actividad de audio en los datos
   */
  private checkAudioActivity(data: Uint8Array): boolean {
    // Calcular energía del audio (método simple)
    let sum = 0;
    const threshold = 128; // Valor medio para μ-law (0-255)
    const activityThreshold = 10; // Ajustar según sea necesario

    // Muestrear el audio (no procesar todos los bytes para eficiencia)
    const sampleSize = Math.min(100, data.length);
    const step = Math.max(1, Math.floor(data.length / sampleSize));

    for (let i = 0; i < data.length; i += step) {
      const sample = data[i];
      const diff = Math.abs(sample - threshold);
      sum += diff;
    }

    const avgEnergy = sum / sampleSize;
    return avgEnergy > activityThreshold;
  }

  /**
   * Procesa el audio acumulado hasta el momento mediante la API de OpenAI
   */
  private async processPendingAudio(): Promise<void> {
    if (
      this.isProcessing ||
      this.audioBuffer.length === 0 ||
      this.isState("Complete")
    ) {
      return;
    }

    this.isProcessing = true;

    try {
      // Combinar todo el audio en un solo buffer
      const combinedBuffer = Buffer.concat(this.audioBuffer);

      // Verificar si excedemos el tamaño máximo
      if (combinedBuffer.length > this.MAX_BUFFER_SIZE) {
        console.log(
          `🎤 [OpenAI] ⚠️ Buffer de audio demasiado grande (${Math.round(
            combinedBuffer.length / 1024
          )}KB), truncando`
        );
        // Solo usamos los últimos MAX_BUFFER_SIZE bytes
        const truncatedBuffer = combinedBuffer.slice(
          combinedBuffer.length - this.MAX_BUFFER_SIZE
        );
        await this.transcribeAudio(truncatedBuffer);
      } else {
        await this.transcribeAudio(combinedBuffer);
      }
    } catch (error) {
      console.error(`🎤 [OpenAI] ❌ Error procesando audio: ${error}`);
      this.emitter.emit("error", error);
    } finally {
      this.isProcessing = false;

      // Si ya completamos, emitir resultado final
      if (this.isState("Complete") && !this.hasSentFinalTranscript) {
        this.emitFinalTranscript();
      }
    }
  }

  /**
   * Envía el audio a OpenAI para transcripción
   */
  private async transcribeAudio(audioBuffer: Buffer): Promise<void> {
    console.log(
      `🎤 [OpenAI] 🔄 Enviando ${Math.round(
        audioBuffer.length / 1024
      )}KB para transcripción`
    );

    try {
      // Crear un archivo temporal para el audio
      const tempFilePath = path.join(
        os.tmpdir(),
        `whisper-audio-${Date.now()}.wav`
      );

      try {
        // Escribir el buffer al archivo temporal
        fs.writeFileSync(tempFilePath, audioBuffer);

        // Crear formdata para la solicitud
        const formData = new FormData();
        formData.append("file", fs.createReadStream(tempFilePath), {
          filename: "audio.wav",
          contentType: "audio/wav",
        });
        formData.append("model", "whisper-1");
        formData.append("language", "es");

        // Obtener headers incluido el boundary
        const formHeaders = formData.getHeaders();

        // Realizar la petición a la API
        console.log(`🎤 [OpenAI] 🔄 Enviando solicitud a Whisper API`);

        const response = await fetch(
          "https://api.openai.com/v1/audio/transcriptions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              ...formHeaders,
            },
            body: formData as any, // Cast para compatibilidad con fetch
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Error en API de OpenAI: ${response.status} ${response.statusText} - ${errorText}`
          );
        }

        const data = (await response.json()) as { text?: string };

        if (data.text) {
          // Actualizar timestamp para inactividad
          this.lastTranscriptUpdateTime = Date.now();

          // Registrar tiempo hasta primera transcripción
          if (this.metrics.audioToFirstTranscription === 0) {
            this.metrics.audioToFirstTranscription =
              Date.now() - this.firstAudioReceivedTime;
            console.log(
              `🎤 [OpenAI] 🎙️ Primera transcripción en: ${this.metrics.audioToFirstTranscription}ms`
            );
          }

          console.log(`🎤 [OpenAI] 📝 Texto: "${data.text}"`);

          // Acumular texto (OpenAI ya hace un buen trabajo combinando)
          if (this.accumulatedText.length === 0) {
            this.accumulatedText = data.text;
          } else {
            // Inteligentemente combinar con el texto previo
            this.accumulatedText = this.smartCombineText(
              this.accumulatedText,
              data.text
            );
          }

          // Emitir transcripción parcial
          this.emitter.emit("partial-transcript", {
            text: this.accumulatedText,
            confidence: 0.9, // OpenAI no proporciona confianza, asumimos alta
          });
        }
      } finally {
        // Limpiar archivo temporal
        try {
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
          }
        } catch (unlinkError) {
          console.error(
            `🎤 [OpenAI] ⚠️ Error eliminando archivo temporal: ${unlinkError}`
          );
        }
      }
    } catch (error) {
      console.error(`🎤 [OpenAI] ❌ Error en transcripción: ${error}`);
      this.emitter.emit("error", error);
    }
  }

  /**
   * Combina texto de forma inteligente evitando duplicaciones
   */
  private smartCombineText(existingText: string, newText: string): string {
    // Normaliza los textos
    const normalizedExisting = existingText.toLowerCase().trim();
    const normalizedNew = newText.toLowerCase().trim();

    // Si el nuevo texto está contenido completamente en el existente, mantener el existente
    if (normalizedExisting.includes(normalizedNew)) {
      return existingText;
    }

    // Si el existente está contenido en el nuevo, usar el nuevo
    if (normalizedNew.includes(normalizedExisting)) {
      return newText;
    }

    // Buscar el mejor punto de solapamiento
    let bestOverlap = 0;
    let bestPosition = 0;

    // Intentar encontrar solapamiento al final del existente e inicio del nuevo
    const maxOverlapLength = Math.min(
      normalizedExisting.length,
      normalizedNew.length
    );

    for (let i = 1; i <= maxOverlapLength; i++) {
      const endOfExisting = normalizedExisting.substring(
        normalizedExisting.length - i
      );
      const startOfNew = normalizedNew.substring(0, i);

      if (endOfExisting === startOfNew && i > bestOverlap) {
        bestOverlap = i;
        bestPosition = i;
      }
    }

    // Si hay buen solapamiento, combinar cuidadosamente
    if (bestOverlap > 5) {
      // Un mínimo de 5 caracteres para considerar buen solapamiento
      return existingText + newText.substring(bestPosition);
    }

    // Si no hay buen solapamiento, simplemente concatenar con espacio
    return existingText + " " + newText;
  }

  /**
   * Finaliza la transcripción
   */
  finishTranscription(): void {
    if (this.isState("Complete")) {
      return;
    }

    console.log(`🎤 [OpenAI] 🔄 Finalizando transcripción`);
    this.state = "Complete";

    // Calcular tiempo total de procesamiento
    if (this.processingStartTime > 0) {
      this.metrics.totalProcessingTime = Date.now() - this.processingStartTime;
    }

    // Detener verificadores
    this.stopInactivityCheck();

    // Si hay audio pendiente de procesar, hacerlo antes de finalizar
    if (this.audioBuffer.length > 0 && !this.isProcessing) {
      this.processPendingAudio();
    } else if (!this.isProcessing) {
      // Si no hay procesamiento pendiente, emitir final
      this.emitFinalTranscript();
    }
    // Si hay procesamiento en curso, se emitirá el final cuando termine
  }

  /**
   * Emite la transcripción final
   */
  private emitFinalTranscript(): void {
    if (this.hasSentFinalTranscript) {
      return;
    }

    this.hasSentFinalTranscript = true;

    // Mostrar métricas
    this.logMetrics();

    // Si no tenemos texto acumulado, emitir vacío
    if (this.accumulatedText.length === 0) {
      console.log(`🎤 [OpenAI] 🔇 Sin texto final (silencio o error)`);
      this.emitter.emit("final-transcript", {
        text: "",
        confidence: 0,
      });
      return;
    }

    // Emitir transcripción final
    console.log(`🎤 [OpenAI] ✅ FINAL: "${this.accumulatedText}"`);
    console.log(`🎤 [OpenAI] 🤖 Turno del bot para responder`);

    this.emitter.emit("final-transcript", {
      text: this.accumulatedText,
      confidence: 0.9, // OpenAI no proporciona confianza, asumimos alta
    });
  }

  /**
   * Muestra las métricas de rendimiento
   */
  private logMetrics(): void {
    if (this.metrics.audioToFirstTranscription > 0) {
      console.log(
        `🎤 [OpenAI] 📊 Tiempo hasta primera transcripción: ${this.metrics.audioToFirstTranscription}ms`
      );
    }
    if (this.metrics.totalProcessingTime > 0) {
      console.log(
        `🎤 [OpenAI] 📊 Tiempo total de procesamiento: ${this.metrics.totalProcessingTime}ms`
      );
    }
  }
}
